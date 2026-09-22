"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const codex = require("../src/providers/codex");
const { matchPrice } = require("../src/pricing");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aum-codex-test-"));
}

function rolloutHome(files) {
  // files: { "sessions/2026/09/17/rollout-a.jsonl": [lines...], ... }
  const home = tmpDir();
  for (const rel of Object.keys(files)) {
    const full = path.join(home, ...rel.split("/"));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, files[rel].map((l) => JSON.stringify(l)).join("\n") + "\n");
  }
  return home;
}

function turnContext(turnId, model, cwd) {
  return {
    timestamp: "2026-09-17T01:53:57Z",
    type: "turn_context",
    payload: { turn_id: turnId, model, cwd },
  };
}

function usageRecord(responseId, turnId, usage, sessionId = "sess-1") {
  return {
    timestamp: "2026-09-17T01:55:44Z",
    type: "token_usage_record",
    payload: {
      thread_id: sessionId,
      turn_id: turnId,
      session_id: sessionId,
      response_id: responseId,
      usage,
      // cumulative fields that must be ignored
      turn_token_usage: { input_tokens: 999999, output_tokens: 999999 },
      thread_token_usage: { input_tokens: 999999, output_tokens: 999999 },
    },
  };
}

test("codex provider: missing sessions dir returns empty without throwing", () => {
  const home = tmpDir();
  const out = codex.scan(home);
  assert.strictEqual(out.records.length, 0);
  assert.strictEqual(codex.isAvailable(home), false);
});

test("codex provider: parses per-response usage, splits cached input, resolves model/cwd", () => {
  const home = rolloutHome({
    "sessions/2026/09/17/rollout-a.jsonl": [
      {
        timestamp: "2026-09-17T01:53:52Z",
        type: "session_meta",
        payload: { session_id: "sess-1", cwd: "G:\\proj" },
      },
      turnContext("t1", "gpt-5.6-terra", "G:\\proj"),
      usageRecord("r1", "t1", {
        input_tokens: 1000,
        cached_input_tokens: 400,
        cache_write_input_tokens: 50,
        output_tokens: 200,
      }),
    ],
  });
  const out = codex.scan(home);
  assert.strictEqual(out.records.length, 1);
  const r = out.records[0];
  // input_tokens includes the cached portion -> uncached input is 1000-400
  assert.strictEqual(r.inputOther, 600);
  assert.strictEqual(r.inputCacheRead, 400);
  assert.strictEqual(r.inputCacheCreation, 50);
  assert.strictEqual(r.output, 200);
  assert.strictEqual(r.model, "gpt-5.6-terra");
  assert.strictEqual(r.project, "G:\\proj");
  assert.strictEqual(r.session, "sess-1");
  assert.ok(r.time > 0);
  // terra price: (600*2 + 400*0.2 + 50*2 + 200*12) / 1e6
  assert.ok(Math.abs(r.costUsd - 0.00378) < 1e-9, `costUsd=${r.costUsd}`);
  assert.strictEqual(r.costEstimated, false);
  assert.strictEqual(r.priceId, "gpt-5.6-terra");
});

test("codex provider: dedupes response_id within a file and across archived_sessions", () => {
  const home = rolloutHome({
    "sessions/2026/09/17/rollout-a.jsonl": [
      turnContext("t1", "gpt-5.6-terra", "G:\\proj"),
      usageRecord("r1", "t1", { input_tokens: 100, output_tokens: 10 }),
      usageRecord("r1", "t1", { input_tokens: 100, output_tokens: 10 }),
      usageRecord("r2", "t1", { input_tokens: 200, cached_input_tokens: 150, output_tokens: 20 }),
    ],
    "archived_sessions/2026/09/10/rollout-b.jsonl": [
      turnContext("t1", "gpt-6-astra", "G:\\old"),
      usageRecord("r2", "t1", { input_tokens: 200, cached_input_tokens: 150, output_tokens: 20 }, "sess-2"),
      usageRecord("r3", "t2", { input_tokens: 50, output_tokens: 5 }, "sess-2"),
    ],
  });
  const out = codex.scan(home);
  // r1 twice in one file + r2 in both dirs -> 3 unique responses
  assert.strictEqual(out.records.length, 3);
  const byResponse = new Map(out.records.map((r) => [r.session + ":" + r.output, r]));
  const r2 = out.records.find((r) => r.output === 20);
  // archived copy wins only if scanned first; either way it appears exactly once
  assert.ok(r2);
  const r3 = out.records.find((r) => r.output === 5);
  // no turn_context for t2 -> falls back to the last model seen in that file
  assert.strictEqual(r3.model, "gpt-6-astra");
  assert.strictEqual(r3.project, "G:\\old");
  assert.strictEqual(out.meta.filesScanned, 2);
});

test("codex provider: skips all-zero usage rows", () => {
  const home = rolloutHome({
    "sessions/2026/09/17/rollout-a.jsonl": [
      turnContext("t1", "gpt-5.6-luna", "G:\\proj"),
      usageRecord("r1", "t1", { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 }),
    ],
  });
  const out = codex.scan(home);
  assert.strictEqual(out.records.length, 0);
});

function tokenCount(ts, rateLimits) {
  return {
    timestamp: ts,
    type: "event_msg",
    payload: { type: "token_count", rate_limits: rateLimits },
  };
}

test("codex provider: extracts newest rate_limits as session+weekly quota windows", () => {
  const home = rolloutHome({
    "sessions/2026/09/17/rollout-a.jsonl": [
      turnContext("t1", "gpt-5.6-terra", "G:\\proj"),
      usageRecord("r1", "t1", { input_tokens: 100, output_tokens: 10 }),
      tokenCount("2026-09-17T08:00:00Z", {
        primary: { used_percent: 5, window_minutes: 300, resets_at: 1789649538 },
        secondary: { used_percent: 17, window_minutes: 10080, resets_at: 1790214942 },
      }),
      tokenCount("2026-09-17T08:05:00Z", {
        primary: { used_percent: 9, window_minutes: 300, resets_at: 1789649548 },
        secondary: { used_percent: 18, window_minutes: 10080, resets_at: 1790214941 },
      }),
    ],
  });
  const out = codex.scan(home);
  assert.strictEqual(out.quota.available, true);
  // newest event wins
  assert.strictEqual(out.quota.fetchedAt, "2026-09-17T08:05:00.000Z");
  const [five, week] = out.quota.windows;
  assert.strictEqual(five.kind, "session");
  assert.strictEqual(five.usedPercent, 9);
  assert.strictEqual(five.resetsAt, new Date(1789649548 * 1000).toISOString());
  assert.strictEqual(week.kind, "weekly");
  assert.strictEqual(week.usedPercent, 18);
});

test("codex provider: quota unavailable when no rate_limits events exist", () => {
  const home = rolloutHome({
    "sessions/2026/09/17/rollout-a.jsonl": [
      turnContext("t1", "gpt-5.6-terra", "G:\\proj"),
      usageRecord("r1", "t1", { input_tokens: 100, output_tokens: 10 }),
    ],
  });
  const out = codex.scan(home);
  assert.strictEqual(out.quota.available, false);
  assert.strictEqual(out.quota.windows.length, 0);
});

test("codex provider: keeps newest quota across files and archived_sessions", () => {
  const home = rolloutHome({
    "sessions/2026/09/17/rollout-a.jsonl": [
      tokenCount("2026-09-17T08:00:00Z", {
        primary: { used_percent: 5, window_minutes: 300, resets_at: 1789649538 },
      }),
    ],
    "archived_sessions/2026/09/10/rollout-b.jsonl": [
      tokenCount("2026-09-17T09:00:00Z", {
        primary: { used_percent: 42, window_minutes: 300, resets_at: 1789649538 },
        secondary: { used_percent: 20, window_minutes: 10080, resets_at: 1790214942 },
      }),
    ],
  });
  const out = codex.scan(home);
  assert.strictEqual(out.quota.windows[0].usedPercent, 42);
  assert.strictEqual(out.quota.windows.length, 2);
});

test("openai price table: known models and estimate flags", () => {
  assert.equal(matchPrice("gpt-6-astra").id, "gpt-6-astra");
  assert.equal(matchPrice("gpt-5.6-luna").output, 1.2);
  assert.equal(matchPrice("GPT-5.6-Terra").input, 2.0);
  assert.equal(matchPrice("gpt-5.6").id, "gpt-5.6");
  assert.equal(matchPrice("codex-auto-review").estimated, true);
  assert.equal(matchPrice("gpt-6-astra").estimated, false);
});
