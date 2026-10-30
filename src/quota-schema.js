"use strict";

const QUOTA_STORAGE_VERSION = 2;

function quotaProviderOf(record) {
  return record && (record.quotaProvider ?? record.provider);
}

function normalizeQuotaRecord(record, { includeLegacy = false, strict = false } = {}) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return record;
  const quotaProvider = quotaProviderOf(record);
  if (strict && record.quotaProvider && record.provider && record.quotaProvider !== record.provider) {
    const error = new Error("Conflicting provider and quotaProvider values");
    error.code = "conflicting_quota_provider";
    throw error;
  }
  const normalized = { ...record, version: QUOTA_STORAGE_VERSION, quotaProvider };
  delete normalized.provider;
  if (includeLegacy && quotaProvider) normalized.provider = quotaProvider;
  return normalized;
}

function hasQuotaProvider(record) {
  return record && typeof record === "object" && ("quotaProvider" in record || "provider" in record);
}

function normalizeQuotaState(state, { includeLegacy = false, strict = false } = {}) {
  const options = { includeLegacy, strict };
  const normalized = {
    ...state,
    version: QUOTA_STORAGE_VERSION,
    cache: { ...(state.cache || {}) },
    estimates: Array.isArray(state.estimates) ? state.estimates.map((item) => normalizeQuotaRecord(item, options)) : [],
    maxima: { ...(state.maxima || {}) },
    checkpoints: { ...(state.checkpoints || {}) },
    calibrations: { ...(state.calibrations || {}) },
  };
  for (const [key, value] of Object.entries(normalized.cache)) {
    if (hasQuotaProvider(value)) normalized.cache[key] = normalizeQuotaRecord(value, options);
  }
  for (const [key, value] of Object.entries(normalized.maxima)) {
    if (hasQuotaProvider(value)) normalized.maxima[key] = normalizeQuotaRecord(value, options);
  }
  for (const [key, value] of Object.entries(normalized.calibrations)) {
    if (hasQuotaProvider(value)) normalized.calibrations[key] = normalizeQuotaRecord(value, options);
  }
  return normalized;
}

module.exports = { QUOTA_STORAGE_VERSION, quotaProviderOf, normalizeQuotaRecord, normalizeQuotaState };
