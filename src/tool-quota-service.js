"use strict";

const { collect } = require("./collect");
const { codexAccountKey } = require("./codex-quota");
const { fetchQuota } = require("./quota");
const { persistQuota, persistCodexEntry, ensureCodexBackfill } = require("./quota-sampler");
const { getCapacityForProvider, getCapacityHistory, getQuotaSampleHistory, peerCoverage } = require("./quota-capacity");
const { startCalibration, finishCalibration, cancelCalibration, listCalibrations } = require("./quota-calibration");
const { loadSettings } = require("./settings");
const { syncEnabled, loadCachedPeers, newestCodexQuota, quotaUsageRecords } = require("./sync");
const { quotaProviderForTool, resolveQuotaAccount, getQuotaIntegration } = require("./quota-tool");
const { listToolQuotaAccounts, resolveKimiQuotaAccount } = require("./quota-accounts");

function withCalibrations(capacity, quotaProvider, accountKey, usageScope, tool, root) {
  return {
    ...capacity,
    provider: quotaProvider,
    tool,
    calibrations: listCalibrations({ provider: quotaProvider, accountKey, usageScope }, root),
  };
}

async function loadToolQuota(tool, cliHome, force = false, requestedAccountKey) {
  const quotaProvider = quotaProviderForTool(tool);
  if (quotaProvider === "openai") {
    const { getCodexQuota } = require("./codex-quota");
    const collected = collect({ force });
    const entry = collected.byTool.get("codex");
    persistCodexEntry(entry);
    const localQuota = entry && entry.quota ? entry.quota : null;
    const apiQuota = entry && entry.home ? await getCodexQuota(entry.home, { force }) : null;
    persistQuota(apiQuota, quotaProvider, "wham");
    if (entry && entry.home) ensureCodexBackfill(entry.home);
    const peers = syncEnabled(loadSettings()) ? loadCachedPeers() : [];
    const quota = newestCodexQuota(localQuota, peers, apiQuota) || { available: false, reason: "no_data", windows: [] };
    const accountKey = quota.accountKey || (entry && entry.home ? codexAccountKey(entry.home) : "openai:default");
    return { quota, accountKey, collected, peers };
  }
  const account = resolveKimiQuotaAccount(cliHome, requestedAccountKey);
  const quota = await fetchQuota(account.home, { force, accountKey: account.accountKey });
  persistQuota(quota, quotaProvider, "kimi-api");
  return { quota, accountKey: account.accountKey, collected: null, peers: syncEnabled(loadSettings()) ? loadCachedPeers() : [] };
}

async function getToolQuota({ tool, cliHome, force = false, scope, root, accountKey: requestedAccountKey }) {
  const quotaProvider = quotaProviderForTool(tool);
  const { quota, accountKey: loadedAccountKey, collected } = await loadToolQuota(tool, cliHome, force, requestedAccountKey);
  const accountKey = resolveQuotaAccount({ accountKey: requestedAccountKey, accounts: [loadedAccountKey] });
  if (!getQuotaIntegration(tool)?.capabilities.estimation || (tool === "kimi-code" && accountKey !== "kimi:default")) {
    return { ...quota, accountKey, tool, capacity: null };
  }
  const settings = loadSettings();
  const usageScope = quotaProvider === "openai"
    ? ["all-clients", "codex-only"].includes(scope)
      ? scope
      : settings.quotaEstimation.codexOnly ? "codex-only" : "all-clients"
    : ["all-clients", "kimi-code-only"].includes(scope)
      ? scope
      : settings.quotaEstimation.kimiCodeOnly ? "kimi-code-only" : "all-clients";
  const capacity = getCapacityForProvider({ provider: quotaProvider, accountKey, usageScope, force, collected, root });
  return { ...quota, accountKey, tool, capacity: withCalibrations(capacity, quotaProvider, accountKey, usageScope, tool, root) };
}

function getToolCapacityHistory({ tool, accountKey, scope, window, cacheHitRate, estimateKind, minConfidenceScore, limit, offset }, root, options) {
  const quotaProvider = quotaProviderForTool(tool);
  return getCapacityHistory({
    provider: quotaProvider,
    accountKey: accountKey || `${quotaProvider}:default`,
    usageScope: scope || "all-clients",
    window: window || undefined,
    cacheHitRate,
    estimateKind: estimateKind || undefined,
    minConfidenceScore,
    limit: limit || undefined,
    offset: offset || undefined,
  }, root, options);
}

function getToolSampleHistory({ tool, accountKey, window, changesOnly, limit, offset }, root) {
  const quotaProvider = quotaProviderForTool(tool);
  return getQuotaSampleHistory({
    provider: quotaProvider,
    accountKey: accountKey || `${quotaProvider}:default`,
    window: window || undefined,
    changesOnly,
    limit: limit || undefined,
    offset: offset || undefined,
  }, root);
}

async function runToolCalibration({ tool, body, cliHome, root }) {
  const quotaProvider = quotaProviderForTool(tool);
  if (!getQuotaIntegration(tool)?.capabilities.estimation) {
    const error = new Error(`Quota estimation is not supported for ${tool}`);
    error.code = "calibration_unsupported";
    error.status = 409;
    throw error;
  }
  const window = ["session", "weekly"].includes(body.window) ? body.window : null;
  const usageScope = ["all-clients", "kimi-code-only", "codex-only"].includes(body.scope) ? body.scope : "all-clients";
  if (!window || !["start", "end", "cancel"].includes(body.action)) {
    const error = new Error("Invalid tool, window, or action");
    error.code = "invalid_calibration";
    error.status = 400;
    throw error;
  }
  if (body.action === "cancel") {
    const accountKey = body.accountKey || `${quotaProvider}:default`;
    const calibration = cancelCalibration({ provider: quotaProvider, accountKey, usageScope, window, root });
    return { ok: true, tool, calibration };
  }
  const { quota, accountKey: loadedAccountKey, collected, peers } = await loadToolQuota(tool, cliHome, true, body.accountKey);
  if (!quota.available) {
    const error = new Error(quota.reason || "Quota unavailable");
    error.code = "quota_unavailable";
    error.status = 409;
    throw error;
  }
  const accountKey = resolveQuotaAccount({ accountKey: body.accountKey, accounts: [loadedAccountKey] });
  if (tool === "kimi-code" && accountKey !== "kimi:default") {
    const error = new Error("Capacity estimation requires a reliable account usage mapping");
    error.code = "calibration_unsupported";
    error.status = 409;
    throw error;
  }
  const options = { provider: quotaProvider, accountKey, usageScope, window, quota, root };
  const records = [...(collected || collect()).records, ...peers.flatMap(quotaUsageRecords)];
  const isComplete = (start, end) => peerCoverage(peers, start, end, peers.length > 0, Date.now());
  if (body.action === "start") {
    let previousCalibration = null;
    if (listCalibrations({ provider: quotaProvider, accountKey, usageScope }, root).some((item) => item.window === window)) {
      previousCalibration = finishCalibration({ ...options, records, isComplete });
      getCapacityForProvider({
        provider: quotaProvider,
        accountKey,
        usageScope,
        force: true,
        collected,
        root,
        calculation: { trigger: "reanchor", calibrationId: previousCalibration.id, startAt: previousCalibration.startAt, endAt: previousCalibration.endAt },
      });
    }
    const calibration = startCalibration(options);
    return { ok: true, tool, calibration, previousCalibration, accountKey };
  }
  const calibration = finishCalibration({ ...options, records, isComplete, allowImplicitStart: true });
  const capacity = getCapacityForProvider({
    provider: quotaProvider,
    accountKey,
    usageScope,
    force: true,
    collected,
    root,
    calculation: { trigger: "manual-end", calibrationId: calibration.id, startAt: calibration.startAt, endAt: calibration.endAt },
  });
  return { ok: true, tool, calibration, accountKey, capacity: withCalibrations(capacity, quotaProvider, accountKey, usageScope, tool, root) };
}

module.exports = { getToolQuota, getToolCapacityHistory, getToolSampleHistory, runToolCalibration, loadToolQuota, listToolQuotaAccounts };
