"use strict";

const { collect } = require("./collect");
const { loadSettings } = require("./settings");
const { loadCachedPeers, quotaUsageRecords, syncEnabled } = require("./sync");
const { estimateCapacity } = require("./quota-estimator");
const { readSamples, readSamplePage, getOrComputeCapacity, readHistoryPage } = require("./quota-estimator-store");

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
      if (result === "complete") result = "provisional";
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
    for (const sample of peer.quotaSamples || []) {
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

function getCapacityHistory(query, root) {
  return readHistoryPage(query, root);
}

function getQuotaSampleHistory(query, root) {
  return readSamplePage(query, root);
}

module.exports = { getCapacityForProvider, getCapacityHistory, getQuotaSampleHistory, peerCoverage };
