"use strict";

const { collect } = require("./collect");
const { getTool } = require("./tools");
const { getCodexQuota } = require("./codex-quota");
const { fetchQuota } = require("./quota");
const { getQuotaIntegration, toolForQuotaProvider } = require("./quota-tool");
const { listKimiQuotaAccounts } = require("./quota-accounts");
const { isDaemonRunning } = require("./daemon-liveness");
const { loadSettings } = require("./settings");
const { samplesFromQuota, readSamples, appendSamples, getCheckpoint, setCheckpoint } = require("./quota-estimator-store");

// Standard windows have independent anchors.
const SCHEDULED_MIN_MINUTES = 60;
const SCHEDULED_MIN_DELTA = 4;
const SCHEDULED_DELTA_PERCENT = 10;
const SCHEDULED_MIN_GAP_MS = 5 * 60_000;

function estimateScopeFor(provider, settings) {
  const quota = settings?.quotaEstimation || {};
  if (provider === "openai") return quota.codexOnly ? "codex-only" : "all-clients";
  return quota.kimiCodeOnly ? "kimi-code-only" : "all-clients";
}

function maybeRunScheduledEstimation(root, { now = Date.now(), calculate = null } = {}) {
  const fired = [];
  const pending = new Map();
  const latest = new Map();
  for (const sample of readSamples(root, now)) {
    if (!sample || !["session", "weekly"].includes(sample.window) || !Number.isFinite(sample.usedPercent)) continue;
    if (!getQuotaIntegration(toolForQuotaProvider(sample.provider))?.capabilities.estimation) continue;
    if (sample.provider === "kimi" && sample.accountKey !== "kimi:default") continue;
    const key = `${sample.provider}\0${sample.accountKey || "default"}\0${sample.window}`;
    const current = latest.get(key);
    if (!current || Date.parse(sample.sampledAt) > Date.parse(current.sampledAt)) latest.set(key, sample);
  }
  for (const [key, sample] of latest) {
    const estimateKind = "standard";
    const checkpointKey = `${estimateKind}-estimation:${key}`;
    const anchor = getCheckpoint(checkpointKey, root);
    const used = sample.usedPercent;
    if (!anchor || !Number.isFinite(anchor.anchorPercent)) {
      setCheckpoint(checkpointKey, { anchorAt: sample.sampledAt, anchorPercent: used, resetsAt: sample.resetsAt || null, lastRunAt: anchor?.lastRunAt || null }, root);
      continue;
    }
    const resetChanged = (anchor.resetsAt || null) !== (sample.resetsAt || null);
    if (used < anchor.anchorPercent || resetChanged) {
      setCheckpoint(checkpointKey, { anchorAt: sample.sampledAt, anchorPercent: used, resetsAt: sample.resetsAt || null, lastRunAt: anchor.lastRunAt }, root);
      continue;
    }
    const consumed = used - anchor.anchorPercent;
    const minutes = (now - Date.parse(anchor.anchorAt)) / 60_000;
    const gap = anchor.lastRunAt ? now - Date.parse(anchor.lastRunAt) : Infinity;
    const due = consumed >= SCHEDULED_DELTA_PERCENT || (minutes >= SCHEDULED_MIN_MINUTES && consumed >= SCHEDULED_MIN_DELTA);
    if (!due || gap < SCHEDULED_MIN_GAP_MS) continue;
    const target = { provider: sample.provider, accountKey: sample.accountKey || "default", window: sample.window, estimateKind, startAt: anchor.anchorAt, endAt: sample.sampledAt };
    fired.push(target);
    pending.set(`${estimateKind}:${key}`, {
      checkpointKey,
      value: { anchorAt: sample.sampledAt, anchorPercent: used, resetsAt: sample.resetsAt || null, lastRunAt: new Date(now).toISOString() },
    });
  }
  const commit = (target) => {
    const item = pending.get(`${target.estimateKind}:${target.provider}\0${target.accountKey}\0${target.window}`);
    if (item) setCheckpoint(item.checkpointKey, item.value, root);
  };
  if (!calculate) {
    for (const target of fired) commit(target);
    return fired;
  }
  const settings = loadSettings();
  for (const target of fired) {
    try {
      calculate({ ...target, usageScope: estimateScopeFor(target.provider, settings) });
      commit(target);
    } catch {
      // Keep the previous anchor so the next tick retries the same interval.
    }
  }
  return fired;
}

const persisted = new Map();

function runScheduledCalculation({ provider, accountKey, usageScope, window, estimateKind, startAt, endAt }, root) {
  const { getCapacityForProvider } = require("./quota-capacity");
  const capacity = getCapacityForProvider({
    provider,
    accountKey,
    usageScope,
    force: true,
    root,
    calculation: { trigger: "scheduled", window, estimateKind, startAt, endAt },
  });
  if (!capacity.targets.some((target) => target.window === window && Number.isFinite(target.fullWindowTokens))) {
    throw new Error(`No valid ${estimateKind} estimate for ${provider}:${window}`);
  }
}

function persistQuota(quota, provider, source, root) {
  if (!quota || !quota.available) return 0;
  const key = `${provider}\0${quota.accountKey || "default"}\0${quota.fetchedAt || ""}`;
  if (persisted.get(key)) return 0;
  const samples = samplesFromQuota(quota, provider, source, Date.parse(quota.fetchedAt || "") || Date.now());
  const count = appendSamples(samples, root);
  if (count) {
    if (persisted.size >= 2048) persisted.delete(persisted.keys().next().value);
    persisted.set(key, true);
  }
  return count;
}

function persistCodexEntry(entry, root) {
  if (!entry) return 0;
  const count = appendSamples(entry.quotaSamples || [], root);
  return count + persistQuota(entry.quota, "openai", "codex-cache", root);
}

function ensureCodexBackfill(home, root) {
  if (!home) return 0;
  const name = `codex-backfill:${home}`;
  if (getCheckpoint(name, root)) return 0;
  const tool = getTool("codex");
  if (!tool || typeof tool.backfillQuotaSamples !== "function") return 0;
  const samples = tool.backfillQuotaSamples(home);
  const count = appendSamples(samples, root);
  setCheckpoint(name, { completedAt: new Date().toISOString(), sampleCount: count }, root);
  return count;
}

function startQuotaSampler(cliHome, { intervalMs = 60_000, root, deferToDaemon = false } = {}) {
  let running = false;
  const sample = async () => {
    if (running || (deferToDaemon && isDaemonRunning())) return;
    running = true;
    try {
      const collected = collect();
      const codex = collected.byTool.get("codex");
      persistCodexEntry(codex, root);
      if (codex && codex.home) {
        ensureCodexBackfill(codex.home, root);
        persistQuota(await getCodexQuota(codex.home), "openai", "wham", root);
      }
      for (const account of listKimiQuotaAccounts(cliHome)) {
        try {
          const kimi = await fetchQuota(account.home, { accountKey: account.accountKey });
          persistQuota(kimi, "kimi", "kimi-api", root);
        } catch {
          // One account failure must not block sampling for the others.
        }
      }
      // Scheduled estimation: usage-duration and usage-amount triggers (OR).
      try {
        maybeRunScheduledEstimation(root, { calculate: (target) => runScheduledCalculation(target, root) });
      } catch {
        // Best-effort; the next tick retries.
      }
    } catch {
      // Existing quota endpoints expose errors; background sampling stays best-effort.
    } finally {
      running = false;
    }
  };
  const timer = setInterval(sample, intervalMs);
  timer.unref();
  const initial = setTimeout(sample, 1000);
  initial.unref();
  return () => {
    clearInterval(timer);
    clearTimeout(initial);
  };
}

module.exports = { persistQuota, persistCodexEntry, ensureCodexBackfill, startQuotaSampler, maybeRunScheduledEstimation, estimateScopeFor, SCHEDULED_MIN_MINUTES, SCHEDULED_MIN_DELTA, SCHEDULED_DELTA_PERCENT, SCHEDULED_MIN_GAP_MS };
