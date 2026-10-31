"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Isolated DB + bucket dir for this test file (run-tests.js disables the
// store globally; here we opt back in with explicit tmp paths).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dora-store-"));
process.env.DORAMONITOR_DB = path.join(tmp, "test.db");
process.env.DORAMONITOR_BUCKETS_DIR = path.join(tmp, "buckets");

const store = require("../src/store");
const { foldRecordInto, newBucket } = require("../src/buckets");
const { aggregateFromBuckets, aggregate } = require("../src/aggregate");

const HOME = path.join(tmp, "kimi-home");

function rec(overrides = {}) {
  return {
    tool: "kimi-code",
    time: Date.now() - 3600_000,
    model: "k2",
    modelDisplay: "Kimi K2",
    modelResolved: "kimi-k2",
    inputOther: 100,
    output: 50,
    inputCacheRead: 200,
    inputCacheCreation: 25,
    credits: 0,
    project: "D:\\code\\demo",
    session: "s1",
    ...overrides,
  };
}

const RECORDS = [
  rec(),
  rec({ time: Date.now() - 7200_000, model: "gpt-x", modelDisplay: "GPT X", modelResolved: "gpt-x", inputOther: 10, output: 5, project: "" }),
  rec({ time: Date.now() - 2 * 86400_000, inputCacheCreationShort: 30, inputCacheCreationLong: 70, project: "D:\\code\\demo" }),
  rec({ time: Date.now() - 2 * 86400_000, requests: 5, model: "gpt-x", modelResolved: "gpt-x", project: "" }),
];
const EVENTS = [
  { time: Date.now() - 3600_000, eventName: "WebSearch", tool: "kimi-code" },
  { time: Date.now() - 3600_000, eventName: "WebSearch", tool: "kimi-code" },
];

test("store: ingest + bucketView reproduces bucket-fold aggregation", () => {
  assert.ok(store.open(), "store should open on node:sqlite-capable runtime");
  const res = store.ingestTool({ tool: "kimi-code", home: HOME, records: RECORDS, events: EVENTS, force: true });
  assert.ok(res.ok, `ingest ok: ${res.error || ""}`);
  assert.strictEqual(res.rows, 4);

  // Reference: the same records folded the pre-store way.
  const ref = newBucket("(ref)", null);
  for (const r of RECORDS) foldRecordInto(ref, r);

  const viaStore = aggregateFromBuckets([store.bucketView()]);
  const viaFold = aggregateFromBuckets([ref]);
  for (const key of ["requests", "inputOther", "output", "inputCacheRead", "inputCacheCreation", "credits"]) {
    assert.strictEqual(viaStore.totals[key], viaFold.totals[key], `totals.${key}`);
  }
  // Priced equivalently (query-time priceForCell on both paths).
  assert.ok(Math.abs(viaStore.totals.costCny - viaFold.totals.costCny) < 1e-9, "costCny equivalence");
  assert.strictEqual(viaStore.models.length, viaFold.models.length);
  const storeModels = new Map(viaStore.models.map((m) => [m.model, m]));
  for (const m of viaFold.models) {
    const sm = storeModels.get(m.model);
    assert.ok(sm, `model ${m.model} present`);
    assert.strictEqual(sm.totalTokens, m.totalTokens, `model ${m.model} tokens`);
    assert.strictEqual(sm.costCny.toFixed(6), m.costCny.toFixed(6), `model ${m.model} cost`);
  }
});

test("store: unchanged fingerprint skips re-ingestion", () => {
  const first = store.ingestTool({ tool: "kimi-code", home: HOME, records: RECORDS, events: EVENTS });
  assert.strictEqual(first.skipped, true);
  const stats1 = store.stats();
  const changed = [...RECORDS, rec({ time: Date.now() - 60_000, inputOther: 7 })];
  const second = store.ingestTool({ tool: "kimi-code", home: HOME, records: changed, events: EVENTS });
  assert.ok(second.ok && !second.skipped);
  assert.strictEqual(second.rows, 5);
  assert.strictEqual(store.stats().records, stats1.records + 1);
});

test("store: usageQuery totals, workspace split and single-day hourly", () => {
  const q = store.usageQuery({ startDay: null, endDay: null, tool: "all", workspace: "all", model: "all" });
  // 3 local singles + 1 peer-style (requests:5) + 1 changed-row from test 2
  assert.strictEqual(q.totals.requests, 1 + 1 + 1 + 5 + 1);
  // rec() defaults: i+o+cr+cc = 100+50+200+25 = 375
  // RECORDS: 375 + (10+5+200+25=240) + 375 + 375 = 1365; 5th row: 7+50+200+25 = 282
  assert.strictEqual(q.totals.totalTokens, 1365 + 282);
  // Workspace split: D:\code\demo vs unknown
  const ws = new Map(q.workspaces.map((w) => [w.workspaceKey, w]));
  assert.ok(ws.has("D:\\code\\demo"), "cwd workspace present");
  assert.ok(ws.has("__unknown__"), "unknown workspace present");
  const demo = ws.get("D:\\code\\demo");
  assert.strictEqual(demo.totalTokens, 375 + 375 + 282); // r1 + r3 + 5th row (default project)
  assert.strictEqual(ws.get("__unknown__").totalTokens, 240 + 375); // r2 + r4 (empty project)

  // Single-day drill-down fills hourly
  const dayKeyToday = new Date(Date.now() - 3600_000);
  const yyyy = dayKeyToday.getFullYear();
  const mm = String(dayKeyToday.getMonth() + 1).padStart(2, "0");
  const dd = String(dayKeyToday.getDate()).padStart(2, "0");
  const single = store.usageQuery({
    startDay: `${yyyy}-${mm}-${dd}`,
    endDay: `${yyyy}-${mm}-${dd}`,
    singleDay: `${yyyy}-${mm}-${dd}`,
    tool: "all",
    workspace: "all",
    model: "all",
  });
  assert.ok(single.hourly.length > 0, "hourly filled for single day");
  assert.ok(single.hourly.every((h) => h.hour >= 0 && h.hour <= 23));
});

test("store: recordsPage filters and paginates", () => {
  const all = store.recordsPage({ limit: 2, offset: 0, tool: "all", workspace: "all", model: "all" });
  assert.strictEqual(all.rows.length, 2);
  assert.ok(all.total >= 5);
  assert.ok(all.rows[0].time >= all.rows[1].time, "newest first");
  const kimiOnly = store.recordsPage({ tool: "kimi-code", limit: 500, offset: 0, workspace: "all", model: "all" });
  assert.ok(kimiOnly.rows.every((r) => r.tool === "kimi-code"));
  const filtered = store.recordsPage({ tool: "kimi-code", workspace: "D:\\code\\demo", limit: 500, offset: 0, model: "all" });
  assert.ok(filtered.rows.every((r) => r.workspaceKey === "D:\\code\\demo"));
});

test("store: legacy import skips buckets whose source still exists", () => {
  const bucketsDir = process.env.DORAMONITOR_BUCKETS_DIR;
  const toolDir = path.join(bucketsDir, "dsh");
  fs.mkdirSync(toolDir, { recursive: true });

  const mkBucket = (source, day, tokens) => ({
    version: 3,
    tzOffset: new Date().getTimezoneOffset(),
    source,
    stamp: { mtimeMs: 1, size: 1 },
    usageDays: {
      [day]: {
        dsh: {
          "legacy-model": {
            display: "Legacy Model",
            pricingKey: "legacy-model",
            std: { i: tokens, o: 0, cr: 0, cc: 0, req: 2, estReq: 0, credits: 0 },
          },
        },
      },
    },
    eventDays: {},
  });

  // Source that no longer exists → imported.
  const goneDay = "2020-01-01";
  fs.writeFileSync(path.join(toolDir, "aaa.json"), JSON.stringify(mkBucket("sessions/gone/session/wire.jsonl", goneDay, 1000)));
  // Source that still exists → skipped (fresh scan covers it).
  const liveRel = path.join("sessions", "live", "wire.jsonl");
  const liveAbs = path.join(HOME, liveRel);
  fs.mkdirSync(path.dirname(liveAbs), { recursive: true });
  fs.writeFileSync(liveAbs, "{}");
  fs.writeFileSync(path.join(toolDir, "bbb.json"), JSON.stringify(mkBucket(liveRel, "2020-01-02", 5000)));

  const res = store.importLegacyBuckets([{ toolId: "dsh", home: HOME }]);
  assert.ok(res.ok, `legacy import ok: ${res.error || ""}`);
  assert.strictEqual(res.skippedExisting, 1);
  assert.strictEqual(res.missing, 1);

  const view = store.bucketView();
  const days = Object.keys(view.usageDays);
  assert.ok(days.includes(goneDay), "legacy day present in bucketView");
  assert.ok(!days.includes("2020-01-02"), "live-source bucket NOT imported");
  const legacyCell = view.usageDays[goneDay].dsh["legacy-model"].std;
  assert.strictEqual(legacyCell.i, 1000);

  // And the pre-store aggregate path consumes the view unchanged ("all":
  // the legacy day is 2020 — outside the default 30d calendar window).
  const agg = aggregateFromBuckets([view], { range: "all" });
  assert.ok(agg.totals.inputOther >= 1000);
  // aggregate() raw-records path is oblivious to legacy history by design.
  const raw = aggregate([], "all");
  assert.strictEqual(raw.totals.requests, 0);
});

test("store: workspaceOptions lists distinct keys", () => {
  const opts = store.workspaceOptions();
  const keys = new Set(opts.map((o) => o.workspaceKey));
  assert.ok(keys.has("D:\\code\\demo"));
  assert.ok(keys.has("__unknown__"));
});

test("store: migrations apply to the latest version and are idempotent", () => {
  assert.ok(store.open());
  assert.strictEqual(store.schemaVersion(), store.MIGRATIONS.length);
  // Reopen (same process) must not re-run or corrupt anything.
  assert.ok(store.open());
  assert.strictEqual(store.schemaVersion(), store.MIGRATIONS.length);
  assert.strictEqual(store.stats().records > 0, true);
});
