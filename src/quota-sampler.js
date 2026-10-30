"use strict";

const { collect } = require("./collect");
const { getProvider } = require("./providers");
const { getCodexQuota } = require("./codex-quota");
const { fetchQuota } = require("./quota");
const { resolveKimiHome } = require("./paths");
const { samplesFromQuota, appendSamples, getCheckpoint, setCheckpoint } = require("./quota-estimator-store");

const persisted = new Map();

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
  const provider = getProvider("codex");
  if (!provider || typeof provider.backfillQuotaSamples !== "function") return 0;
  const samples = provider.backfillQuotaSamples(home);
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

module.exports = { persistQuota, persistCodexEntry, ensureCodexBackfill, startQuotaSampler };
