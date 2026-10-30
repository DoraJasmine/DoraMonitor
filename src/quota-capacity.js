"use strict";

const { collect } = require("./collect");
const { loadSettings } = require("./settings");
const { loadCachedPeers, quotaUsageRecords, syncEnabled } = require("./sync");
const { estimateCapacity, buildIntervals } = require("./quota-estimator");
const { readSamples, readSamplePage, getOrComputeCapacity, readHistoryPage } = require("./quota-estimator-store");
const { normalizeQuotaRecord } = require("./quota-schema");

function peerCoverage(peers, start, end, enabled, now) {
  if (!enabled || !peers.length) return "complete";
  let result = "complete";
  for (const peer of peers) {
    const generatedAt = Date.parse(peer.generatedAt || "");
    const waterMark = Date.parse(peer.usageWaterMark || "");
    const stale = !Number.isFinite(generatedAt) || now - generatedAt > 24 * 3_600_000;
    if (stale) {
      if (result === "complete") result = "provisional";
      continue;
    }
    if (!Array.isArray(peer.quotaUsage) || !Number.isFinite(waterMark)) {
      // Legacy peer summaries (before quotaUsage/usageWaterMark existed) carry no
      // quota samples or usage records, so they cannot contribute coverage data;
      // skip them instead of permanently downgrading every interval.
      if (Array.isArray(peer.quotaUsage) || peer.quotaSamples || Number.isFinite(waterMark)) {
        if (result === "complete") result = "provisional";
      }
      continue;
    }
    if (waterMark < end) return "pending";
  }
  return result;
}

function getCapacityForProvider({ provider, accountKey, usageScope = "all-clients", force = false, collected, peers, root, now = Date.now(), calculation = null }) {
  const settings = loadSettings();
  const synced = peers === undefined && syncEnabled(settings);
  const peerList = peers || (synced ? loadCachedPeers() : []);
  const snapshot = collected || collect();
  const records = [...snapshot.records];
  const samples = new Map();
  for (const sample of readSamples(root, now)) samples.set([sample.provider, sample.accountKey, sample.window, sample.sampledAt, sample.source].join("\0"), sample);
  for (const peer of peerList) {
    records.push(...quotaUsageRecords(peer));
    for (const rawSample of peer.quotaSamples || []) {
      const sample = normalizeQuotaRecord(rawSample, { includeLegacy: true });
      samples.set([sample.provider, sample.accountKey, sample.window, sample.sampledAt, sample.source].join("\0"), sample);
    }
  }
  const resolvedAccount = accountKey || `${provider}:default`;
  return getOrComputeCapacity({
    provider,
    accountKey: resolvedAccount,
    usageScope,
    force,
    root,
    now,
    calculation,
    compute: () => estimateCapacity({
      samples: [...samples.values()],
      records,
      provider,
      accountKey: resolvedAccount,
      usageScope,
      now,
      settings,
      isComplete: (start, end) => peerCoverage(peerList, start, end, synced || peerList.length > 0, now),
    }),
  });
}

function getCapacityHistory(query, root, { collected, peers } = {}) {
  const page = readHistoryPage(query, root);
  if (!page.history.some((item) => !Array.isArray(item.observations) || !item.observations.length)) return page;

  const settings = loadSettings();
  const peerList = peers || (syncEnabled(settings) ? loadCachedPeers() : []);
  const snapshot = collected || collect();
  const records = [...snapshot.records, ...peerList.flatMap(quotaUsageRecords)];
  const samples = new Map();
  for (const sample of readSamples(root)) {
    samples.set([sample.provider, sample.accountKey, sample.window, sample.sampledAt, sample.source].join("\0"), sample);
  }
  for (const peer of peerList) {
    for (const rawSample of peer.quotaSamples || []) {
      const sample = normalizeQuotaRecord(rawSample, { includeLegacy: true });
      samples.set([sample.provider, sample.accountKey, sample.window, sample.sampledAt, sample.source].join("\0"), sample);
    }
  }

  const reconstructed = new Map();
  page.history = page.history.map((item) => {
    if (Array.isArray(item.observations) && item.observations.length) return item;
    // The chained calculationStartAt (previous run's end) sits inside the data
    // window and would collapse reconstruction to a single instant; rebuild
    // from the item's own data range instead.
    const start = Date.parse(item.dataRange?.start || item.calculationStartAt || "");
    const end = Date.parse(item.dataRange?.end || item.calculationEndAt || "");
    const key = `${start}:${end}`;
    if (!reconstructed.has(key)) {
      const intervalSamples = [...samples.values()].filter((sample) => {
        const time = Date.parse(sample.sampledAt || "");
        return sample.provider === item.provider && sample.accountKey === item.accountKey && sample.window === item.window && time >= start && time <= end;
      });
      const observations = buildIntervals({
        samples: intervalSamples,
        records,
        provider: item.provider,
        window: item.window,
        usageScope: item.usageScope,
        accountKey: item.accountKey,
      }).filter((interval) => interval.totalTokens > 0).map((interval) => ({
        start: new Date(interval.start).toISOString(),
        end: new Date(interval.end).toISOString(),
        dp: interval.dp,
        totalTokens: interval.totalTokens,
        costCny: interval.costCny,
        cacheHitRate: interval.cacheHitRate,
        models: interval.models,
      }));
      reconstructed.set(key, observations);
    }
    return { ...item, observations: reconstructed.get(key) };
  });
  return page;
}

function getQuotaSampleHistory(query, root) {
  return readSamplePage(query, root);
}

module.exports = { getCapacityForProvider, getCapacityHistory, getQuotaSampleHistory, peerCoverage };
