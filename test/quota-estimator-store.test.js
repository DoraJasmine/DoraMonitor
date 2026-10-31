"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  samplesFromQuota,
  appendSamples,
  readSamples,
  getOrComputeCapacity,
  readHistory,
} = require("../src/quota-estimator-store");
const { buildSummary, quotaUsageRecords } = require("../src/sync");

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dora-quota-store-"));
}

function capacity(now, tokens, confidence = "high", method = "interpolated") {
  return {
    provider: "openai",
    accountKey: "openai:test",
    usageScope: "all-clients",
    generatedAt: new Date(now).toISOString(),
    targets: [{
      window: "session",
      cacheHitRate: 0.95,
      fullWindowTokens: tokens,
      fullWindowCostCny: tokens / 100000,
      sampleCount: 5,
      percentSpan: 6,
      coverage: "complete",
      confidence,
      confidenceScore: 90,
      method,
      dataRange: { start: new Date(now - 3600000).toISOString(), end: new Date(now).toISOString() },
    }],
  };
}

test("quota samples persist and deduplicate by source timestamp", () => {
  const root = tmpRoot();
  const quota = {
    available: true,
    accountKey: "openai:test",
    fetchedAt: new Date().toISOString(),
    windows: [{ kind: "session", usedPercent: 42, resetsAt: null }],
  };
  const samples = samplesFromQuota(quota, "openai", "test");
  appendSamples(samples, root);
  appendSamples(samples, root);
  const restored = readSamples(root);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].usedPercent, 42);
});

test("quota samples preserve fractional percentages when a provider supplies them", () => {
  const root = tmpRoot();
  const samples = samplesFromQuota({
    available: true,
    accountKey: "openai:test",
    windows: [{ kind: "session", usedPercent: 42.75, resetsAt: null }],
  }, "openai", "test");
  appendSamples(samples, root);
  assert.equal(readSamples(root)[0].usedPercent, 42.75);
});

test("sample compaction physically removes expired and duplicate records", () => {
  const root = tmpRoot();
  const now = Date.now();
  const current = { provider: "openai", accountKey: "openai:test", window: "session", usedPercent: 11, sampledAt: new Date(now).toISOString(), source: "test" };
  appendSamples([{ ...current, usedPercent: 10, sampledAt: new Date(now - 91 * 86400000).toISOString() }], root, now);
  appendSamples([current], root, now);
  appendSamples([current], root, now + 86400000);
  const lines = fs.readFileSync(path.join(root, "samples.jsonl"), "utf8").trim().split(/\r?\n/);
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).usedPercent, 11);
});

test("quota sample history pages newest first and can hide repeated percentages", () => {
  const root = tmpRoot();
  const samples = [10, 10, 11].map((usedPercent, index) => ({
    provider: "openai", accountKey: "openai:test", window: "session", usedPercent,
    sampledAt: new Date(Date.now() - (3 - index) * 60000).toISOString(), resetsAt: "r", source: "test",
  }));
  appendSamples(samples, root);
  const { readSamplePage } = require("../src/quota-estimator-store");
  assert.equal(readSamplePage({ provider: "openai" }, root).total, 3);
  const changed = readSamplePage({ provider: "openai", changesOnly: true }, root);
  assert.equal(changed.total, 2);
  assert.deepEqual(changed.samples.map((sample) => sample.usedPercent), [11, 10]);
});

test("sync shares only recent quota milestones and manual anchors", () => {
  const { quotaSamplesForSync } = require("../src/sync");
  const now = Date.now();
  const samples = [
    { provider: "kimi", accountKey: "kimi:default", window: "weekly", sampledAt: new Date(now - 40 * 86400000).toISOString(), usedPercent: 1, resetsAt: "old", source: "api" },
    { provider: "kimi", accountKey: "kimi:default", window: "weekly", sampledAt: new Date(now - 300000).toISOString(), usedPercent: 10, resetsAt: "r", source: "api" },
    { provider: "kimi", accountKey: "kimi:default", window: "weekly", sampledAt: new Date(now - 240000).toISOString(), usedPercent: 10, resetsAt: "r", source: "api" },
    { provider: "kimi", accountKey: "kimi:default", window: "weekly", sampledAt: new Date(now - 180000).toISOString(), usedPercent: 11, resetsAt: "r", source: "api" },
    { provider: "kimi", accountKey: "kimi:default", window: "weekly", sampledAt: new Date(now - 120000).toISOString(), usedPercent: 11, resetsAt: "r", source: "manual-calibration" },
  ];
  const shared = quotaSamplesForSync(samples, now);
  assert.deepEqual(shared.map((sample) => sample.usedPercent), [10, 11, 11]);
  assert.equal(shared.at(-1).source, "manual-calibration");
});

test("capacity cache retains complete history, time links and accepted maxima", () => {
  const root = tmpRoot();
  let now = Date.now();
  let calls = 0;
  const compute = () => {
    calls += 1;
    return capacity(now, 1_000_000 + calls * 1000);
  };
  const options = { provider: "openai", accountKey: "openai:test", usageScope: "all-clients", root, calculation: { trigger: "scheduled" } };
  getOrComputeCapacity({ ...options, compute, now });
  getOrComputeCapacity({ ...options, compute, now: now + 1000 });
  assert.equal(calls, 1);

  for (let i = 0; i < 35; i += 1) {
    now += 6 * 3600000 + 1;
    getOrComputeCapacity({ ...options, compute, now });
  }
  const query = { provider: "openai", accountKey: "openai:test", usageScope: "all-clients" };
  const history = readHistory(query, root);
  assert.equal(history.length, 36);
  assert.equal(history[1].previousCalculationEndAt, history[0].calculationEndAt);
  assert.equal(history[1].calculationStartAt, history[0].calculationEndAt);
  const { readHistoryPage } = require("../src/quota-estimator-store");
  const page = readHistoryPage({ ...query, limit: 10, offset: 30 }, root);
  assert.equal(page.total, 36);
  assert.equal(page.history.length, 6);
  assert.equal(page.history.at(-1).createdAt, history[0].createdAt);
  assert.equal(readHistoryPage({ ...query, limit: 1 }, root).history[0].createdAt, history.at(-1).createdAt);
  const result = getOrComputeCapacity({ ...options, compute, now });
  assert.ok(result.maxima[0].fullWindowTokens > 1_000_000);
  assert.ok(result.maxima[0].fullWindowCostCny > 0);

  const before = result.maxima[0].fullWindowTokens;
  now += 6 * 3600000 + 1;
  const rejected = getOrComputeCapacity({
    ...options,
    now,
    force: true,
    compute: () => capacity(now, before * 100, "low", "extrapolated"),
  });
  assert.equal(rejected.maxima[0].fullWindowTokens, before);
});

test("every real recalculation is appended even when the estimate is unchanged", () => {
  const root = tmpRoot();
  const now = Date.now();
  const options = { provider: "openai", accountKey: "openai:test", usageScope: "all-clients", root, calculation: { trigger: "scheduled" }, force: true };
  getOrComputeCapacity({ ...options, now, compute: () => capacity(now, 1_000_000) });
  getOrComputeCapacity({ ...options, now: now + 1000, compute: () => capacity(now + 1000, 1_000_000) });
  assert.equal(readHistory({ provider: "openai" }, root).length, 2);
});

test("history can select the newest estimate meeting a minimum confidence score", () => {
  const { readHistoryPage } = require("../src/quota-estimator-store");
  const root = tmpRoot();
  const now = Date.now();
  const options = { provider: "openai", accountKey: "openai:test", usageScope: "all-clients", root, calculation: { trigger: "scheduled", window: "session", estimateKind: "standard" }, force: true };
  for (const [offset, score, tokens] of [[0, 97, 1_000_000], [1000, 85, 2_000_000], [2000, 96, 3_000_000]]) {
    const computed = capacity(now + offset, tokens);
    computed.targets[0].confidenceScore = score;
    getOrComputeCapacity({ ...options, now: now + offset, compute: () => computed });
  }
  const page = readHistoryPage({ provider: "openai", accountKey: "openai:test", usageScope: "all-clients", window: "session", estimateKind: "standard", cacheHitRate: 0.95, minConfidenceScore: 95, limit: 1 }, root);
  assert.equal(page.total, 2);
  assert.equal(page.history.length, 1);
  assert.equal(page.history[0].confidenceScore, 96);
  assert.equal(page.history[0].fullWindowTokens, 3_000_000);
});

test("an old algorithm version cannot reuse a fresh persisted cache", () => {
  const { ALGORITHM_VERSION } = require("../src/quota-estimator");
  const root = tmpRoot();
  const now = Date.now();
  const options = { provider: "openai", accountKey: "openai:test", usageScope: "all-clients", root, calculation: { trigger: "scheduled" }, algorithmVersion: ALGORITHM_VERSION };
  let calls = 0;
  getOrComputeCapacity({ ...options, now, compute: () => ({ ...capacity(now, 1_000_000), algorithmVersion: ALGORITHM_VERSION - 1 }) });
  const result = getOrComputeCapacity({ ...options, now: now + 1000, compute: () => { calls += 1; return capacity(now + 1000, 1_100_000); } });
  assert.equal(calls, 1);
  assert.equal(result.algorithmVersion, ALGORITHM_VERSION);
  getOrComputeCapacity({ ...options, now: now + 2000, compute: () => { calls += 1; return capacity(now + 2000, 1_200_000); } });
  assert.equal(calls, 1);
});

test("unchanged scheduled targets do not append empty history batches", () => {
  const root = tmpRoot();
  const now = Date.now();
  const options = { provider: "openai", accountKey: "openai:test", usageScope: "all-clients", root, calculation: { trigger: "scheduled" }, force: true };
  const first = capacity(now, 1_000_000);
  getOrComputeCapacity({ ...options, now, compute: () => first });
  getOrComputeCapacity({ ...options, now: now + 1000, compute: () => ({ ...first, generatedAt: new Date(now + 1000).toISOString() }) });
  assert.equal(readHistory({ provider: "openai" }, root).length, 1);
});

test("history writes are scoped by window and estimate kind, and passive reads write none", () => {
  const root = tmpRoot();
  const now = Date.now();
  const computed = capacity(now, 1_000_000);
  computed.longTermTargets = [{ ...computed.targets[0], window: "weekly", estimateKind: "long-term" }];
  const options = { provider: "openai", accountKey: "openai:test", usageScope: "all-clients", root, force: true };
  getOrComputeCapacity({ ...options, now, compute: () => computed });
  assert.equal(readHistory({}, root).length, 0);

  getOrComputeCapacity({ ...options, now: now + 1000, calculation: { trigger: "scheduled", window: "session", estimateKind: "standard" }, compute: () => computed });
  getOrComputeCapacity({ ...options, now: now + 2000, calculation: { trigger: "scheduled", window: "weekly", estimateKind: "long-term" }, compute: () => computed });
  const history = readHistory({}, root);
  assert.equal(history.length, 2);
  assert.deepEqual(history.map((item) => [item.window, item.estimateKind || "standard"]), [["session", "standard"], ["weekly", "long-term"]]);
});

test("history reconstructs missing interval usage and model cache details", () => {
  const { getCapacityHistory } = require("../src/quota-capacity");
  const root = tmpRoot();
  const now = Date.now();
  const start = now - 3600000;
  appendSamples([
    { provider: "openai", accountKey: "openai:test", window: "session", sampledAt: new Date(start).toISOString(), usedPercent: 10, resetsAt: "r", source: "test" },
    { provider: "openai", accountKey: "openai:test", window: "session", sampledAt: new Date(now).toISOString(), usedPercent: 12, resetsAt: "r", source: "test" },
  ], root);
  getOrComputeCapacity({
    provider: "openai", accountKey: "openai:test", usageScope: "all-clients", root, now, force: true,
    calculation: { trigger: "scheduled" },
    compute: () => capacity(now, 1_000_000),
  });
  const records = [{
    tool: "codex", model: "gpt-6", modelResolved: "gpt-6", time: start + 1800000,
    inputOther: 100, inputCacheRead: 900, inputCacheCreation: 0, output: 100, costCny: 2,
  }];
  const page = getCapacityHistory({ provider: "openai", accountKey: "openai:test", usageScope: "all-clients", window: "session" }, root, { collected: { records }, peers: [] });
  const [observation] = page.history[0].observations;
  assert.equal(observation.totalTokens, 1100);
  assert.equal(observation.costCny, 2);
  assert.equal(observation.dp, 2);
  assert.equal(observation.cacheHitRate, 0.9);
  assert.equal(observation.models["gpt-6"].totalTokens, 1100);
  assert.equal(observation.models["gpt-6"].inputCacheRead, 900);
});

test("sync minute bins preserve model identity without changing daily totals", () => {
  const time = Date.parse("2026-10-30T10:00:20Z");
  const records = [
    { tool: "omp", model: "gpt-6", modelResolved: "gpt-6", modelProvider: "openai", time, inputOther: 10, inputCacheRead: 90, inputCacheCreation: 0, output: 5, costCny: 1.25, project: "private" },
    { tool: "omp", model: "gpt-6", modelResolved: "gpt-6", modelProvider: "openai", time: time + 1000, inputOther: 20, inputCacheRead: 80, inputCacheCreation: 0, output: 5, costCny: 0.75 },
  ];
  const summary = buildSummary("wsl", records);
  assert.equal(summary.quotaUsage.length, 1);
  assert.equal(summary.days["2026-10-30"].omp["gpt-6"].i, 30);
  const [restored] = quotaUsageRecords(summary);
  assert.equal(restored.time, Date.parse("2026-10-30T10:00:00Z"));
  assert.equal(restored.inputCacheRead, 170);
  assert.equal(restored.costCny, 2);
  assert.equal(restored.modelProvider, "openai");
  assert.equal(restored.project, undefined);
  assert.ok(summary.usageWaterMark);
});

test("Kimi estimation scope setting accepts booleans only", () => {
  const { sanitizeSettings } = require("../src/settings");
  assert.equal(sanitizeSettings({}).quotaEstimation.kimiCodeOnly, false);
  assert.equal(sanitizeSettings({ quotaEstimation: { kimiCodeOnly: true } }).quotaEstimation.kimiCodeOnly, true);
  assert.equal(sanitizeSettings({ quotaEstimation: { kimiCodeOnly: "true" } }).quotaEstimation.kimiCodeOnly, false);
  assert.equal(sanitizeSettings({ quotaEstimation: { codexOnly: true } }).quotaEstimation.codexOnly, true);
  assert.equal(sanitizeSettings({ quotaEstimation: { codexOnly: "true" } }).quotaEstimation.codexOnly, false);
});

test("peer coverage distinguishes complete, pending and stale provisional data", () => {
  const { peerCoverage } = require("../src/quota-capacity");
  const now = Date.parse("2026-10-30T12:00:00Z");
  const start = now - 3600000;
  const end = now - 60000;
  const fresh = { generatedAt: new Date(now - 1000).toISOString(), usageWaterMark: new Date(now).toISOString(), quotaUsage: [] };
  assert.equal(peerCoverage([fresh], start, end, true, now), "complete");
  assert.equal(peerCoverage([{ ...fresh, usageWaterMark: new Date(end - 1).toISOString() }], start, end, true, now), "pending");
  assert.equal(peerCoverage([{ ...fresh, generatedAt: new Date(now - 25 * 3600000).toISOString() }], start, end, true, now), "provisional");
  // Legacy peer summaries without quota fields contribute no quota data and are skipped.
  assert.equal(peerCoverage([{ generatedAt: new Date(now - 1000).toISOString(), days: {} }], start, end, true, now), "complete");
  // Partial snapshots that carry quota usage but a broken watermark stay provisional.
  assert.equal(peerCoverage([{ generatedAt: new Date(now - 1000).toISOString(), days: {}, quotaUsage: [] }], start, end, true, now), "provisional");
  assert.equal(peerCoverage([], start, end, false, now), "complete");
});
