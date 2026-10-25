"use strict";

/**
 * Incremental per-file cache regression tests.
 *
 * The invariant that matters: an incremental rescan (only changed files
 * re-parsed) must produce EXACTLY the same records as a fresh full scan of
 * the same tree — including cross-file dedup, quota selection and cost.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const kimiCode = require("../src/providers/kimi-code");
const codex = require("../src/providers/codex");
const dsh = require("../src/providers/dsh");

function tmpHome(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Push fixture files' mtime 10s into the past so the scan's racy-write
 *  guard (files modified within 2s of "now" are always re-read) does not
 *  fire on freshly written fixtures. One shared timestamp per call keeps
 *  the (mtime, path) order deterministic: callers pass the parent first,
 *  the fork copy second, so the parent wins dedup by path order. */
function backdate(...files) {
  const old = new Date(Date.now() - 10_000);
  for (const file of files) fs.utimesSync(file, old, old);
}

/** Comparable projection of a record list (ignores object identity and the
 *  session attribution of deduped twins: with mtime-ordered first-wins the
 *  surviving copy of a duplicated line may be the parent's on one path and
 *  the fork's on the other — same tokens, same cost, different session). */
function project(records) {
  return records
    .map((r) => ({
      tool: r.tool,
      time: r.time,
      model: r.model,
      inputOther: r.inputOther,
      output: r.output,
      inputCacheRead: r.inputCacheRead,
      inputCacheCreation: r.inputCacheCreation,
      costCny: r.costCny,
    }))
    .sort((a, b) => b.time - a.time || (a.model < b.model ? -1 : 1));
}

// ---------------------------------------------------------------------------
// kimi-code
// ---------------------------------------------------------------------------

test("kimi-code: appending to one file — incremental scan equals fresh full scan", () => {
  const home = tmpHome("kimi-incr-");
  const main = path.join(home, "sessions", "wd_p", "session_a", "agents", "main");
  const fork = path.join(home, "sessions", "wd_p", "session_b", "agents", "main");
  fs.mkdirSync(main, { recursive: true });
  fs.mkdirSync(fork, { recursive: true });

  const usageLine = (time, input) =>
    JSON.stringify({
      type: "usage.record",
      usageScope: "turn",
      model: "kimi-k2.6",
      time,
      usage: { inputOther: input, output: 1, inputCacheRead: 0, inputCacheCreation: 0 },
    });

  fs.writeFileSync(path.join(main, "wire.jsonl"), [usageLine(1000, 10), usageLine(2000, 20)].join("\n") + "\n");
  // fork copies parent's lines verbatim
  fs.writeFileSync(path.join(fork, "wire.jsonl"), [usageLine(1000, 10), usageLine(3000, 30)].join("\n") + "\n");
  backdate(path.join(main, "wire.jsonl"), path.join(fork, "wire.jsonl"));

  const first = kimiCode.scan(home);
  assert.strictEqual(first.records.length, 3, "2 unique turns in A + 1 unique in B");
  assert.strictEqual(first.meta.filesReread, 2, "first scan reads everything");
  assert.strictEqual(first.meta.duplicatesSkipped, 1, "forked copy of turn 1000 dropped");

  // Second scan, nothing changed: nothing is re-read.
  const second = kimiCode.scan(home);
  assert.strictEqual(second.meta.filesReread, 0, "unchanged files come from cache");
  assert.deepStrictEqual(project(second.records), project(first.records));

  // Append a new turn to file A, then rescan incrementally.
  fs.appendFileSync(path.join(main, "wire.jsonl"), usageLine(4000, 40) + "\n");
  backdate(path.join(main, "wire.jsonl"));
  const incr = kimiCode.scan(home);
  assert.strictEqual(incr.meta.filesReread, 1, "only the appended file is re-parsed");
  assert.strictEqual(incr.records.length, 4);
  // The forked copy stays deduped even though file B was NOT re-derived
  // this scan (its cached contribution is reused as-is).
  assert.strictEqual(
    incr.records.filter((r) => r.time === 1000).map((r) => r.session).join(","),
    "session_a",
    "cross-file fork dedup still holds");

  // Ground truth: drop the cache and rescan everything fresh.
  kimiCode.clearCache();
  const full = kimiCode.scan(home);
  assert.deepStrictEqual(project(incr.records), project(full.records),
    "incremental result must equal a fresh full scan");

  fs.rmSync(home, { recursive: true, force: true });
});

test("kimi-code: tool.call events use the event's own time, never the file mtime", () => {
  const home = tmpHome("kimi-ev-");
  const dir = path.join(home, "sessions", "wd_p", "session_a", "agents", "main");
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    // envelope time present
    JSON.stringify({ type: "context.append_loop_event", time: 12345,
      event: { type: "tool.call", name: "WebSearch" } }),
    // no envelope time, no inner time → time 0 (not attributable to a range)
    JSON.stringify({ type: "context.append_loop_event",
      event: { type: "tool.call", name: "FetchURL" } }),
  ];
  // Old mtime so an mtime fallback would produce a wildly different value.
  const old = new Date(Date.now() - 90 * 24 * 3600 * 1000);
  const wire = path.join(dir, "wire.jsonl");
  fs.writeFileSync(wire, lines.join("\n") + "\n");
  fs.utimesSync(wire, old, old);

  const out = kimiCode.scan(home);
  assert.strictEqual(out.events.length, 2);
  assert.strictEqual(out.events[0].eventName, "WebSearch");
  assert.strictEqual(out.events[0].time, 12345, "envelope time wins");
  assert.strictEqual(out.events[1].eventName, "FetchURL");
  assert.strictEqual(out.events[1].time, 0, "no fabricated mtime fallback");

  fs.rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// codex
// ---------------------------------------------------------------------------

test("codex: appending a rollout — incremental scan equals fresh full scan", () => {
  const home = tmpHome("codex-incr-");
  const dir = path.join(home, "sessions", "2026", "09", "17");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "rollout-a.jsonl");

  const line = (id, turnId, tokens) =>
    JSON.stringify({
      timestamp: "2026-09-17T01:55:44Z",
      type: "token_usage_record",
      payload: {
        thread_id: "sess-1",
        turn_id: turnId,
        session_id: "sess-1",
        response_id: id,
        usage: {
          input_tokens: tokens,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          output_tokens: 1,
        },
      },
    });

  fs.writeFileSync(file, [line("r1", "t1", 10), line("r2", "t2", 20)].join("\n") + "\n");
  backdate(file);

  const first = codex.scan(home);
  assert.strictEqual(first.records.length, 2);
  assert.strictEqual(first.meta.filesReread, 1);

  const second = codex.scan(home);
  assert.strictEqual(second.meta.filesReread, 0);
  assert.deepStrictEqual(project(second.records), project(first.records));

  // Append a turn_context + usage for a new response id.
  fs.appendFileSync(file, JSON.stringify({
    timestamp: "2026-09-17T02:00:00Z",
    type: "turn_context",
    payload: { turn_id: "t3", model: "gpt-6-sol", cwd: "G:\\proj" },
  }) + "\n");
  fs.appendFileSync(file, line("r3", "t3", 30) + "\n");
  backdate(file);

  const incr = codex.scan(home);
  assert.strictEqual(incr.meta.filesReread, 1);
  assert.strictEqual(incr.records.length, 3);

  codex.clearCache();
  const full = codex.scan(home);
  assert.deepStrictEqual(project(incr.records), project(full.records),
    "incremental result must equal a fresh full scan");

  fs.rmSync(home, { recursive: true, force: true });
});

test("codex: archived copy of a response is still deduped against the cache", () => {
  const home = tmpHome("codex-dup-");
  const mk = (rel, id) => {
    const full = path.join(home, ...rel.split("/"));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, JSON.stringify({
      timestamp: "2026-09-17T01:55:44Z",
      type: "token_usage_record",
      payload: {
        thread_id: "sess-1", turn_id: "t1", session_id: "sess-1", response_id: id,
        usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1 },
      },
    }) + "\n");
  };
  mk("sessions/2026/09/17/rollout-a.jsonl", "r1");
  const first = codex.scan(home);
  assert.strictEqual(first.records.length, 1);

  // The same response appears in archived_sessions/ after archiving.
  mk("archived_sessions/2026/09/17/rollout-a.jsonl", "r1");
  const incr = codex.scan(home);
  assert.strictEqual(incr.records.length, 1, "archived duplicate dropped");
  assert.strictEqual(incr.meta.duplicatesSkipped, 1);

  codex.clearCache();
  const full = codex.scan(home);
  assert.strictEqual(full.records.length, 1, "fresh scan agrees");

  fs.rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// dsh
// ---------------------------------------------------------------------------

test("dsh: appending a transcript — incremental scan equals fresh full scan", () => {
  const home = tmpHome("dsh-incr-");
  const dir = path.join(home, "sessions", "--G-proj--", "session-a");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "session.v4.jsonl");

  const line = (id, time) =>
    JSON.stringify({
      time,
      type: "assistant/message",
      data: {
        message: { id, source: { provider: "qodercn", model: "dfmodel" } },
        usage: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1 },
      },
    });

  fs.writeFileSync(file, [
    JSON.stringify({ type: "session", id: "sess-a", cwd: "G:\\proj" }),
    line("m1", 1000),
  ].join("\n") + "\n");
  backdate(file);

  const first = dsh.scan(home);
  assert.strictEqual(first.records.length, 1);
  assert.strictEqual(first.meta.filesReread, 1);
  assert.strictEqual(first.records[0].modelDisplay, "DeepSeek-V4.1-Flash",
    "routing code resolved through model-identity");

  const second = dsh.scan(home);
  assert.strictEqual(second.meta.filesReread, 0);
  assert.deepStrictEqual(project(second.records), project(first.records));

  fs.appendFileSync(file, line("m2", 2000) + "\n");
  backdate(file);
  const incr = dsh.scan(home);
  assert.strictEqual(incr.meta.filesReread, 1);
  assert.strictEqual(incr.records.length, 2);

  dsh.clearCache();
  const full = dsh.scan(home);
  assert.deepStrictEqual(project(incr.records), project(full.records),
    "incremental result must equal a fresh full scan");

  fs.rmSync(home, { recursive: true, force: true });
});

test("dsh: duplicate message.id across files is deduped through the cache", () => {
  const home = tmpHome("dsh-dup-");
  const mk = (rel, id) => {
    const full = path.join(home, ...rel.split("/"));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, [
      JSON.stringify({ type: "session", id: "sess-x", cwd: "G:\\proj" }),
      line(id),
    ].join("\n") + "\n");
  };
  const line = (id) =>
    JSON.stringify({
      time: 1,
      type: "assistant/message",
      data: {
        message: { id, source: { provider: "qodercn", model: "dfmodel" } },
        usage: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1 },
      },
    });

  mk("sessions/--G-proj--/session-a/session.v4.jsonl", "m1");
  const first = dsh.scan(home);
  assert.strictEqual(first.records.length, 1);

  // A second file copying the same message (fork-style).
  mk("sessions/--G-proj--/session-b/session.v4.jsonl", "m1");
  const incr = dsh.scan(home);
  assert.strictEqual(incr.records.length, 1, "copied message dropped");
  assert.strictEqual(incr.meta.duplicatesSkipped, 1);

  dsh.clearCache();
  assert.strictEqual(dsh.scan(home).records.length, 1, "fresh scan agrees");

  fs.rmSync(home, { recursive: true, force: true });
});
