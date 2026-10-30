"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyQuotaModel, belongsToQuota } = require("../src/quota-models");
const { buildIntervals, estimateWindow, estimateCapacity } = require("../src/quota-estimator");

function record(model, extra = {}) {
  return {
    tool: "codex",
    model,
    modelResolved: model,
    time: Date.parse("2026-10-30T10:01:00Z"),
    inputOther: 100,
    inputCacheRead: 900,
    inputCacheCreation: 0,
    output: 100,
    ...extra,
  };
}

function syntheticInterval(cacheHitRate, index) {
  const input = 1_000_000;
  const dp = 10 * (1 - cacheHitRate) + cacheHitRate;
  return {
    window: "session",
    start: Date.parse("2026-10-01T00:00:00Z") + index * 3600000,
    end: Date.parse("2026-10-01T00:00:00Z") + index * 3600000 + 1000,
    dp,
    durationMs: 1000,
    coverage: "complete",
    totalTokens: input,
    cacheHitRate,
    dominantModelShare: 1,
    models: {
      "gpt-test": {
        inputOther: input * (1 - cacheHitRate),
        inputCacheRead: input * cacheHitRate,
        inputCacheCreation: 0,
        output: 0,
        totalTokens: input,
      },
    },
  };
}

test("quota model classification spans clients and rejects unrelated models", () => {
  assert.equal(classifyQuotaModel(record("gpt-6-astra", { tool: "omp" })).quotaProvider, "openai");
  assert.equal(classifyQuotaModel(record("kimi-k3.1-pro", { tool: "omp" })).quotaProvider, "kimi");
  assert.equal(classifyQuotaModel(record("deepseek-v4", { tool: "kimi-code" })).quotaProvider, null);
  assert.equal(classifyQuotaModel(record("custom-unknown")).reason, "unknown_model");
  assert.equal(belongsToQuota(record("kimi-k3", { tool: "omp" }), "kimi", "kimi-code-only"), false);
  assert.equal(belongsToQuota(record("kimi-k3", { tool: "kimi-code" }), "kimi", "kimi-code-only"), true);
});

test("intervals use increasing milestones and exclude irrelevant models", () => {
  const t0 = Date.parse("2026-10-30T10:00:00Z");
  const samples = [
    { provider: "openai", window: "session", sampledAt: new Date(t0).toISOString(), usedPercent: 10, resetsAt: "r" },
    { provider: "openai", window: "session", sampledAt: new Date(t0 + 30000).toISOString(), usedPercent: 10, resetsAt: "r" },
    { provider: "openai", window: "session", sampledAt: new Date(t0 + 60000).toISOString(), usedPercent: 12, resetsAt: "r" },
  ];
  const records = [
    record("gpt-6", { time: t0 + 20000, inputOther: 100, inputCacheRead: 900, output: 0 }),
    record("deepseek-v4", { time: t0 + 20000, inputOther: 50000, inputCacheRead: 0, output: 0 }),
  ];
  const intervals = buildIntervals({ samples, records, provider: "openai", window: "session" });
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].dp, 2);
  assert.equal(intervals[0].totalTokens, 1000);
  assert.equal(intervals[0].cacheHitRate, 0.9);
});

test("reset and pending coverage do not contaminate estimates", () => {
  const t0 = Date.parse("2026-10-30T10:00:00Z");
  const samples = [10, 12, 20, 22].map((usedPercent, i) => ({
    provider: "openai", window: "session", sampledAt: new Date(t0 + i * 60000).toISOString(), usedPercent, resetsAt: i < 2 ? "a" : "b",
  }));
  const records = [1, 2, 3].map((i) => record("gpt-6", { time: t0 + i * 60000 - 1000 }));
  const intervals = buildIntervals({ samples, records, provider: "openai", window: "session", isComplete: () => false });
  assert.equal(intervals.length, 2);
  const estimated = estimateWindow(intervals);
  assert.ok(estimated.targets.every((target) => target.confidence === "insufficient"));
});

test("component fit converts 85/90/95/98 percent cache targets", () => {
  const intervals = [0.8, 0.82, 0.85, 0.88, 0.9, 0.92, 0.94, 0.95, 0.96, 0.97, 0.98, 0.99].map(syntheticInterval);
  const result = estimateWindow(intervals, { now: Date.parse("2026-10-02T00:00:00Z") });
  for (const target of result.targets) {
    const expected = 100_000_000 / (10 - 9 * target.cacheHitRate);
    assert.ok(Math.abs(target.fullWindowTokens - expected) / expected < 0.001, `${target.cacheHitRate}: ${target.fullWindowTokens} != ${expected}`);
    assert.ok(target.confidenceScore > 0 && target.confidenceScore <= 100);
  }
  assert.equal(result.targets[0].method, "interpolated");
  assert.equal(result.targets[0].confidence, "high");
});

test("sparse observations use nearby cache samples instead of fabricated values", () => {
  const first = syntheticInterval(0.95, 0);
  const second = syntheticInterval(0.951, 1);
  const result = estimateWindow([first, second], { now: Date.parse("2026-10-02T00:00:00Z") });
  assert.equal(result.targets.find((target) => target.cacheHitRate === 0.95).method, "local");
  assert.equal(result.targets.find((target) => target.cacheHitRate === 0.85).confidence, "insufficient");
});

test("price prior provides clearly marked sparse estimates in tokens and CNY", () => {
  const { costForUsage } = require("../src/pricing");
  const interval = syntheticInterval(0.9, 0);
  const usage = interval.models["gpt-test"];
  delete interval.models["gpt-test"];
  interval.models["gpt-5.6-sol"] = usage;
  interval.costCny = costForUsage("gpt-5.6-sol", usage, { skipSettings: true }).total;
  usage.costCny = interval.costCny;
  const result = estimateWindow([interval], { settings: { fxRate: 6.67, customPrices: [] } });
  const local = result.targets.find((target) => target.cacheHitRate === 0.9);
  const extrapolated = result.targets.find((target) => target.cacheHitRate === 0.98);
  assert.equal(local.method, "local");
  assert.equal(extrapolated.method, "extrapolated");
  assert.equal(extrapolated.confidence, "low");
  assert.ok(extrapolated.fullWindowTokens > local.fullWindowTokens);
  assert.equal(extrapolated.fullWindowCostCny, local.fullWindowCostCny);
  assert.ok(extrapolated.confidenceReasons.includes("cache_extrapolation"));
});

test("cost-based conversion includes uncached input, cache read, cache write and output", () => {
  const { costForUsage } = require("../src/pricing");
  const usage = { inputOther: 50, inputCacheRead: 900, inputCacheCreation: 50, output: 100, totalTokens: 1100 };
  const costCny = costForUsage("gpt-5.6-sol", usage, { skipSettings: true }).total;
  usage.costCny = costCny;
  const interval = {
    ...syntheticInterval(0.9, 0),
    dp: 2,
    totalTokens: usage.totalTokens,
    costCny,
    models: { "gpt-5.6-sol": usage },
  };
  const result = estimateWindow([interval], { settings: { fxRate: 6.67, customPrices: [] } });
  const target = result.targets.find((item) => item.cacheHitRate === 0.9);
  assert.ok(Math.abs(target.fullWindowTokens - 55_000) < 1);
  assert.equal(target.fullWindowCostCny, costCny * 50);
});

test("capacity response always contains both windows and four targets", () => {
  const result = estimateCapacity({ samples: [], records: [], provider: "kimi" });
  assert.equal(result.targets.length, 8);
  assert.deepEqual([...new Set(result.targets.map((target) => target.window))], ["session", "weekly"]);
});

test("long-term estimates use durable automatic intervals and ignore manual anchors", () => {
  const t0 = Date.parse("2026-10-30T10:00:00Z");
  const samples = [10, 12, 14, 16].map((usedPercent, index) => ({
    provider: "openai", accountKey: "openai:test", window: "session", usedPercent,
    sampledAt: new Date(t0 + index * 3600000).toISOString(), resetsAt: "r", source: "wham",
  }));
  const records = [1, 2, 3].map((index) => record("gpt-6", { time: t0 + index * 3600000 - 1800000, costCny: 1 }));
  const options = { provider: "openai", accountKey: "openai:test", records, now: t0 + 4 * 3600000 };
  const base = estimateCapacity({ ...options, samples });
  const withManual = estimateCapacity({ ...options, samples: [...samples, { ...samples[3], sampledAt: new Date(t0 + 4 * 3600000).toISOString(), usedPercent: 30, source: "manual-calibration" }] });
  const longTargets = base.longTermTargets.filter((target) => target.window === "session");
  assert.equal(longTargets.length, 4);
  assert.ok(longTargets.every((target) => Number.isFinite(target.fullWindowTokens)));
  assert.ok(longTargets.every((target) => target.estimateKind === "long-term" && target.sampleCount === 3));
  assert.deepEqual(withManual.longTermTargets, base.longTermTargets);
});
