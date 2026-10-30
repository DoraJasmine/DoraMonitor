"use strict";

const { classifyQuotaModel, belongsToQuota } = require("./quota-models");
const { costForUsage } = require("./pricing");
const { loadSettings } = require("./settings");

const CACHE_TARGETS = [0.85, 0.9, 0.95, 0.98];
const TOKEN_TYPES = ["inputOther", "inputCacheRead", "inputCacheCreation", "output"];
const DAY_MS = 86_400_000;

function timeOf(value) {
  const time = typeof value === "number" ? value : Date.parse(value || "");
  return Number.isFinite(time) ? time : 0;
}

function tokenTotal(record) {
  return TOKEN_TYPES.reduce((sum, key) => sum + (Number(record && record[key]) || 0), 0);
}

function emptyModel() {
  return { inputOther: 0, inputCacheRead: 0, inputCacheCreation: 0, output: 0, totalTokens: 0, costCny: 0 };
}

function addTokens(target, record) {
  for (const key of TOKEN_TYPES) target[key] += Number(record[key]) || 0;
  target.totalTokens += tokenTotal(record);
  target.costCny += Number(record.costCny) || 0;
}

function usageBetween(records, start, end, provider) {
  const out = { models: {}, totalTokens: 0, costCny: 0, unknownTokens: 0 };
  for (const item of records) {
    if (item.time <= start || item.time > end) continue;
    if (!item.eligible) {
      if (item.unknown) out.unknownTokens += tokenTotal(item.record);
      continue;
    }
    const model = item.modelKey;
    if (!out.models[model]) out.models[model] = emptyModel();
    addTokens(out.models[model], item.record);
    out.totalTokens += tokenTotal(item.record);
    out.costCny += Number(item.record.costCny) || 0;
  }
  if (out.totalTokens > 0) {
    const totals = emptyModel();
    for (const model of Object.values(out.models)) addTokens(totals, model);
    const input = totals.inputOther + totals.inputCacheRead + totals.inputCacheCreation;
    out.cacheHitRate = input > 0 ? totals.inputCacheRead / input : 0;
    out.dominantModelShare = Math.max(...Object.values(out.models).map((m) => m.totalTokens)) / out.totalTokens;
  } else {
    out.cacheHitRate = 0;
    out.dominantModelShare = 0;
  }
  out.provider = provider;
  return out;
}

function buildIntervals({ samples, records, provider, window, usageScope = "all-clients", accountKey = null, isComplete }) {
  const sortedSamples = (samples || [])
    .filter((s) => s && s.provider === provider && s.window === window && (!accountKey || s.accountKey === accountKey))
    .map((s) => ({ ...s, time: timeOf(s.sampledAt), usedPercent: Number(s.usedPercent) }))
    .filter((s) => s.time > 0 && Number.isFinite(s.usedPercent) && s.usedPercent >= 0 && s.usedPercent <= 100)
    .sort((a, b) => a.time - b.time);

  const usage = [];
  for (const record of records || []) {
    const time = timeOf(record && record.time);
    if (!record || !time || record.kind === "event") continue;
    const identity = classifyQuotaModel(record);
    const eligible = belongsToQuota(record, provider, usageScope);
    const sameTool = provider === "openai" ? record.tool === "codex" : record.tool === "kimi-code";
    const unknown = !eligible && identity.reason === "unknown_model" && sameTool;
    if (!eligible && !unknown) continue;
    usage.push({ record, time, eligible, unknown, modelKey: identity.modelKey });
  }
  usage.sort((a, b) => a.time - b.time);

  const intervals = [];
  let anchor = null;
  for (const sample of sortedSamples) {
    if (!anchor) {
      anchor = sample;
      continue;
    }
    const resetChanged = anchor.resetsAt && sample.resetsAt && anchor.resetsAt !== sample.resetsAt;
    if (resetChanged || sample.usedPercent < anchor.usedPercent) {
      anchor = sample;
      continue;
    }
    if (sample.usedPercent === anchor.usedPercent) continue;

    const usageTotals = usageBetween(usage, anchor.time, sample.time, provider);
    const dp = sample.usedPercent - anchor.usedPercent;
    const status = typeof isComplete === "function" ? isComplete(anchor.time, sample.time) : "complete";
    const coverage = status === true || status === "complete" ? "complete" : status === "provisional" ? "provisional" : "pending";
    intervals.push({
      provider,
      window,
      start: anchor.time,
      end: sample.time,
      dp,
      durationMs: sample.time - anchor.time,
      ...usageTotals,
      coverage: usageTotals.unknownTokens > usageTotals.totalTokens * 0.1 ? "provisional" : coverage,
      reason: usageTotals.totalTokens > 0 ? null : "untracked_usage",
    });
    anchor = sample;
  }
  return intervals;
}

function baseWeight(interval, now) {
  const ageDays = Math.max(0, (now - interval.end) / DAY_MS);
  const timeWeight = Math.pow(0.5, ageDays / 21);
  const spanWeight = Math.min(1, Math.max(0.1, interval.dp / 2));
  const durationWeight = interval.window === "session" ? Math.min(1, 3_600_000 / Math.max(3_600_000, interval.durationMs)) : 1;
  return timeWeight * spanWeight * durationWeight;
}

function weightedQuantile(values, weights, q) {
  if (!values.length) return null;
  const rows = values.map((value, i) => ({ value, weight: Math.max(0.0001, weights[i] || 0) })).sort((a, b) => a.value - b.value);
  const total = rows.reduce((sum, row) => sum + row.weight, 0);
  let cumulative = 0;
  for (const row of rows) {
    cumulative += row.weight;
    if (cumulative >= total * q) return row.value;
  }
  return rows[rows.length - 1].value;
}

function solveLinear(matrix, rhs) {
  const n = rhs.length;
  const a = matrix.map((row, i) => [...row, rhs[i]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    if (Math.abs(a[pivot][col]) < 1e-12) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const divisor = a[col][col];
    for (let j = col; j <= n; j += 1) a[col][j] /= divisor;
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const factor = a[row][col];
      for (let j = col; j <= n; j += 1) a[row][j] -= factor * a[col][j];
    }
  }
  return a.map((row) => row[n]);
}

function solveNonNegative(x, y, weights) {
  const count = x[0] ? x[0].length : 0;
  let active = Array.from({ length: count }, (_, i) => i);
  let result = Array(count).fill(0);
  while (active.length) {
    const matrix = Array.from({ length: active.length }, () => Array(active.length).fill(0));
    const rhs = Array(active.length).fill(0);
    for (let row = 0; row < x.length; row += 1) {
      for (let a = 0; a < active.length; a += 1) {
        const xa = x[row][active[a]];
        rhs[a] += weights[row] * xa * y[row];
        for (let b = 0; b < active.length; b += 1) {
          matrix[a][b] += weights[row] * xa * x[row][active[b]];
        }
      }
    }
    let maxDiag = 0;
    for (let i = 0; i < active.length; i += 1) maxDiag = Math.max(maxDiag, matrix[i][i]);
    for (let i = 0; i < active.length; i += 1) matrix[i][i] += Math.max(1e-9, maxDiag * 1e-8);
    const solved = solveLinear(matrix, rhs);
    if (!solved) return null;
    result = Array(count).fill(0);
    active.forEach((feature, i) => { result[feature] = solved[i]; });
    let worst = -1;
    for (let i = 0; i < active.length; i += 1) {
      if (solved[i] < -1e-9 && (worst < 0 || solved[i] < solved[worst])) worst = i;
    }
    if (worst < 0) return result;
    active.splice(worst, 1);
  }
  return result;
}

function fitRates(intervals, now) {
  const features = [];
  const featureIndex = new Map();
  for (const interval of intervals) {
    for (const [model, usage] of Object.entries(interval.models)) {
      for (const type of TOKEN_TYPES) {
        if (!(usage[type] > 0)) continue;
        const key = `${model}\0${type}`;
        if (!featureIndex.has(key)) {
          featureIndex.set(key, features.length);
          features.push(key);
        }
      }
    }
  }
  if (!features.length) return null;
  const x = intervals.map((interval) => {
    const row = Array(features.length).fill(0);
    for (const [model, usage] of Object.entries(interval.models)) {
      for (const type of TOKEN_TYPES) {
        const index = featureIndex.get(`${model}\0${type}`);
        if (index !== undefined) row[index] = usage[type] / 1_000_000;
      }
    }
    return row;
  });
  const y = intervals.map((interval) => interval.dp);
  const originalWeights = intervals.map((interval) => baseWeight(interval, now));
  let weights = [...originalWeights];
  let beta = null;
  for (let iteration = 0; iteration < 8; iteration += 1) {
    beta = solveNonNegative(x, y, weights);
    if (!beta) return null;
    weights = originalWeights.map((weight, i) => {
      const prediction = x[i].reduce((sum, value, j) => sum + value * beta[j], 0);
      const residual = Math.abs(y[i] - prediction);
      return weight * (residual > 0.6 ? 0.6 / residual : 1);
    });
  }
  const rates = {};
  features.forEach((feature, i) => {
    const [model, type] = feature.split("\0");
    if (!rates[model]) rates[model] = {};
    rates[model][type] = Math.max(0, beta[i]);
  });
  let absoluteError = 0;
  let meanDp = 0;
  let weightTotal = 0;
  intervals.forEach((interval, i) => {
    const prediction = x[i].reduce((sum, value, j) => sum + value * beta[j], 0);
    absoluteError += originalWeights[i] * Math.abs(interval.dp - prediction);
    meanDp += originalWeights[i] * interval.dp;
    weightTotal += originalWeights[i];
  });
  return { rates, residual: weightTotal > 0 && meanDp > 0 ? absoluteError / meanDp : 1 };
}

function modelProfile(intervals) {
  const models = {};
  let totalInput = 0;
  for (const interval of intervals) {
    for (const [name, usage] of Object.entries(interval.models)) {
      if (!models[name]) models[name] = emptyModel();
      addTokens(models[name], usage);
    }
  }
  for (const usage of Object.values(models)) totalInput += usage.inputOther + usage.inputCacheRead + usage.inputCacheCreation;
  const profile = {};
  for (const [name, usage] of Object.entries(models)) {
    const input = usage.inputOther + usage.inputCacheRead + usage.inputCacheCreation;
    if (!(input > 0)) continue;
    profile[name] = {
      mix: input / totalInput,
      cacheCreate: usage.inputCacheCreation / input,
      output: usage.output / input,
    };
  }
  return profile;
}

function confidenceFor(sampleCount, percentSpan, coverage, residual) {
  if (!sampleCount) return "insufficient";
  if (coverage !== "complete") return "low";
  if (sampleCount >= 5 && percentSpan >= 5 && residual <= 0.35) return "high";
  if (sampleCount >= 2 && percentSpan >= 2) return "medium";
  return "low";
}

function confidenceDetails(target) {
  if (target.method === "insufficient" || !Number.isFinite(target.fullWindowTokens)) {
    return { confidenceScore: 0, confidenceReasons: ["insufficient_samples"] };
  }
  const reasons = [];
  if (target.sampleCount < 5) reasons.push("few_samples");
  if (target.percentSpan < 5) reasons.push("small_percent_span");
  if (target.coverage !== "complete") reasons.push("provisional_coverage");
  if (target.method === "extrapolated") reasons.push("cache_extrapolation");
  if (target.method === "modeled") reasons.push("price_prior");
  if (target.residual > 0.35) reasons.push("fit_residual");
  const methodScore = target.method === "interpolated" ? 15 : target.method === "local" ? 12 : target.method === "modeled" ? 8 : 4;
  const residualScore = Number.isFinite(target.residual) ? 20 * Math.max(0, 1 - Math.min(1, target.residual)) : 0;
  const score = Math.min(25, target.sampleCount * 5)
    + Math.min(20, target.percentSpan * 4)
    + (target.coverage === "complete" ? 20 : 8)
    + methodScore + residualScore;
  return { confidenceScore: Math.round(score), confidenceReasons: reasons };
}

function costCapacity(intervals, now) {
  const costed = intervals.filter((interval) => interval.costCny > 0);
  if (!costed.length) return {};
  const weights = costed.map((interval) => baseWeight(interval, now));
  const values = costed.map((interval) => interval.costCny * 100 / interval.dp);
  return {
    fullWindowCostCny: weightedQuantile(values, weights, 0.5),
    lowCostCny: weightedQuantile(values, weights, 0.25),
    highCostCny: weightedQuantile(values, weights, 0.75),
    costBasis: "api-list-price",
  };
}

function targetCostPerToken(profile, cacheHitRate, settings) {
  let mixed = 0;
  for (const [model, shape] of Object.entries(profile)) {
    const input = 1000;
    const cacheCreate = Math.min(shape.cacheCreate, 1 - cacheHitRate) * input;
    const usage = {
      inputOther: Math.max(0, input - cacheHitRate * input - cacheCreate),
      inputCacheRead: cacheHitRate * input,
      inputCacheCreation: cacheCreate,
      output: shape.output * input,
    };
    const totalTokens = TOKEN_TYPES.reduce((sum, key) => sum + usage[key], 0);
    const cost = costForUsage(model, usage, { settings }).total;
    mixed += shape.mix * (totalTokens > 0 ? cost / totalTokens : 0);
  }
  return mixed;
}

function tokensFromCost(monetary, profile, cacheHitRate, settings) {
  if (!Number.isFinite(monetary.fullWindowCostCny) || monetary.fullWindowCostCny <= 0) return null;
  const costPerToken = targetCostPerToken(profile, cacheHitRate, settings);
  if (!(costPerToken > 0)) return null;
  return {
    fullWindowTokens: monetary.fullWindowCostCny / costPerToken,
    low: monetary.lowCostCny / costPerToken,
    high: monetary.highCostCny / costPerToken,
  };
}

function modeledTarget(intervals, cacheHitRate, common, now, settings, observedMin, observedMax) {
  const monetary = costCapacity(intervals, now);
  const tokenValues = tokensFromCost(monetary, modelProfile(intervals), cacheHitRate, settings);
  if (!tokenValues) return null;
  return {
    ...common,
    ...monetary,
    ...tokenValues,
    confidence: "low",
    method: observedMin !== null && cacheHitRate >= observedMin && cacheHitRate <= observedMax ? "modeled" : "extrapolated",
  };
}

function estimateWindow(intervals, { now = Date.now(), settings = null } = {}) {
  const all = (intervals || []).filter((interval) => interval.dp > 0);
  const complete = all.filter((interval) => ["complete", "provisional"].includes(interval.coverage) && interval.totalTokens > 0);
  const coverage = all.some((interval) => interval.coverage !== "complete") ? "provisional" : "complete";
  const sampleCount = complete.length;
  const percentSpan = complete.reduce((sum, interval) => sum + interval.dp, 0);
  if (!sampleCount) {
    return { targets: CACHE_TARGETS.map((cacheHitRate) => ({ cacheHitRate, confidence: "insufficient", method: "insufficient", sampleCount: 0, coverage, confidenceScore: 0, confidenceReasons: ["insufficient_samples"] })) };
  }

  const weights = complete.map((interval) => baseWeight(interval, now));
  const pointEstimates = complete.map((interval) => interval.totalTokens * 100 / interval.dp);
  const basicMedian = weightedQuantile(pointEstimates, weights, 0.5);
  const basicLow = weightedQuantile(pointEstimates, weights, 0.25);
  const basicHigh = weightedQuantile(pointEstimates, weights, 0.75);
  const fit = sampleCount >= 5 && percentSpan >= 5 ? fitRates(complete, now) : null;
  const profile = modelProfile(complete);
  const observedRates = complete.map((interval) => interval.cacheHitRate).filter((rate) => rate > 0);
  const observedMin = observedRates.length ? Math.min(...observedRates) : null;
  const observedMax = observedRates.length ? Math.max(...observedRates) : null;
  const residual = fit ? fit.residual : 1;
  const confidence = confidenceFor(sampleCount, percentSpan, coverage, residual);
  const dataRange = { start: new Date(Math.min(...complete.map((i) => i.start))).toISOString(), end: new Date(Math.max(...complete.map((i) => i.end))).toISOString() };
  const monetary = costCapacity(complete, now);
  const resolvedSettings = settings || loadSettings();

  const targets = CACHE_TARGETS.map((cacheHitRate) => {
    const common = { cacheHitRate, sampleCount, percentSpan, coverage, confidence, residual, dataRange, modelMix: profile };
    if (fit && basicMedian > 0) {
      const pricedTokens = tokensFromCost(monetary, profile, cacheHitRate, resolvedSettings);
      if (pricedTokens) {
        return {
          ...common,
          ...monetary,
          ...pricedTokens,
          method: observedMin !== null && cacheHitRate >= observedMin && cacheHitRate <= observedMax ? "interpolated" : "extrapolated",
        };
      }
      let consumption = 0;
      let outputRatio = 0;
      for (const [model, shape] of Object.entries(profile)) {
        const rates = fit.rates[model] || {};
        const cacheCreate = Math.min(shape.cacheCreate, 1 - cacheHitRate);
        const uncached = Math.max(0, 1 - cacheHitRate - cacheCreate);
        const modelConsumption = uncached * (rates.inputOther || 0)
          + cacheHitRate * (rates.inputCacheRead || 0)
          + cacheCreate * (rates.inputCacheCreation || 0)
          + shape.output * (rates.output || 0);
        consumption += shape.mix * modelConsumption;
        outputRatio += shape.mix * shape.output;
      }
      const fullWindowTokens = consumption > 0 ? 100 * (1 + outputRatio) * 1_000_000 / consumption : null;
      if (Number.isFinite(fullWindowTokens) && fullWindowTokens > 0 && fullWindowTokens < 1e15) {
        const ratio = fullWindowTokens / basicMedian;
        return {
          ...common,
          ...monetary,
          method: observedMin !== null && cacheHitRate >= observedMin && cacheHitRate <= observedMax ? "interpolated" : "extrapolated",
          fullWindowTokens,
          low: Math.max(0, basicLow * ratio),
          high: Math.max(0, basicHigh * ratio),
        };
      }
    }

    for (const bandwidth of [0.025, 0.05]) {
      const nearby = complete.filter((interval) => interval.dominantModelShare >= 0.9 && Math.abs(interval.cacheHitRate - cacheHitRate) <= bandwidth);
      if (!nearby.length) continue;
      const values = nearby.map((interval) => interval.totalTokens * 100 / interval.dp);
      const localWeights = nearby.map((interval) => baseWeight(interval, now) / Math.max(0.005, Math.abs(interval.cacheHitRate - cacheHitRate)));
      const fullWindowTokens = weightedQuantile(values, localWeights, 0.5);
      const localMonetary = costCapacity(nearby, now);
      const pricedTokens = tokensFromCost(localMonetary, modelProfile(nearby), cacheHitRate, resolvedSettings);
      return {
        ...common,
        ...localMonetary,
        sampleCount: nearby.length,
        percentSpan: nearby.reduce((sum, interval) => sum + interval.dp, 0),
        confidence: confidenceFor(nearby.length, nearby.reduce((sum, interval) => sum + interval.dp, 0), coverage, 1),
        method: "local",
        ...(pricedTokens || {
          fullWindowTokens,
          low: weightedQuantile(values, localWeights, 0.25),
          high: weightedQuantile(values, localWeights, 0.75),
        }),
      };
    }

    const modeled = modeledTarget(complete, cacheHitRate, common, now, resolvedSettings, observedMin, observedMax);
    if (modeled) return modeled;
    return { ...common, confidence: "insufficient", method: "insufficient", fullWindowTokens: null, fullWindowCostCny: null, low: null, high: null };
  }).map((target) => ({ ...target, ...confidenceDetails(target) }));
  return { targets, residual, sampleCount, percentSpan, coverage };
}

function estimateCapacity({ samples, records, provider, usageScope = "all-clients", accountKey = null, isComplete, now = Date.now(), settings = null }) {
  const targets = [];
  const longTermTargets = [];
  for (const window of ["session", "weekly"]) {
    const windowSamples = (samples || []).filter((s) => s.provider === provider && s.window === window && (!accountKey || s.accountKey === accountKey));
    const intervals = buildIntervals({ samples: windowSamples, records, provider, window, usageScope, accountKey, isComplete });
    const estimated = estimateWindow(intervals, { now, settings });
    for (const target of estimated.targets) targets.push({ window, ...target, estimateKind: "standard" });

    const automaticSamples = windowSamples.filter((sample) => sample.source !== "manual-calibration");
    const minimumDuration = window === "session" ? 30 * 60_000 : 6 * 3_600_000;
    const longIntervals = buildIntervals({ samples: automaticSamples, records, provider, window, usageScope, accountKey, isComplete })
      .filter((interval) => interval.durationMs >= minimumDuration && interval.coverage === "complete");
    const longSpan = longIntervals.reduce((sum, interval) => sum + interval.dp, 0);
    const longEstimated = longIntervals.length >= 3 && longSpan >= 5
      ? estimateWindow(longIntervals, { now, settings })
      : estimateWindow([], { now, settings });
    for (const target of longEstimated.targets) longTermTargets.push({ window, ...target, estimateKind: "long-term" });
  }
  return { provider, usageScope, accountKey, generatedAt: new Date(now).toISOString(), algorithmVersion: 3, targets, longTermTargets };
}

module.exports = { CACHE_TARGETS, TOKEN_TYPES, buildIntervals, estimateWindow, estimateCapacity, fitRates, weightedQuantile };
