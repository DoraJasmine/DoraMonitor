"use strict";

const { collect } = require("./collect");
const { getTool } = require("./tools");
const { getCodexQuota } = require("./codex-quota");
const { fetchQuota } = require("./quota");
const { resolveKimiHome } = require("./paths");
const { loadSettings } = require("./settings");
const { samplesFromQuota, readSamples, appendSamples, getCheckpoint, setCheckpoint } = require("./quota-estimator-store");

// Scheduled estimation triggers (OR of the two):
//   (a) the quota has been in use for SCHEDULED_MIN_MINUTES and grew by at
//       least SCHEDULED_MIN_DELTA percent since the last scheduled run;
//   (b) the quota grew by SCHEDULED_DELTA_PERCENT alone, regardless of time.
const SCHEDULED_MIN_MINUTES = 30;
const SCHEDULED_MIN_DELTA = 1;
const SCHEDULED_DELTA_PERCENT = 10;
// Minimum gap between two scheduled calculations so a burst of usage cannot
// flood the history.
const SCHEDULED_MIN_GAP_MS = 5 * 60_000;

function estimateScopeFor(provider, settings) {
  const quota = settings?.quotaEstimation || {};
  if (provider === "openai") return quota.codexOnly ? "codex-only" : "all-clients";
  return quota.kimiCodeOnly ? "kimi-code-only" : "all-clients";
}

/**
 * Check the latest session-window sample of every provider account against the
 * stored anchor (the sample at the last scheduled calculation) and return the
 * accounts whose triggers fired. `calculate` is injectable for tests.
 */
function maybeRunScheduledEstimation(root, { now = Date.now(), calculate = null } = {}) {
  const fired = [];
  const pending = new Map();
  const latest = new Map();
  for (const sample of readSamples(root, now)) {
    if (!sample || sample.window !== "session" || !Number.isFinite(sample.usedPercent)) continue;
    const key = `${sample.provider}\0${sample.accountKey || "default"}`;
    const current = latest.get(key);
    if (!current || Date.parse(sample.sampledAt) > Date.parse(current.sampledAt)) latest.set(key, sample);
  }
  for (const [key, sample] of latest) {
    const checkpointKey = `scheduled-estimation:${key}`;
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
    const dueAmount = consumed >= SCHEDULED_DELTA_PERCENT;
    const dueDuration = minutes >= SCHEDULED_MIN_MINUTES && consumed >= SCHEDULED_MIN_DELTA;
    if ((!dueAmount && !dueDuration) || gap < SCHEDULED_MIN_GAP_MS) continue;
    const target = { provider: sample.provider, accountKey: sample.accountKey || "default" };
    fired.push(target);
    pending.set(key, {
      checkpointKey,
      value: { anchorAt: sample.sampledAt, anchorPercent: used, resetsAt: sample.resetsAt || null, lastRunAt: new Date(now).toISOString() },
    });
  }
  const commit = (target) => {
    const item = pending.get(`${target.provider}\0${target.accountKey}`);
    if (item) setCheckpoint(item.checkpointKey, item.value, root);
  };
  if (!calculate) {
    for (const target of fired) commit(target);
    return fired;
  }
  const settings = loadSettings();
  for (const target of fired) {
    try {
      calculate({
        provider: target.provider,
        accountKey: target.accountKey,
        usageScope: estimateScopeFor(target.provider, settings),
      });
      commit(target);
    } catch {
      // Keep the previous anchor so the next tick retries the same interval.
    }
  }
  return fired;
}

const persisted = new Map();

function runScheduledCalculation({ provider, accountKey, usageScope }, root) {
  const { getCapacityForProvider } = require("./quota-capacity");
  getCapacityForProvider({ provider, accountKey, usageScope, force: true, root });
}

function persistQuota(quota, provider, source, root) {
  if (!quota || !quota.available) return 0;
  const key = `${provider}\0${quota.accountKey || "default"}\0${quota.fetchedAt || ""}`;
  if (persisted.get(key)) return 0;
  const samples = samplesFromQuota(quota, provider, source, Date.parse(quota.fetchedAt || "") || Date.now());
  const count = appendSamples(samples, root);
  if (count) persisted.set(key, true);
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

function startQuotaSampler(cliHome, { intervalMs = 60_000, root } = {}) {
  let running = false;
  const sample = async () => {
    if (running) return;
    running = true;
    try {
      const collected = collect();
      const codex = collected.byTool.get("codex");
      persistCodexEntry(codex, root);
      if (codex && codex.home) {
        ensureCodexBackfill(codex.home, root);
        persistQuota(await getCodexQuota(codex.home), "openai", "wham", root);
      }
      const kimi = await fetchQuota(resolveKimiHome(cliHome));
      persistQuota(kimi, "kimi", "kimi-api", root);
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
