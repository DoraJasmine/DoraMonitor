"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_ROOT = path.join(os.homedir(), ".doramonitor", "quota-estimator");
const SAMPLE_RETENTION_MS = 90 * 86_400_000;
const RECALCULATE_MS = 6 * 3_600_000;
const HISTORY_LIMIT = 30;

function samplesPath(root = DEFAULT_ROOT) {
  return path.join(root, "samples.jsonl");
}

function statePath(root = DEFAULT_ROOT) {
  return path.join(root, "state.json");
}

function historyPath(root = DEFAULT_ROOT) {
  return path.join(root, "history.jsonl");
}

function emptyState() {
  return { version: 1, cache: {}, estimates: [], maxima: {}, checkpoints: {}, calibrations: {} };
}

function loadState(root = DEFAULT_ROOT) {
  try {
    const state = JSON.parse(fs.readFileSync(statePath(root), "utf8"));
    return {
      ...emptyState(),
      ...state,
      cache: state.cache || {},
      estimates: Array.isArray(state.estimates) ? state.estimates : [],
      maxima: state.maxima || {},
      checkpoints: state.checkpoints || {},
      calibrations: state.calibrations || {},
    };
  } catch {
    return emptyState();
  }
}

function saveState(state, root = DEFAULT_ROOT) {
  fs.mkdirSync(root, { recursive: true });
  const file = statePath(root);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1), "utf8");
  fs.renameSync(tmp, file);
}

function samplesFromQuota(quota, provider, source, sampledAt = Date.now()) {
  if (!quota || quota.available !== true || !Array.isArray(quota.windows)) return [];
  const accountKey = String(quota.accountKey || `${provider}:default`);
  const time = new Date(sampledAt).toISOString();
  return quota.windows
    .filter((w) => w && Number.isFinite(Number(w.usedPercent)) && ["session", "weekly"].includes(w.kind))
    .map((w) => ({
      version: 1,
      provider,
      accountKey,
      window: w.kind,
      sampledAt: time,
      usedPercent: Math.max(0, Math.min(100, Number(w.usedPercent))),
      resetsAt: w.resetsAt || null,
      source,
    }));
}

function sampleKey(sample) {
  return [sample.provider, sample.accountKey, sample.window, sample.sampledAt, sample.source].join("\0");
}

function appendSamples(samples, root = DEFAULT_ROOT) {
  const valid = (samples || []).filter((s) => s && s.provider && s.accountKey && s.window && Number.isFinite(Date.parse(s.sampledAt || "")));
  if (!valid.length) return 0;
  fs.mkdirSync(root, { recursive: true });
  fs.appendFileSync(samplesPath(root), valid.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");
  return valid.length;
}

function readSamples(root = DEFAULT_ROOT, now = Date.now()) {
  const samples = new Map();
  let text;
  try {
    text = fs.readFileSync(samplesPath(root), "utf8");
  } catch {
    return [];
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    try {
      const sample = JSON.parse(line);
      const time = Date.parse(sample.sampledAt || "");
      if (!Number.isFinite(time) || now - time > SAMPLE_RETENTION_MS) continue;
      samples.set(sampleKey(sample), sample);
    } catch {
      // Keep readable samples when one appended line is torn or malformed.
    }
  }
  return [...samples.values()].sort((a, b) => Date.parse(a.sampledAt) - Date.parse(b.sampledAt));
}

function readSamplePage(query, root = DEFAULT_ROOT) {
  let rows = readSamples(root, Date.now()).filter((sample) =>
    (!query.provider || sample.provider === query.provider) &&
    (!query.accountKey || sample.accountKey === query.accountKey) &&
    (!query.window || sample.window === query.window)
  );
  if (query.changesOnly) {
    const previous = new Map();
    rows = rows.filter((sample) => {
      const key = sample.window;
      const before = previous.get(key);
      previous.set(key, sample);
      return !before || before.usedPercent !== sample.usedPercent || before.resetsAt !== sample.resetsAt;
    });
  }
  rows.reverse();
  const limit = Math.max(1, Math.min(200, Number(query.limit) || 50));
  const offset = Math.max(0, Number(query.offset) || 0);
  return { samples: rows.slice(offset, offset + limit), total: rows.length, limit, offset };
}

function capacityKey(capacity) {
  return [capacity.provider, capacity.accountKey || "default", capacity.usageScope].join("\0");
}

function estimateKey(target) {
  return [target.provider, target.accountKey || "default", target.usageScope, target.estimateKind || "standard", target.window, target.cacheHitRate].join("\0");
}

function targetSignature(target) {
  return [target.fullWindowTokens && Math.round(target.fullWindowTokens), target.fullWindowCostCny && Math.round(target.fullWindowCostCny * 1e6), target.sampleCount, target.percentSpan, target.method, target.confidence, target.confidenceScore].join("|");
}

function withMaxima(capacity, state) {
  const maxima = [];
  for (const target of [...(capacity.targets || []), ...(capacity.longTermTargets || [])]) {
    const key = estimateKey({ ...capacity, ...target });
    if (state.maxima[key]) maxima.push({ window: target.window, cacheHitRate: target.cacheHitRate, estimateKind: target.estimateKind || "standard", ...state.maxima[key] });
  }
  return { ...capacity, maxima };
}

function historyMatches(item, { provider, accountKey, usageScope, window, cacheHitRate, estimateKind }) {
  return (!provider || item.provider === provider) &&
    (!accountKey || item.accountKey === accountKey) &&
    (!usageScope || item.usageScope === usageScope) &&
    (!window || item.window === window) &&
    (!estimateKind || (item.estimateKind || "standard") === estimateKind) &&
    (cacheHitRate === undefined || item.cacheHitRate === Number(cacheHitRate));
}

function readHistory(query = {}, root = DEFAULT_ROOT) {
  const rows = new Map();
  const add = (item) => {
    if (!item || !item.createdAt) return;
    rows.set([estimateKey(item), item.createdAt, item.signature || ""].join("\0"), item);
  };
  for (const item of loadState(root).estimates) add(item);
  let text;
  try {
    text = fs.readFileSync(historyPath(root), "utf8");
  } catch {
    text = "";
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    try {
      add(JSON.parse(line));
    } catch {
      // Preserve readable history when the final appended line is incomplete.
    }
  }
  return [...rows.values()]
    .filter((item) => historyMatches(item, query))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

function readHistoryPage(query, root = DEFAULT_ROOT) {
  const rows = readHistory(query, root);
  const limit = Math.max(1, Math.min(200, Number(query.limit) || HISTORY_LIMIT));
  const offset = Math.max(0, Number(query.offset) || 0);
  return { history: rows.slice(offset, offset + limit), total: rows.length, limit, offset };
}

function appendHistory(entries, root = DEFAULT_ROOT) {
  if (!entries.length) return;
  fs.mkdirSync(root, { recursive: true });
  fs.appendFileSync(historyPath(root), entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
}

function getOrComputeCapacity({ provider, accountKey, usageScope, force = false, compute, root = DEFAULT_ROOT, now = Date.now(), calculation = null }) {
  const state = loadState(root);
  const key = capacityKey({ provider, accountKey, usageScope });
  const cached = state.cache[key];
  const cacheAge = cached ? now - Date.parse(cached.generatedAt || "") : Infinity;
  const hasSamples = cached && [...(cached.targets || []), ...(cached.longTermTargets || [])].some((target) => Number.isFinite(target.fullWindowTokens));
  if (!force && cached && cacheAge >= 0 && cacheAge < (hasSamples ? RECALCULATE_MS : 60_000)) {
    return withMaxima(cached, state);
  }

  const capacity = compute();
  const next = loadState(root);
  const existingHistory = readHistory({}, root);
  const history = [];
  for (const target of [...(capacity.targets || []), ...(capacity.longTermTargets || [])]) {
    if (!Number.isFinite(target.fullWindowTokens)) continue;
    const keyForTarget = estimateKey({ ...target, provider, accountKey, usageScope });
    const previous = existingHistory.filter((item) => estimateKey(item) === keyForTarget).at(-1);
    const entry = {
      ...target,
      provider,
      accountKey,
      usageScope,
      createdAt: capacity.generatedAt,
      calculationStartAt: target.dataRange?.start || calculation?.startAt || null,
      calculationEndAt: target.dataRange?.end || calculation?.endAt || null,
      previousCalculationEndAt: previous?.calculationEndAt || previous?.dataRange?.end || null,
      trigger: calculation?.trigger || "scheduled",
      calibrationId: calculation?.calibrationId || null,
      signature: targetSignature(target),
    };
    history.push(entry);
    const maximum = next.maxima[keyForTarget];
    if (
      target.coverage === "complete" &&
      ["medium", "high"].includes(target.confidence) &&
      target.method !== "extrapolated" &&
      (!maximum || target.fullWindowTokens > maximum.fullWindowTokens)
    ) {
      next.maxima[keyForTarget] = {
        fullWindowTokens: target.fullWindowTokens,
        fullWindowCostCny: target.fullWindowCostCny || null,
        createdAt: capacity.generatedAt,
        confidence: target.confidence,
        confidenceScore: target.confidenceScore,
        sampleCount: target.sampleCount,
      };
    }
  }
  appendHistory(history, root);
  next.cache[key] = capacity;
  saveState(next, root);
  return withMaxima(capacity, next);
}

function getCheckpoint(name, root = DEFAULT_ROOT) {
  return loadState(root).checkpoints[name] || null;
}

function setCheckpoint(name, value, root = DEFAULT_ROOT) {
  const state = loadState(root);
  state.checkpoints[name] = value;
  saveState(state, root);
}

module.exports = {
  DEFAULT_ROOT,
  HISTORY_LIMIT,
  samplesFromQuota,
  appendSamples,
  readSamples,
  readSamplePage,
  getOrComputeCapacity,
  readHistory,
  readHistoryPage,
  getCheckpoint,
  setCheckpoint,
  loadState,
  saveState,
};
