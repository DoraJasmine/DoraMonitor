"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const kimiCode = require("../src/providers/kimi-code");
const zcode = require("../src/providers/zcode");
const qoderCn = require("../src/providers/qoder-cn");
const qoderCli = require("../src/providers/qoder-cn-cli");
const { collect } = require("../src/collect");
const { parseUsageBody } = require("../src/quota");
const { aggregate, aggregateByTool } = require("../src/aggregate");
const { toolMeta } = require("../src/providers/base");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aum-test-"));
}

function record(overrides = {}) {
  return {
    tool: "kimi-code",
    time: Date.now(),
    model: "m1",
    modelDisplay: "m1",
    modelResolved: "m1",
    inputOther: 10,
    output: 5,
    inputCacheRead: 20,
    inputCacheCreation: 0,
    costUsd: 0,
    costEstimated: false,
    priceId: null,
    credits: null,
    project: null,
    session: null,
    sessionHint: null,
    ...overrides,
  };
}

test("kimi provider: missing sessions dir returns empty with error", () => {
  const home = tmpDir();
  const out = kimiCode.scan(home, { aliases: {} });
  assert.strictEqual(out.records.length, 0);
  assert.ok(out.meta.errors.length >= 1);
  assert.strictEqual(kimiCode.isAvailable(home), false);
});

test("zcode provider: missing db returns empty without throwing", () => {
  const home = tmpDir();
  const out = zcode.scan(home);
  assert.strictEqual(out.records.length, 0);
  assert.ok(out.meta.errors.length >= 1);
});

test("qoder-cn provider: missing db returns empty without throwing", () => {
  const home = tmpDir();
  const out = qoderCn.scan(home);
  assert.strictEqual(out.records.length, 0);
  assert.ok(out.meta.errors.length >= 1);
});

test("qoder-cli provider: parses usage and credits, skips broken lines", () => {
  const home = tmpDir();
  const projectDir = path.join(home, "projects", "-home-zxt-demo");
  fs.mkdirSync(projectDir, { recursive: true });
  const lines = [
    JSON.stringify({ type: "workspace-directories", sessionId: "s1" }),
    "not json at all",
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-08-28T06:32:19.505Z",
      message: {
        model: "qmodel_latest",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          credits: 0.55,
        },
      },
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: 1787494486188,
      message: {
        model: "qfmodel",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 200,
          cache_creation_input_tokens: 10,
          credits: 1.5,
        },
      },
    }),
    JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
  ];
  fs.writeFileSync(path.join(projectDir, "sess-1.jsonl"), lines.join("\n"));

  const out = qoderCli.scan(home);
  assert.strictEqual(out.records.length, 2);
  const withTokens = out.records.find((r) => r.inputOther === 100);
  assert.ok(withTokens);
  assert.strictEqual(withTokens.tool, "qoder-cn-cli");
  assert.strictEqual(withTokens.modelDisplay, "Qwen3.6-Flash");
  assert.strictEqual(withTokens.credits, 1.5);
  assert.strictEqual(withTokens.project, "/home/zxt/demo");
  assert.strictEqual(withTokens.session, "sess-1");
  const creditsOnly = out.records.find((r) => r.credits === 0.55);
  assert.ok(creditsOnly, "zero-token rows with credits are kept");
});

test("qoder-cli provider: no projects dir → empty, no throw", () => {
  const out = qoderCli.scan(tmpDir());
  assert.strictEqual(out.records.length, 0);
});

test("collect: merges providers, every record has a tool field", () => {
  const { records, tools } = collect({ force: true });
  assert.ok(Array.isArray(tools) && tools.length >= 1);
  for (const r of records) {
    assert.ok(r.tool, "record missing tool");
    assert.ok(Number.isFinite(r.time));
  }
  // newest first
  for (let i = 1; i < records.length; i++) {
    assert.ok(records[i - 1].time >= records[i].time);
  }
});

test("aggregate: tool filter and credits roll up", () => {
  const records = [
    record({ tool: "kimi-code", inputOther: 100, credits: null }),
    record({ tool: "qoder-cn-cli", inputOther: 0, credits: 2.5 }),
    record({ tool: "qoder-cn-cli", inputOther: 0, credits: 1.5 }),
  ];
  const kimi = aggregate(records, "all", Date.now(), "kimi-code");
  assert.strictEqual(kimi.totals.requests, 1);
  assert.strictEqual(kimi.totals.credits, 0);
  const qc = aggregate(records, "all", Date.now(), "qoder-cn-cli");
  assert.strictEqual(qc.totals.requests, 2);
  assert.strictEqual(qc.totals.credits, 4);
  const all = aggregateByTool(records, "all", toolMeta);
  assert.strictEqual(all.length, 2);
  const qcAgg = all.find((x) => x.id === "qoder-cn-cli");
  assert.strictEqual(qcAgg.credits, 4);
});

test("quota: parses canonical kimi usages payload", () => {
  const body = {
    usage: {
      name: "Weekly",
      used: 120,
      limit: 1000,
      reset_at: "2026-09-01T00:00:00Z",
    },
    limits: [
      {
        window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
        detail: { used: 50, limit: 100, reset_at: 1787999999000 },
      },
    ],
  };
  const windows = parseUsageBody(body);
  assert.strictEqual(windows.length, 2);
  const weekly = windows.find((w) => w.kind === "weekly");
  assert.strictEqual(weekly.usedPercent, 12);
  assert.strictEqual(weekly.resetsAt, "2026-09-01T00:00:00.000Z");
  const session = windows.find((w) => w.kind === "session");
  assert.strictEqual(session.usedPercent, 50);
  assert.ok(session.resetsAt);
});

test("quota: tolerates empty/unknown payloads", () => {
  assert.deepStrictEqual(parseUsageBody(null), []);
  assert.deepStrictEqual(parseUsageBody({}), []);
  assert.deepStrictEqual(parseUsageBody({ data: { usage: {} } }), []);
});
