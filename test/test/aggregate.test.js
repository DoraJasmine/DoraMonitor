"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { aggregate, dayKey } = require("../src/aggregate");

function rec(partial) {
  return {
    time: Date.now(),
    model: "m",
    modelDisplay: "m",
    modelResolved: "m",
    inputOther: 100,
    output: 50,
    inputCacheRead: 200,
    inputCacheCreation: 0,
    costUsd: 0.01,
    costEstimated: false,
    priceId: "kimi-k2.6",
    ...partial,
  };
}

describe("aggregate", () => {
  it("sums tokens and hit rate", () => {
    const now = Date.parse("2026-07-26T12:00:00Z");
    const records = [
      rec({
        time: now - 1000,
        inputOther: 100,
        inputCacheRead: 300,
        inputCacheCreation: 0,
        output: 10,
      }),
      rec({
        time: now - 2000,
        inputOther: 100,
        inputCacheRead: 100,
        inputCacheCreation: 0,
        output: 10,
      }),
    ];
    const s = aggregate(records, "all", now);
    assert.equal(s.totals.requests, 2);
    assert.equal(s.totals.inputOther, 200);
    assert.equal(s.totals.inputCacheRead, 400);
    // hit = 400 / (200+400+0) = 2/3
    assert.ok(Math.abs(s.totals.cacheHitRate - 400 / 600) < 1e-9);
  });

  it("filters today", () => {
    const now = Date.parse("2026-07-26T15:00:00+08:00");
    const records = [
      rec({ time: now - 60_000 }),
      rec({ time: now - 3 * 24 * 3600_000 }),
    ];
    const s = aggregate(records, "today", now);
    assert.equal(s.totals.requests, 1);
  });

  it("dayKey formats local date", () => {
    const k = dayKey(Date.parse("2026-07-26T01:00:00Z"));
    assert.match(k, /^\d{4}-\d{2}-\d{2}$/);
  });

  it("builds continuous dailyByModel series", () => {
    const day1 = Date.parse("2026-07-20T12:00:00+08:00");
    const day2 = Date.parse("2026-07-22T12:00:00+08:00");
    const records = [
      rec({
        time: day1,
        model: "a/model-1",
        modelDisplay: "a/model-1",
        inputOther: 1000,
        output: 0,
        inputCacheRead: 0,
      }),
      rec({
        time: day2,
        model: "b/model-2",
        modelDisplay: "b/model-2",
        inputOther: 500,
        output: 0,
        inputCacheRead: 0,
      }),
      rec({
        time: day2,
        model: "a/model-1",
        modelDisplay: "a/model-1",
        inputOther: 200,
        output: 0,
        inputCacheRead: 0,
      }),
    ];
    const s = aggregate(records, "all", day2);
    assert.ok(s.dailyByModel);
    assert.deepEqual(s.dailyByModel.dates, [
      "2026-07-20",
      "2026-07-21",
      "2026-07-22",
    ]);
    // gap day filled with zero total
    assert.equal(s.dailyByModel.totals[1].totalTokens, 0);
    const keys = s.dailyByModel.series.map((x) => x.key);
    assert.ok(keys.includes("a/model-1"));
    assert.ok(keys.includes("b/model-2"));
  });
});
