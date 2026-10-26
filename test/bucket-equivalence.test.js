"use strict";

/**
 * Phase-3 equivalence guard: the day-bucket aggregation path must reproduce
 * the original per-record aggregation for every shape it replaces —
 * totals / daily / models (aggregate), heatmap (buildHeatmap),
 * per-tool rows (aggregateByTool) and tool-call events
 * (aggregateToolEvents) — for the ranges whose semantics are unchanged
 * (today, all). 7d/30d are calendar-day windows on the bucket path by
 * design (docs/plan-phase3-day-bucket.md §5); they are asserted as a
 * superset of the rolling window instead of equality.
 */

const test = require("node:test");
const assert = require("node:assert");
const {
  aggregate,
  aggregateByTool,
  aggregateToolEvents,
  buildHeatmap,
  aggregateFromBuckets,
  buildHeatmapFromDaily,
  toolEventsFromBuckets,
  byToolFromBuckets,
  dayKey,
} = require("../src/aggregate");
const { bucketFromRecords, mergeBuckets } = require("../src/buckets");
const { toolMeta, emptyRecord } = require("../src/providers/base");
const { costForUsage } = require("../src/pricing");

const EPS = 1e-9;

/** Deterministic pseudo-random generator so failures replay exactly. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildCorpus(seed) {
  const rnd = mulberry32(seed);
  const randInt = (min, max) => Math.floor(min + rnd() * (max - min + 1));
  const now = new Date(2026, 9, 24, 18, 0, 0).getTime();
  const modelsByTool = {
    "kimi-code": ["kimi-k3.1-pro", "kimi-k2.6", "kimi-for-coding"],
    codex: ["gpt-6-sol", "gpt-5.6-luna"],
    dsh: ["dfmodel", "dmodel"],
    zcode: ["GLM-5.3-Flash"],
    "qoder-cn-cli": ["qfmodel"],
  };
  const records = [];
  const events = [];
  const times = [
    now - randInt(0, 3) * 3600_000,             // today
    now - randInt(1, 25) * 3600_000,            // yesterday-ish
    now - randInt(2, 20) * 24 * 3600_000,       // this month
    now - randInt(40, 300) * 24 * 3600_000,     // deep history
    0,                                          // no timestamp
  ];
  for (const [tool, models] of Object.entries(modelsByTool)) {
    for (const model of models) {
      const count = randInt(3, 12);
      for (let i = 0; i < count; i++) {
        const rec = emptyRecord(tool);
        rec.time = times[randInt(0, times.length - 1)];
        rec.model = model;
        rec.modelDisplay = model.toUpperCase();
        rec.modelResolved = model === "dfmodel" ? "deepseek-flash" : model === "dmodel" ? "deepseek-v4-pro" : model === "kimi-for-coding" ? "kimi-k2.7-code" : model === "qfmodel" ? "qwen3.8-flash" : model;
        rec.inputOther = randInt(0, 400_000);
        rec.output = randInt(0, 60_000);
        rec.inputCacheRead = randInt(0, 400_000);
        rec.inputCacheCreation = randInt(0, 20_000);
        // DeepSeek records: time-of-use matters; keep the cost fields that
        // the fold consumes (rateKeyFor derives from tokens+time).
        rec.credits = tool === "qoder-cn-cli" ? randInt(1, 50) : 0;
        if (rec.credits > 0) {
          rec.inputOther = rec.output = rec.inputCacheRead = rec.inputCacheCreation = 0;
        }
        // Providers price records at parse time — the corpus must too, or
        // the record path carries zero cost against the bucket path's
        // query-time pricing.
        const cost = costForUsage(rec.modelResolved || rec.model, rec, { settings: { fxRate: 7.2, customPrices: [] } });
        rec.costCny = rec.credits > 0 ? 0 : cost.total;
        rec.costEstimated = cost.estimated;
        rec.priceId = cost.priceId;
        records.push(rec);
      }
    }
    if (tool === "kimi-code") {
      for (let i = 0; i < randInt(2, 8); i++) {
        const ev = emptyRecord(tool);
        ev.time = times[randInt(0, 3)];
        ev.eventName = rnd() > 0.5 ? "WebSearch" : "FetchURL";
        ev.kind = "event";
        events.push(ev);
      }
    }
  }
  return { records, events, now };
}

function bucketsFromCorpus(records, events, now) {
  // One bucket per (tool, model) group — merge order irrelevance is
  // separately asserted below.
  const groups = new Map();
  for (const rec of records) {
    const key = `${rec.tool}\u0000${rec.model}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rec);
  }
  const buckets = [];
  for (const [, recs] of groups) {
    buckets.push(bucketFromRecords(recs, [], "fixture", null));
  }
  buckets.push(bucketFromRecords([], events, "fixture-events", null));
  return buckets;
}

function stripModels(rows) {
  return rows.map((m) => ({
    tool: m.tool,
    model: m.model,
    requests: m.requests,
    inputOther: m.inputOther,
    output: m.output,
    inputCacheRead: m.inputCacheRead,
    inputCacheCreation: m.inputCacheCreation,
    totalTokens: m.totalTokens,
    credits: m.credits,
    // Summation order differs between per-record and per-cell addition;
    // quantize to the equivalence tolerance instead of exact equality.
    costCny: Math.round(m.costCny * 1e9),
    costEstimated: m.costEstimated,
    cacheHitRate: Math.round(m.cacheHitRate * 1e9),
  }));
}

function stripDaily(rows) {
  return rows.map((d) => ({
    date: d.date,
    requests: d.requests,
    inputOther: d.inputOther,
    output: d.output,
    inputCacheRead: d.inputCacheRead,
    inputCacheCreation: d.inputCacheCreation,
    totalTokens: d.totalTokens,
    credits: d.credits,
    costCny: Math.round(d.costCny * 1e9),
  }));
}

function close(a, b, eps = EPS) {
  return Math.abs(a - b) <= eps;
}

for (const seed of [1, 2, 3, 4, 5]) {
  test(`bucket equivalence (seed ${seed}): today/all totals, daily, models`, () => {
    const { records, events, now } = buildCorpus(seed);
    const buckets = bucketsFromCorpus(records, events, now);
    for (const range of ["today", "all"]) {
      const a = aggregate(records, range, now, "all");
      const b = aggregateFromBuckets(buckets, { range, nowMs: now, tool: "all", fxRate: 7.2, customPrices: [] });
      assert.ok(close(a.totals.totalTokens, b.totals.totalTokens, 1e-6), `tokens ${a.totals.totalTokens} vs ${b.totals.totalTokens}`);
      assert.ok(close(a.totals.costCny, b.totals.costCny, 1e-7), `cost ${a.totals.costCny} vs ${b.totals.costCny}`);
      assert.equal(a.totals.requests, b.totals.requests, "requests");
      assert.equal(a.totals.credits, b.totals.credits, "credits");
      // The top-level hit rate is what the KPI card renders — it regressed
      // to undefined (displayed as 0.0%) when the bucket path shipped.
      assert.ok(close(a.totals.cacheHitRate ?? 0, b.totals.cacheHitRate ?? -1, 1e-9), "totals.cacheHitRate");
      assert.deepEqual(stripDaily(a.daily), stripDaily(b.daily));
      assert.deepEqual(stripModels(a.models), stripModels(b.models));
    }
  });

  test(`bucket equivalence (seed ${seed}): heatmap, byTool, toolEvents`, () => {
    const { records, events, now } = buildCorpus(seed);
    const buckets = bucketsFromCorpus(records, events, now);
    const aggAll = aggregateFromBuckets(buckets, { range: "all", nowMs: now, tool: "all", fxRate: 7.2 });

    const h1 = buildHeatmap(records, now, 53, "all");
    const h2 = buildHeatmapFromDaily(new Map(aggAll.daily.map((d) => [d.date, d])), now, 53);
    assert.equal(h1.cells.length, h2.cells.length);
    for (let i = 0; i < h1.cells.length; i++) {
      assert.equal(h1.cells[i].date, h2.cells[i].date);
      assert.equal(h1.cells[i].level, h2.cells[i].level, `level ${h1.cells[i].date}`);
      assert.equal(h1.cells[i].requests, h2.cells[i].requests);
      assert.ok(close(h1.cells[i].totalTokens, h2.cells[i].totalTokens, 1));
      assert.ok(close(h1.cells[i].costCny, h2.cells[i].costCny, 1e-7));
    }

    const bt1 = aggregateByTool(records, "all", toolMeta, now);
    const bt2 = byToolFromBuckets(buckets, "all", toolMeta, now, { fxRate: 7.2 });
    assert.deepEqual(
      bt1.map((r) => ({ id: r.id, requests: r.requests, totalTokens: r.totalTokens, credits: r.credits })),
      bt2.map((r) => ({ id: r.id, requests: r.requests, totalTokens: r.totalTokens, credits: r.credits }))
    );
    for (let i = 0; i < bt1.length; i++) {
      assert.ok(close(bt1[i].costCny, bt2[i].costCny, 1e-7), `byTool cost ${bt1[i].id}`);
    }

    const merged = mergeBuckets(buckets);
    for (const range of ["today", "all"]) {
      const e1 = aggregateToolEvents(events, range, now, "all");
      const e2 = toolEventsFromBuckets(merged.eventDays, range, now, "all");
      assert.deepEqual(e1, e2, `toolEvents ${range}`);
    }
  });
}

test("bucket equivalence: 7d/30d bucket path is a superset of the rolling window", () => {
  const { records, events, now } = buildCorpus(99);
  const buckets = bucketsFromCorpus(records, events, now);
  for (const range of ["7d", "30d"]) {
    const rolling = aggregate(records, range, now, "all");
    const calendar = aggregateFromBuckets(buckets, { range, nowMs: now, tool: "all", fxRate: 7.2, customPrices: [] });
    // The calendar window (last N local days incl. today) always covers the
    // rolling N*24h window ending now, plus up to ~half a day extra.
    assert.ok(calendar.totals.totalTokens >= rolling.totals.totalTokens - 1e-6);
    assert.ok(calendar.totals.requests >= rolling.totals.requests);
    assert.ok(calendar.totals.totalTokens - rolling.totals.totalTokens <= rolling.totals.totalTokens + 1);
  }
});

test("bucket equivalence: merge order is irrelevant", () => {
  const { records, events, now } = buildCorpus(7);
  const buckets = bucketsFromCorpus(records, events, now);
  const forward = aggregateFromBuckets(buckets, { range: "all", nowMs: now, fxRate: 7.2 });
  const reversed = aggregateFromBuckets([...buckets].reverse(), { range: "all", nowMs: now, fxRate: 7.2 });
  assert.ok(close(forward.totals.costCny, reversed.totals.costCny));
  assert.equal(forward.totals.totalTokens, reversed.totals.totalTokens);
  assert.deepEqual(stripModels(forward.models), stripModels(reversed.models));
});
