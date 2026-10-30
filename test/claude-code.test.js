"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const claudeCode = require("../src/tools/claude-code");
const { matchPrice } = require("../src/pricing");
const matchPriceFx = (name) => matchPrice(name, { fxRate: 7.2 });

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aum-claude-test-"));
}

function transcriptHome(files) {
  // files: { "projects/D--proj/session-a.jsonl": [lines...], ... }
  const home = tmpDir();
  for (const rel of Object.keys(files)) {
    const full = path.join(home, ...rel.split("/"));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, files[rel].map((l) => JSON.stringify(l)).join("\n") + "\n");
  }
  return home;
}

function assistantLine({ msgId, requestId, cwd, sessionId, model, usage }) {
  return {
    parentUuid: null,
    isSidechain: false,
    userType: "external",
    cwd,
    sessionId,
    type: "assistant",
    message: {
      id: msgId,
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text: "ok" }],
      usage,
    },
    requestId,
    timestamp: "2026-09-17T01:55:44.123Z",
  };
}

const SONNET_USAGE = {
  input_tokens: 1000,
  cache_read_input_tokens: 400,
  cache_creation_input_tokens: 50,
  output_tokens: 200,
};

test("claude provider: missing projects dir returns empty without throwing", () => {
  const home = tmpDir();
  const out = claudeCode.scan(home);
  assert.strictEqual(out.records.length, 0);
  assert.strictEqual(claudeCode.isAvailable(home), false);
});

test("claude provider: parses usage with Anthropic input convention, resolves project/session", () => {
  const home = transcriptHome({
    "projects/D--proj/session-a.jsonl": [
      assistantLine({
        msgId: "msg_01",
        requestId: "req_01",
        cwd: "D:\\proj",
        sessionId: "session-a",
        model: "claude-sonnet-4-5-20250929",
        usage: SONNET_USAGE,
      }),
    ],
  });
  const out = claudeCode.scan(home);
  assert.strictEqual(out.records.length, 1);
  const r = out.records[0];
  // Anthropic input_tokens EXCLUDES the cached portions — no subtraction
  assert.strictEqual(r.inputOther, 1000);
  assert.strictEqual(r.inputCacheRead, 400);
  assert.strictEqual(r.inputCacheCreation, 50);
  assert.strictEqual(r.output, 200);
  assert.strictEqual(r.model, "claude-sonnet-4-5-20250929");
  assert.strictEqual(r.project, "D:\\proj");
  assert.strictEqual(r.session, "session-a");
  assert.strictEqual(r.time, Date.parse("2026-09-17T01:55:44.123Z"));
  // Sonnet USD/M: in 3, cache read 0.3, cache write 3.75, out 15 — converted
  // with the fxRate the provider itself reads (user settings), whatever it is.
  const fx = require("../src/settings").loadSettings().fxRate || 6.67;
  assert.ok(Math.abs(r.costCny - (0.0063075 * fx)) < 1e-9, `costCny=${r.costCny} fx=${fx}`);
  assert.strictEqual(r.costEstimated, false);
  assert.strictEqual(r.priceId, "claude-sonnet");
});

test("claude provider: dedupes message id across files (resume copies history)", () => {
  const home = transcriptHome({
    "projects/D--proj-one/session-a.jsonl": [
      assistantLine({
        msgId: "msg_01",
        requestId: "req_01",
        cwd: "D:\\one",
        sessionId: "session-a",
        model: "claude-sonnet-4-5-20250929",
        usage: SONNET_USAGE,
      }),
      assistantLine({
        msgId: "msg_02",
        requestId: "req_02",
        cwd: "D:\\one",
        sessionId: "session-a",
        model: "claude-sonnet-4-5-20250929",
        usage: SONNET_USAGE,
      }),
    ],
    "projects/D--proj-two/session-b.jsonl": [
      // `claude --resume` copy of the whole prior transcript
      assistantLine({
        msgId: "msg_01",
        requestId: "req_01",
        cwd: "D:\\two",
        sessionId: "session-b",
        model: "claude-sonnet-4-5-20250929",
        usage: SONNET_USAGE,
      }),
      // a genuinely new turn
      assistantLine({
        msgId: "msg_03",
        requestId: "req_03",
        cwd: "D:\\two",
        sessionId: "session-b",
        model: "claude-sonnet-4-5-20250929",
        usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 },
      }),
    ],
  });
  const out = claudeCode.scan(home);
  // msg_01 (resume copy) + msg_02 + msg_03 — 3 unique responses
  assert.strictEqual(out.records.length, 3);
  assert.ok(out.records.every((r) => r.model === "claude-sonnet-4-5-20250929"));
});

test("claude provider: skips zero-usage rows and lines without usage", () => {
  const home = transcriptHome({
    "projects/D--proj/session-a.jsonl": [
      // synthetic API-error line: no usage object at all
      { type: "assistant", message: { id: "msg_x", model: "<synthetic>", content: [] }, timestamp: "2026-09-17T01:00:00Z" },
      assistantLine({
        msgId: "msg_01",
        requestId: "req_01",
        cwd: "D:\\proj",
        sessionId: "session-a",
        model: "claude-sonnet-4-5-20250929",
        usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 },
      }),
      assistantLine({
        msgId: "msg_02",
        requestId: "req_02",
        cwd: "D:\\proj",
        sessionId: "session-a",
        model: "claude-sonnet-4-5-20250929",
        usage: { input_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 },
      }),
    ],
  });
  const out = claudeCode.scan(home);
  assert.strictEqual(out.records.length, 1);
  assert.strictEqual(out.records[0].inputOther, 5);
});

test("claude provider: falls back to cache_creation TTL breakdown when total missing", () => {
  const home = transcriptHome({
    "projects/D--proj/session-a.jsonl": [
      assistantLine({
        msgId: "msg_01",
        requestId: "req_01",
        cwd: "D:\\proj",
        sessionId: "session-a",
        model: "claude-opus-4-5-20251101",
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 0,
          cache_creation: { ephemeral_5m_write_tokens: 60, ephemeral_1h_write_tokens: 40 },
          output_tokens: 10,
        },
      }),
    ],
  });
  const out = claudeCode.scan(home);
  assert.strictEqual(out.records[0].inputCacheCreation, 100);
});

test("claude provider: project falls back to the encoded dir name when cwd is absent", () => {
  const home = transcriptHome({
    "projects/D--proj/session-a.jsonl": [
      assistantLine({
        msgId: "msg_01",
        requestId: "req_01",
        sessionId: "session-a",
        model: "claude-sonnet-4-5-20250929",
        usage: { input_tokens: 5, output_tokens: 1 },
      }),
    ],
  });
  const out = claudeCode.scan(home);
  assert.strictEqual(out.records[0].project, "D--proj");
  // session falls back to the file basename
  assert.strictEqual(out.records[0].session, "session-a");
});

test("claude provider: exposes no quota (by design, unlike codex)", () => {
  const home = transcriptHome({
    "projects/D--proj/session-a.jsonl": [
      assistantLine({
        msgId: "msg_01",
        requestId: "req_01",
        cwd: "D:\\proj",
        sessionId: "session-a",
        model: "claude-sonnet-4-5-20250929",
        usage: { input_tokens: 5, output_tokens: 1 },
      }),
    ],
  });
  const out = claudeCode.scan(home);
  assert.strictEqual(out.quota, undefined);
});

test("anthropic price table: known families and USD->CNY conversion", () => {
  assert.equal(matchPriceFx("claude-sonnet-4-5-20250929").id, "claude-sonnet");
  assert.equal(matchPriceFx("claude-sonnet-4-5-20250929").input, 3.0 * 7.2);
  assert.equal(matchPriceFx("claude-sonnet-4-5-20250929").cacheWrite, 3.75 * 7.2);
  // Opus 5.5 (2026-09-22) has its own cheaper tier; 5 and 4.5–4.8 share $5/$25
  assert.equal(matchPriceFx("claude-opus-5-5-20260922").id, "claude-opus-5-5");
  assert.equal(matchPriceFx("claude-opus-5-5-20260922").input, 4.0 * 7.2);
  assert.equal(matchPriceFx("claude-opus-5-5-20260922").cacheWrite, 5.0 * 7.2);
  assert.equal(matchPriceFx("claude-opus-5-5-20260922").cacheHit, 0.2 * 7.2);
  assert.equal(matchPriceFx("claude-opus-5-20260609").id, "claude-opus-5");
  assert.equal(matchPriceFx("claude-opus-5-20260609").input, 5.0 * 7.2);
  assert.equal(matchPriceFx("claude-opus-4-5-20251101").id, "claude-opus-5");
  assert.equal(matchPriceFx("claude-opus-4-8-20260415").id, "claude-opus-5");
  assert.equal(matchPriceFx("claude-sonnet-5-20260609").id, "claude-sonnet-5");
  assert.equal(matchPriceFx("claude-sonnet-5-20260609").input, 2.0 * 7.2);
  assert.equal(matchPriceFx("claude-sonnet-5-20260609").cacheWrite, 2.5 * 7.2);
  assert.equal(matchPriceFx("claude-fable-5-20260301").id, "claude-fable-5");
  assert.equal(matchPriceFx("claude-fable-5-20260301").input, 10.0 * 7.2);
  assert.equal(matchPriceFx("claude-fable-5-20260301").cacheHit, 0.25 * 7.2);
  // Mythos 5 shares Fable 5 pricing
  assert.equal(matchPriceFx("claude-mythos-5-20260301").id, "claude-fable-5");
  assert.equal(matchPriceFx("claude-opus-4-1-20250805").id, "claude-opus");
  assert.equal(matchPriceFx("claude-opus-4-1-20250805").input, 15.0 * 7.2);
  assert.equal(matchPriceFx("claude-haiku-4-5-20251001").id, "claude-haiku-4-5");
  assert.equal(matchPriceFx("claude-3-5-haiku-20241022").id, "claude-3-5-haiku");
  assert.equal(matchPriceFx("claude-3-5-haiku-20241022").input, 0.8 * 7.2);
  assert.equal(matchPriceFx("claude-3-haiku-20240307").id, "claude-3-haiku");
  assert.equal(matchPriceFx("claude-sonnet-4-5-20250929").estimated, false);
});
