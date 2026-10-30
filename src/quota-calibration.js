"use strict";

const { appendSamples, loadState, saveState, readSamples, readHistory } = require("./quota-estimator-store");
const { buildIntervals } = require("./quota-estimator");

const MIN_DURATION_MS = 5 * 60_000;
const MIN_TOKENS = 10_000;
const MIN_PERCENT_SPAN = 1;

function calibrationKey({ provider, accountKey, usageScope, window }) {
  return [provider, accountKey, usageScope, window].join("\0");
}

function calibrationError(code, message, status = 409, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.details = details;
  return error;
}

function windowSample(quota, window, accountKey, source, now) {
  const item = quota && Array.isArray(quota.windows)
    ? quota.windows.find((candidate) => candidate.kind === window && Number.isFinite(Number(candidate.usedPercent)))
    : null;
  if (!item) throw calibrationError("quota_window_unavailable", `No usable ${window} quota window`, 409);
  return {
    version: 1,
    provider: quota.provider || (String(accountKey).startsWith("openai:") ? "openai" : "kimi"),
    accountKey,
    window,
    sampledAt: new Date(now).toISOString(),
    usedPercent: Math.max(0, Math.min(100, Number(item.usedPercent))),
    resetsAt: item.resetsAt || null,
    source,
  };
}

function startCalibration({ provider, accountKey, usageScope = "all-clients", window, quota, root, now = Date.now() }) {
  const key = calibrationKey({ provider, accountKey, usageScope, window });
  const state = loadState(root);
  if (state.calibrations[key]) throw calibrationError("calibration_exists", "A calibration is already active for this window");
  const sample = windowSample(quota, window, accountKey, "manual-calibration", now);
  appendSamples([sample], root);
  const calibration = {
    id: `cal-${now.toString(36)}-${process.pid.toString(36)}`,
    provider,
    accountKey,
    usageScope,
    window,
    startAt: sample.sampledAt,
    startUsedPercent: sample.usedPercent,
    resetsAt: sample.resetsAt,
  };
  state.calibrations[key] = calibration;
  saveState(state, root);
  return calibration;
}

function implicitCalibration({ provider, accountKey, usageScope, window, root, now }) {
  const history = readHistory({ provider, accountKey, usageScope, window, estimateKind: "standard" }, root);
  const previousEnd = history.at(-1)?.calculationEndAt;
  const samples = readSamples(root, now).filter((sample) =>
    sample.provider === provider && sample.accountKey === accountKey && sample.window === window
  );
  const sample = (previousEnd && samples.find((item) => item.sampledAt === previousEnd)) || samples.at(-1);
  if (!sample) throw calibrationError("calibration_not_found", "No previous calibration endpoint or quota sample is available", 404);
  return {
    id: `cal-implicit-${now.toString(36)}-${process.pid.toString(36)}`,
    provider,
    accountKey,
    usageScope,
    window,
    startAt: sample.sampledAt,
    startUsedPercent: sample.usedPercent,
    resetsAt: sample.resetsAt,
  };
}

function finishCalibration({ provider, accountKey, usageScope = "all-clients", window, quota, records, isComplete, root, now = Date.now(), allowImplicitStart = false }) {
  const key = calibrationKey({ provider, accountKey, usageScope, window });
  const state = loadState(root);
  const calibration = state.calibrations[key] || (allowImplicitStart ? implicitCalibration({ provider, accountKey, usageScope, window, root, now }) : null);
  if (!calibration) throw calibrationError("calibration_not_found", "No active calibration for this window", 404);
  const endAt = new Date(now).toISOString();
  const sample = windowSample(quota, window, accountKey, "manual-calibration", now);
  const durationMs = now - Date.parse(calibration.startAt);
  if (durationMs < MIN_DURATION_MS) {
    throw calibrationError("calibration_too_short", "Calibration must run for at least five minutes", 409, { durationMs, minimumDurationMs: MIN_DURATION_MS });
  }
  if (calibration.resetsAt && sample.resetsAt && calibration.resetsAt !== sample.resetsAt) {
    throw calibrationError("calibration_reset", "The quota window reset; start a new calibration");
  }
  const dp = sample.usedPercent - calibration.startUsedPercent;
  if (dp < MIN_PERCENT_SPAN) {
    throw calibrationError("calibration_no_quota_change", "Quota usage must increase by at least one percentage point", 409, { percentSpan: dp, minimumPercentSpan: MIN_PERCENT_SPAN });
  }
  const start = { ...calibration, sampledAt: calibration.startAt, usedPercent: calibration.startUsedPercent };
  const [interval] = buildIntervals({ samples: [start, sample], records, provider, window, usageScope, accountKey, isComplete });
  if (!interval || interval.coverage === "pending") {
    throw calibrationError("calibration_coverage_pending", "Peer usage has not caught up; synchronize and retry");
  }
  if (interval.totalTokens < MIN_TOKENS) {
    throw calibrationError("calibration_too_few_tokens", "Calibration needs at least 10,000 eligible tokens", 409, { totalTokens: interval.totalTokens, minimumTokens: MIN_TOKENS });
  }
  appendSamples([sample], root);
  delete state.calibrations[key];
  saveState(state, root);
  return {
    ...calibration,
    endAt,
    endUsedPercent: sample.usedPercent,
    durationMs,
    percentSpan: dp,
    totalTokens: interval.totalTokens,
    costCny: interval.costCny,
    coverage: interval.coverage,
  };
}

function cancelCalibration({ provider, accountKey, usageScope = "all-clients", window, root }) {
  const key = calibrationKey({ provider, accountKey, usageScope, window });
  const state = loadState(root);
  const calibration = state.calibrations[key];
  if (!calibration) throw calibrationError("calibration_not_found", "No active calibration for this window", 404);
  delete state.calibrations[key];
  saveState(state, root);
  return calibration;
}

function listCalibrations({ provider, accountKey, usageScope }, root) {
  return Object.values(loadState(root).calibrations).filter((item) =>
    item.provider === provider && item.accountKey === accountKey && item.usageScope === usageScope
  );
}

module.exports = {
  MIN_DURATION_MS,
  MIN_TOKENS,
  MIN_PERCENT_SPAN,
  startCalibration,
  finishCalibration,
  cancelCalibration,
  listCalibrations,
};
