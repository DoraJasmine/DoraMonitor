"use strict";

/**
 * Regression tests for the data-accuracy fixes:
 *  - dsh: provider routing codes resolve to display names + real prices
 *  - dsh/codex/claude-code: a zero-usage placeholder must not swallow the
 *    real record that shares its id (dedupe runs AFTER the zero guard)
 *  - codex: compressed rollouts (.jsonl.zst / .jsonl.zstd) are read
 *  - kimi-code: a forked session's copied usage.record lines are not
 *    counted twice
 *  - zcode: rows that carry no tokens are not emitted as requests
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const dsh = require("../src/providers/dsh");
const codex = require("../src/providers/codex");
const claudeCode = require("../src/providers/claude-code");
const kimiCode = require("../src/providers/kimi-code");
const { resolveModelIdentity } = require("../src/model-identity");
const { matchPrice } = require("../src/pricing");

function tmpHome(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Write a multi-frame zstd buffer the way dsh appends frames. */
function multiFrameZstd(text) {
  const buf = Buffer.from(text, "utf8");
  const mid = Math.floor(buf.length / 2);
  return Buffer.concat([
    zlib.zstdCompressSync(buf.subarray(0, mid)),
    zlib.zstdCompressSync(buf.subarray(mid)),
  ]);
}

const zstdAvailable = (() => {
  try {
    zlib.zstdCompressSync(Buffer.from("x"));
    return true;
  } catch {
    return false;
  }
})();

// ---------------------------------------------------------------------------
// dsh model identity
// ---------------------------------------------------------------------------

test("dsh: a plugin routing code renders as the model name, not the raw code", () => {
  const home = tmpHome("dsh-model-");
  const sess = path.join(home, "sessions", "-proj", "session-1");
  fs.mkdirSync(sess, { recursive: true });
  fs.writeFileSync(
    path.join(sess, "session.v4.jsonl"),
    [
      JSON.stringify({ type: "session", id: "s1", cwd: "/work/proj" }),
      JSON.stringify({
        type: "assistant/message",
        time: 1700000000000,
        data: {
          usage: { inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 500 },
          message: { id: "m1", source: { kind: "model", provider: "qodercn", model: "dfmodel" } },
        },
      }),
    ].join("\n") + "\n"
  );

  const out = dsh.scan(home);

  assert.strictEqual(out.records.length, 1);
  const rec = out.records[0];
  assert.strictEqual(rec.model, "dfmodel", "raw id is preserved for traceability");
  assert.strictEqual(rec.modelDisplay, "DeepSeek-V4-Flash");
  assert.strictEqual(rec.modelProvider, "qodercn", "upstream provider is recorded");
  // The priced row must be the DeepSeek model, not the Kimi K2.6 fallback.
  assert.strictEqual(rec.priceId, "deepseek-flash");
  assert.ok(rec.costCny > 0);

  fs.rmSync(home, { recursive: true, force: true });
});

test("dsh: an unmapped code stays visible instead of disappearing", () => {
  const home = tmpHome("dsh-unknown-");
  const sess = path.join(home, "sessions", "-p", "session-2");
  fs.mkdirSync(sess, { recursive: true });
  fs.writeFileSync(
    path.join(sess, "session.v4.jsonl"),
    [
      JSON.stringify({ type: "session", id: "s2" }),
      JSON.stringify({
        type: "assistant/message",
        time: 1700000001000,
        data: {
          usage: { inputTokens: 10, outputTokens: 5 },
          message: { id: "m2", source: { provider: "mystery", model: "brand-new-code" } },
        },
      }),
    ].join("\n") + "\n"
  );

  const out = dsh.scan(home);
  assert.strictEqual(out.records.length, 1);
  assert.strictEqual(out.records[0].modelDisplay, "brand-new-code");
  assert.strictEqual(out.records[0].modelProvider, "mystery");

  fs.rmSync(home, { recursive: true, force: true });
});

test("dsh: every code seen in a real session resolves to a priced model", () => {
  // These are the ids this machine's dsh sessions actually contain.
  for (const code of ["dfmodel", "qfmodel", "hy3"]) {
    const id = resolveModelIdentity(code);
    const price = matchPrice(id.pricingKey || id.model, { fxRate: 7.2, inputTokens: 1000 });
    assert.ok(price.id, `${code} produced no price row`);
    assert.notStrictEqual(
      price.id,
      "kimi-k2.6",
      `${code} still falls back to Kimi K2.6 pricing`
    );
  }
});

// ---------------------------------------------------------------------------
// dedupe ordering: zero placeholder must not swallow the real record
// ---------------------------------------------------------------------------

test("codex: a zero-usage placeholder does not swallow the real record", () => {
  const home = tmpHome("codex-order-");
  const sess = path.join(home, "sessions", "2026", "01", "01");
  fs.mkdirSync(sess, { recursive: true });

  const zero = {
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "token_usage_record",
    payload: {
      response_id: "resp_SAME",
      turn_id: "t1",
      usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 },
    },
  };
  const real = {
    timestamp: "2026-01-01T00:00:01.000Z",
    type: "token_usage_record",
    payload: {
      response_id: "resp_SAME",
      turn_id: "t1",
      usage: { input_tokens: 1000, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 500 },
    },
  };
  fs.writeFileSync(
    path.join(sess, "rollout-x.jsonl"),
    [JSON.stringify(zero), JSON.stringify(real)].join("\n") + "\n"
  );

  const out = codex.scan(home);
  assert.strictEqual(out.records.length, 1, "the real record must survive");
  assert.strictEqual(out.records[0].inputOther + out.records[0].output, 1500);

  fs.rmSync(home, { recursive: true, force: true });
});

test("claude-code: a zero-usage placeholder does not swallow the real record", () => {
  const home = tmpHome("claude-order-");
  const proj = path.join(home, "projects", "-work");
  fs.mkdirSync(proj, { recursive: true });

  const base = { type: "assistant", timestamp: "2026-01-01T00:00:00.000Z", requestId: "r1" };
  const zero = {
    ...base,
    message: { id: "msg_SAME", model: "claude-sonnet-4-6", usage: { input_tokens: 0, output_tokens: 0 } },
  };
  const real = {
    ...base,
    timestamp: "2026-01-01T00:00:01.000Z",
    message: {
      id: "msg_SAME",
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 800, output_tokens: 200, cache_read_input_tokens: 0 },
    },
  };
  fs.writeFileSync(path.join(proj, "s.jsonl"), [JSON.stringify(zero), JSON.stringify(real)].join("\n") + "\n");

  const out = claudeCode.scan(home);
  assert.strictEqual(out.records.length, 1, "the real record must survive");
  assert.strictEqual(out.records[0].inputOther + out.records[0].output, 1000);

  fs.rmSync(home, { recursive: true, force: true });
});

test("dsh: a zero-usage placeholder does not swallow the real message", () => {
  const home = tmpHome("dsh-order-");
  const sess = path.join(home, "sessions", "-p", "session-3");
  fs.mkdirSync(sess, { recursive: true });
  const mk = (usage, time) =>
    JSON.stringify({
      type: "assistant/message",
      time,
      data: { usage, message: { id: "m_SAME", source: { provider: "p", model: "deepseek-flash" } } },
    });
  fs.writeFileSync(
    path.join(sess, "session.v4.jsonl"),
    [
      JSON.stringify({ type: "session", id: "s3" }),
      mk({ inputTokens: 0, outputTokens: 0 }, 1700000000000),
      mk({ inputTokens: 900, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }, 1700000001000),
    ].join("\n") + "\n"
  );

  const out = dsh.scan(home);
  assert.strictEqual(out.records.length, 1, "the real record must survive");
  assert.strictEqual(out.records[0].inputOther + out.records[0].output, 1000);

  fs.rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// codex compressed rollouts
// ---------------------------------------------------------------------------

test("codex: reads .jsonl.zst rollouts (archived sessions ship compressed)", { skip: !zstdAvailable }, () => {
  const home = tmpHome("codex-zst-");
  const sess = path.join(home, "archived_sessions");
  fs.mkdirSync(sess, { recursive: true });

  const line = JSON.stringify({
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "token_usage_record",
    payload: {
      response_id: "resp_zst",
      turn_id: "t1",
      usage: { input_tokens: 2000, cached_input_tokens: 500, cache_write_input_tokens: 0, output_tokens: 300 },
    },
  });
  fs.writeFileSync(path.join(sess, "rollout-a.jsonl.zst"), zlib.zstdCompressSync(Buffer.from(line + "\n", "utf8")));

  const out = codex.scan(home);
  assert.strictEqual(out.records.length, 1, "compressed rollout was skipped");
  const rec = out.records[0];
  assert.strictEqual(rec.inputOther, 1500);
  assert.strictEqual(rec.output, 300);
  assert.strictEqual(rec.inputCacheRead, 500);

  fs.rmSync(home, { recursive: true, force: true });
});

test("codex: a corrupt compressed rollout is reported, not fatal", () => {
  const home = tmpHome("codex-corrupt-");
  const sess = path.join(home, "sessions", "2026", "01", "01");
  fs.mkdirSync(sess, { recursive: true });
  fs.writeFileSync(path.join(sess, "rollout-bad.jsonl.zst"), Buffer.from("not zstd at all"));

  const ok = JSON.stringify({
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "token_usage_record",
    payload: {
      response_id: "resp_ok",
      turn_id: "t1",
      usage: { input_tokens: 100, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 10 },
    },
  });
  fs.writeFileSync(path.join(sess, "rollout-ok.jsonl"), ok + "\n");

  const out = codex.scan(home);
  assert.strictEqual(out.records.length, 1, "the healthy file must still be read");
  assert.ok(out.meta.errors.length >= 1, "the corrupt file should be reported");

  fs.rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// kimi forked-session duplicates
// ---------------------------------------------------------------------------

test("kimi-code: a forked session's copied usage.record is counted once", () => {
  const home = tmpHome("kimi-fork-");
  const root = path.join(home, "sessions", "wd_proj_abc");
  const parent = path.join(root, "session_parent", "agents", "main");
  const fork = path.join(root, "session_fork", "agents", "main");
  fs.mkdirSync(parent, { recursive: true });
  fs.mkdirSync(fork, { recursive: true });

  const usageLine = (time) =>
    JSON.stringify({
      type: "usage.record",
      usageScope: "turn",
      model: "kimi-k2.6",
      time,
      usage: { inputOther: 1000, output: 200, inputCacheRead: 100, inputCacheCreation: 0 },
    });

  // Two parent turns, then a fork that copied both plus one of its own.
  const turns = [usageLine(1700000000000), usageLine(1700000001000)];
  fs.writeFileSync(path.join(parent, "wire.jsonl"), turns.join("\n") + "\n");
  fs.writeFileSync(
    path.join(fork, "wire.jsonl"),
    [...turns, usageLine(1700000002000)].join("\n") + "\n"
  );

  const out = kimiCode.scan(home);
  assert.strictEqual(out.records.length, 3, "2 parent turns + 1 fork-only turn");
  assert.strictEqual(out.meta.duplicatesSkipped, 2, "the two copied turns are dropped");

  fs.rmSync(home, { recursive: true, force: true });
});

test("kimi-code: records without a timestamp are never deduped away", () => {
  const home = tmpHome("kimi-notime-");
  const dir = path.join(home, "sessions", "wd_p", "session_a", "agents", "main");
  fs.mkdirSync(dir, { recursive: true });
  // Two identical lines with no time must both count: they cannot be told
  // apart from a genuinely repeated request.
  const line = JSON.stringify({
    type: "usage.record",
    usageScope: "turn",
    model: "kimi-k2.6",
    usage: { inputOther: 10, output: 1, inputCacheRead: 0, inputCacheCreation: 0 },
  });
  fs.writeFileSync(path.join(dir, "wire.jsonl"), [line, line].join("\n") + "\n");

  const out = kimiCode.scan(home);
  assert.strictEqual(out.records.length, 2);

  fs.rmSync(home, { recursive: true, force: true });
});
