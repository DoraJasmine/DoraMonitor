"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { quotaProviderOf, normalizeQuotaRecord, normalizeQuotaState } = require("./quota-schema");
const { ensureQuotaStorageMigrated } = require("./quota-migration");

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
  return { version: 2, cache: {}, estimates: [], maxima: {}, checkpoints: {}, calibrations: {} };
}

function loadState(root = DEFAULT_ROOT) {
  ensureQuotaStorageMigrated(root);
  let state;
  try {
    state = JSON.parse(fs.readFileSync(statePath(root), "utf8"));
  } catch {
    return emptyState();
  }
  return normalizeQuotaState({
    ...emptyState(),
    ...state,
    cache: state.cache || {},
    estimates: Array.isArray(state.estimates) ? state.estimates : [],
    maxima: state.maxima || {},
    checkpoints: state.checkpoints || {},
    calibrations: state.calibrations || {},
  }, { includeLegacy: true, strict: true });
}

function saveState(state, root = DEFAULT_ROOT) {
  ensureQuotaStorageMigrated(root, { write: true });
  fs.mkdirSync(root, { recursive: true });
  const file = statePath(root);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(normalizeQuotaState(state, { strict: true }), null, 1), "utf8");
  fs.renameSync(tmp, file);
}

function samplesFromQuota(quota, provider, source, sampledAt = Date.now()) {
  if (!quota || quota.available !== true || !Array.isArray(quota.windows)) return [];
  const accountKey = String(quota.accountKey || `${provider}:default`);
  const time = new Date(sampledAt).toISOString();
  return quota.windows
    .filter((w) => w && Number.isFinite(Number(w.usedPercent)) && ["session", "weekly"].includes(w.kind))
    .map((w) => ({
      version: 2,
      quotaProvider: provider,
      accountKey,
      window: w.kind,
      sampledAt: time,
      usedPercent: Math.max(0, Math.min(100, Number(w.usedPercent))),
      resetsAt: w.resetsAt || null,
      source,
    }));
}

function sampleKey(sample) {
  return [quotaProviderOf(sample), sample.accountKey, sample.window, sample.sampledAt, sample.source].join("\0");
}

const sampleCompactionAt = new Map();

function appendSamples(samples, root = DEFAULT_ROOT, now = Date.now()) {
  ensureQuotaStorageMigrated(root, { write: true });
  const valid = (samples || [])
    .map((sample) => normalizeQuotaRecord(sample, { strict: true }))
    .filter((s) => s && quotaProviderOf(s) && s.accountKey && s.window && Number.isFinite(Date.parse(s.sampledAt || "")));
  if (!valid.length) return 0;
  fs.mkdirSync(root, { recursive: true });
  const file = samplesPath(root);
  fs.appendFileSync(file, valid.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");
  const previousCompaction = sampleCompactionAt.get(root) || 0;
  if (now - previousCompaction >= 86_400_000) {
    sampleCompactionAt.set(root, now);
    const retained = readSamples(root, now).map((sample) => normalizeQuotaRecord(sample));
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, retained.map((sample) => JSON.stringify(sample)).join("\n") + (retained.length ? "\n" : ""), "utf8");
    fs.renameSync(tmp, file);
  }
  return valid.length;
}

function readSamples(root = DEFAULT_ROOT, now = Date.now()) {
  ensureQuotaStorageMigrated(root);
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
      const sample = normalizeQuotaRecord(JSON.parse(line), { includeLegacy: true });
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

function capacityKey(capacity, algorithmVersion) {
  return [quotaProviderOf(capacity), capacity.accountKey || "default", capacity.usageScope, algorithmVersion].join("\0");
}

function estimateKey(target) {
  return [quotaProviderOf(target), target.accountKey || "default", target.usageScope, target.estimateKind || "standard", target.window, target.cacheHitRate].join("\0");
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
  return (!provider || quotaProviderOf(item) === provider) &&
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
    const normalized = normalizeQuotaRecord(item, { includeLegacy: true });
    rows.set([estimateKey(normalized), normalized.createdAt, normalized.signature || ""].join("\0"), normalized);
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
  const sorted = [...rows.values()]
    .filter((item) => historyMatches(item, query))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const latest = new Map();
  for (const item of sorted) {
    const key = estimateKey(item);
    const previous = latest.get(key);
    if (previous) item.calculationStartAt = previous.calculationEndAt || item.calculationStartAt;
    latest.set(key, item);
  }
  return sorted;
}

function readHistoryPage(query, root = DEFAULT_ROOT) {
  const rows = readHistory(query, root).reverse();
  const limit = Math.max(1, Math.min(200, Number(query.limit) || HISTORY_LIMIT));
  const offset = Math.max(0, Number(query.offset) || 0);
  return { history: rows.slice(offset, offset + limit), total: rows.length, limit, offset };
}

function appendHistory(entries, root = DEFAULT_ROOT) {
  if (!entries.length) return;
  ensureQuotaStorageMigrated(root, { write: true });
  fs.mkdirSync(root, { recursive: true });
  fs.appendFileSync(historyPath(root), entries.map((entry) => JSON.stringify(normalizeQuotaRecord(entry, { strict: true }))).join("\n") + "\n", "utf8");
}

function getOrComputeCapacity({ provider, accountKey, usageScope, force = false, compute, root = DEFAULT_ROOT, now = Date.now(), calculation = null, algorithmVersion = 1 }) {
  const state = loadState(root);
  const key = capacityKey({ provider, accountKey, usageScope }, algorithmVersion);
  const cached = state.cache[key];
  const cacheAge = cached ? now - Date.parse(cached.generatedAt || "") : Infinity;
  const hasSamples = cached && [...(cached.targets || []), ...(cached.longTermTargets || [])].some((target) => Number.isFinite(target.fullWindowTokens));
  if (!force && cached && cached.algorithmVersion === algorithmVersion && cacheAge >= 0 && cacheAge < (hasSamples ? RECALCULATE_MS : 60_000)) {
    return withMaxima(cached, state);
  }

  const computed = compute();
  const capacity = { ...computed, algorithmVersion: computed.algorithmVersion || algorithmVersion };
  const next = loadState(root);
  const previousByTarget = new Map();
  if (calculation) {
    for (const item of readHistory({}, root)) previousByTarget.set(estimateKey(item), item);
  }
  const history = [];
  for (const target of [...(capacity.targets || []), ...(capacity.longTermTargets || [])]) {
    if (!Number.isFinite(target.fullWindowTokens)) continue;
    if (calculation?.window && target.window !== calculation.window) continue;
    if (calculation?.estimateKind && (target.estimateKind || "standard") !== calculation.estimateKind) continue;
    const keyForTarget = estimateKey({ ...target, provider, accountKey, usageScope });
    const previous = previousByTarget.get(keyForTarget);
    const calculationEndAt = target.dataRange?.end || calculation?.endAt || null;
    if (calculation && !calculation.calibrationId && previous && calculationEndAt && previous.calculationEndAt === calculationEndAt) continue;
    if (calculation) {
      const entry = {
        ...target,
        provider,
        accountKey,
        usageScope,
        createdAt: capacity.generatedAt,
        calculationStartAt: previous?.calculationEndAt || calculation?.startAt || target.dataRange?.start || null,
        calculationEndAt,
        previousCalculationEndAt: previous?.calculationEndAt || previous?.dataRange?.end || null,
        trigger: calculation.trigger || "scheduled",
        calibrationId: calculation.calibrationId || null,
        signature: targetSignature(target),
      };
      history.push(entry);
    }
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
