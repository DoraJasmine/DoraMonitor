"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const kimiCode = require("../src/tools/kimi-code");
const zcode = require("../src/tools/zcode");
const qoderCn = require("../src/tools/qoder-cn");
const qoderCli = require("../src/tools/qoder-cn-cli");
const { collect, invalidate } = require("../src/collect");
const { parseUsageBody } = require("../src/quota");
const { aggregate, aggregateByTool } = require("../src/aggregate");
const { toolMeta } = require("../src/tools/base");

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
    costCny: 0,
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

test("zcode provider: missing db throws so collect keeps previous data", () => {
  const home = tmpDir();
  assert.throws(() => zcode.scan(home), /unable to open database file/);
});

test("zcode provider: session join attributes usage to workspace directories", () => {
  const home = tmpDir();
  const dbDir = path.join(home, "cli", "db");
  fs.mkdirSync(dbDir, { recursive: true });
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(dbDir, "db.sqlite"));
  db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT)");
  db.exec(`CREATE TABLE model_usage (
    id INTEGER PRIMARY KEY, session_id TEXT, model_id TEXT,
    input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
    cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER,
    computed_total_tokens INTEGER, started_at INTEGER, status TEXT)`);
  db.prepare("INSERT INTO session VALUES (?, ?)").run("s1", "D:\proj\alpha");
  const ins = db.prepare(
    "INSERT INTO model_usage (session_id, model_id, input_tokens, output_tokens, reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens, computed_total_tokens, started_at, status) VALUES (?, 'm', 100, 10, 0, 0, 0, 110, ?, 'ok')"
  );
  ins.run("s1", Date.now() - 60_000);
  ins.run("s2", Date.now() - 30_000); // 无 session 行 → project 为空
  db.close();
  const out = zcode.scan(home);
  assert.strictEqual(out.records.length, 2);
  const attributed = out.records.find((r) => r.session === "s1");
  assert.strictEqual(attributed.project, "D:\proj\alpha");
  const orphan = out.records.find((r) => r.session === "s2");
  assert.strictEqual(orphan.project, null);
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
  assert.strictEqual(withTokens.modelDisplay, "Qwen3.8-Flash");
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

test("collect: merges providers, every record has a tool field", (t) => {
  const home = tmpDir();
  const projectDir = path.join(home, "projects", "-tmp-ci");
  fs.mkdirSync(projectDir, { recursive: true });
  const usage = (timestamp, input) => JSON.stringify({
    type: "assistant",
    timestamp,
    message: { model: "qfmodel", usage: { input_tokens: input, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 0 } },
  });
  fs.writeFileSync(path.join(projectDir, "ci.jsonl"), [
    usage("2026-10-31T00:00:00Z", 10),
    usage("2026-10-31T00:01:00Z", 20),
  ].join("\n"));
  const previousHome = process.env.QODER_CLI_HOME;
  process.env.QODER_CLI_HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.QODER_CLI_HOME;
    else process.env.QODER_CLI_HOME = previousHome;
    invalidate();
  });

  const { records, tools } = collect({ force: true });
  assert.ok(Array.isArray(tools) && tools.length >= 1);
  assert.ok(records.some((item) => item.tool === "qoder-cn-cli" && item.session === "ci"));
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

const sync = require("../src/sync");

test("sync: summary build/merge round-trip preserves tokens", () => {
  const records = [
    record({ tool: "kimi-code", model: "k3", inputOther: 100, output: 50, inputCacheRead: 200, inputCacheCreation: 10, inputCacheCreationShort: 4, inputCacheCreationLong: 6, credits: 0, time: new Date(2026, 7, 28, 10, 0).getTime() }),
    record({ tool: "zcode", model: "GLM-5.3", inputOther: 5, output: 1, inputCacheRead: 7, credits: 0, time: new Date(2026, 7, 28, 15, 0).getTime() }),
    record({ tool: "qoder-cn-cli", model: "qfmodel", inputOther: 0, output: 0, credits: 2.5, time: new Date(2026, 7, 27, 8, 0).getTime() }),
  ];
  const summary = sync.buildSummary("dev-a", records);
  assert.strictEqual(summary.device, "dev-a");
  assert.strictEqual(Object.keys(summary.days).length, 2);

  const peerRecords = sync.summaryToRecords(summary);
  assert.strictEqual(peerRecords.length, 3);
  assert.ok(peerRecords.every((r) => r.device === "dev-a" && r.peer === true));
  const k3 = peerRecords.find((r) => r.model === "k3");
  assert.strictEqual(k3.inputOther, 100);
  assert.strictEqual(k3.inputCacheRead, 200);
  assert.strictEqual(k3.inputCacheCreationShort, 4);
  assert.strictEqual(k3.inputCacheCreationLong, 6);
  assert.strictEqual(k3.requests, 1);
  const qc = peerRecords.find((r) => r.tool === "qoder-cn-cli");
  assert.strictEqual(qc.credits, 2.5);
});

test("sync: summaryToRecords tolerates empty/broken input", () => {
  assert.deepStrictEqual(sync.summaryToRecords({}), []);
  assert.deepStrictEqual(sync.summaryToRecords({ days: null }), []);
  const out = sync.summaryToRecords({ device: "x", days: { "2026-08-01": { kimi: {} } } });
  assert.deepStrictEqual(out, []);
});

test("sync: buildSummary ignores event-kind records", () => {
  const out = sync.buildSummary("d", [record({ kind: "event", eventName: "WebSearch", inputOther: 0, output: 0 })]);
  assert.deepStrictEqual(out.days, {});
});

test("sync: accumulates every token category across requests", () => {
  const time = new Date(2026, 9, 29, 10, 0).getTime();
  const records = [
    record({ tool: "codex", model: "gpt-5", inputOther: 100, output: 50, inputCacheRead: 200, inputCacheCreation: 10, time }),
    record({ tool: "codex", model: "gpt-5", inputOther: 20, output: 5, inputCacheRead: 40, inputCacheCreation: 2, time: time + 1000 }),
  ];
  const [restored] = sync.summaryToRecords(sync.buildSummary("wsl", records));
  assert.deepStrictEqual({
    inputOther: restored.inputOther,
    output: restored.output,
    inputCacheRead: restored.inputCacheRead,
    inputCacheCreation: restored.inputCacheCreation,
    requests: restored.requests,
  }, {
    inputOther: 120,
    output: 55,
    inputCacheRead: 240,
    inputCacheCreation: 12,
    requests: 2,
  });
});

test("sync: carries codex quota and selects the newest device snapshot", () => {
  const local = { available: true, fetchedAt: "2026-10-29T06:00:00.000Z", windows: [] };
  const wsl = { available: true, fetchedAt: "2026-10-29T07:00:00.000Z", windows: [] };
  const summary = sync.buildSummary("wsl", [], wsl);
  assert.strictEqual(summary.codexQuota, wsl);
  assert.strictEqual(sync.newestCodexQuota(local, [summary]), wsl);
  assert.strictEqual(sync.newestCodexQuota(wsl, [{ codexQuota: local }]), wsl);
  assert.strictEqual(sync.newestCodexQuota(local, [{ device: "old-peer" }]), local);
});
