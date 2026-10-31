"use strict";

/**
 * Step-1 equivalence guard for query-time bucket pricing.
 *
 * Invariant: folding each record into a (model, rateKey) cell and pricing
 * the cell with priceForCell at query time reproduces costForUsage per
 * record, and reproduces the SUM of per-record costs for merged cells,
 * within floating-point summation tolerance.
 */

const test = require("node:test");
const assert = require("node:assert");
const {
  costForUsage,
  costCacheCreation,
  rateKeyFor,
  priceForCell,
} = require("../src/pricing");

const EPS = 1e-9;

/** Deterministic pseudo-random generator so failures replay exactly. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rnd = mulberry32(20261024);
const randInt = (min, max) => Math.floor(min + rnd() * (max - min + 1));

function randomUsage(longContext = false) {
  // Non-long corpus stays under 272K single-request input so OpenAI models
  // never spill into the long tier unintentionally.
  const base = longContext ? randInt(272_001, 400_000) : randInt(0, 272_000);
  const cached = randInt(0, Math.max(0, Math.floor(base * 0.9)));
  const cacheCreate = randInt(0, 20_000);
  return {
    inputOther: Math.max(0, base - cached),
    output: randInt(0, 60_000),
    inputCacheRead: cached,
    inputCacheCreation: cacheCreate,
  };
}

// A representative corpus across every pricing modifier class:
// Kimi (std/CNY), GLM (std), Qwen/Claude/MiniMax (std/USD),
// DeepSeek (peak/off/no-timestamp), OpenAI (std/long), unknown (fallback).
const MODELS = [
  "kimi-k3.1-pro",
  "kimi-k2.6",
  "glm-5.3-flash",
  "qwen3.8-flash",
  "claude-sonnet-5",
  "minimax-m3",
  "deepseek-flash",
  "deepseek-v4-pro",
  "gpt-6-sol",
  "gpt-5.6-luna",
  "codex-auto-review",
  "totally-unknown-model",
];

// Beijing-aware timestamps: Tue 2026-10-20 (weekday), 10:00 peak;
// 20:00 off-peak; Oct 1 national holiday (off-peak); and no timestamp.
const TIMES = [
  { label: "weekday-peak", time: Date.UTC(2026, 9, 20, 2, 0, 0) },
  { label: "weekday-night", time: Date.UTC(2026, 9, 20, 12, 0, 0) },
  { label: "holiday", time: Date.UTC(2026, 9, 1, 2, 0, 0) },
  { label: "no-time", time: undefined },
];

const SETTINGS_CASES = [
  { label: "no-custom", customPrices: [], fxRate: 7.2 },
  { label: "fx-6.5", customPrices: [], fxRate: 6.5 },
  {
    label: "custom-full-deepseek",
    customPrices: [{ model: "deepseek-flash", currency: "CNY", input: 3, cacheHit: 0.1, output: 10 }],
    fxRate: 7.2,
  },
  {
    label: "custom-partial-openai",
    // Only input overridden — cacheHit/output must inherit the multiplied
    // official (incl. long-context multiplier) rates, like costForUsage.
    customPrices: [{ model: "gpt-6-sol", currency: "USD", input: 2.5, cacheHit: null, output: null }],
    fxRate: 7.2,
  },
  {
    label: "custom-substring-kimi",
    customPrices: [{ model: "kimi-k3", currency: "CNY", input: 15, cacheHit: 1.5, output: 80 }],
    fxRate: 7.2,
  },
];

function perRecordCostViaCell(model, usage, time, settings) {
  const { key } = rateKeyFor(model, usage, time);
  const p = priceForCell(model, key, settings);
  return (
    (usage.inputOther / 1e6) * p.input +
    (usage.inputCacheRead / 1e6) * p.cacheHit +
    costCacheCreation(usage, p) +
    (usage.output / 1e6) * p.output
  );
}

test("bucket pricing: per-record equivalence across the full corpus", () => {
  let checked = 0;
  for (const model of MODELS) {
    for (const { label, time } of TIMES) {
      for (const settings of SETTINGS_CASES) {
        for (let n = 0; n < 25; n++) {
          const usage = randomUsage(false);
          if (!usage.time) usage.time = time;
          const direct = costForUsage(model, { ...usage, time }, { settings });
          const viaCell = perRecordCostViaCell(model, usage, time, settings);
          assert.ok(
            Math.abs(direct.total - viaCell) <= EPS,
            `${model} ${label} ${settings.label}: costForUsage=${direct.total} cell=${viaCell}`
          );
          checked += 1;
        }
      }
    }
  }
  assert.ok(checked > 5000, `corpus too small: ${checked}`);
});

test("bucket pricing: long-context tier equivalence per record", () => {
  for (const model of ["gpt-6-sol", "gpt-5.6-sol", "gpt-6-luna", "deepseek-flash"]) {
    for (const settings of SETTINGS_CASES) {
      for (let n = 0; n < 30; n++) {
        const usage = randomUsage(true); // >272K single-request input
        const time = Date.UTC(2026, 9, 20, 2, 0, 0);
        const direct = costForUsage(model, { ...usage, time }, { settings });
        const viaCell = perRecordCostViaCell(model, usage, time, settings);
        assert.ok(
          Math.abs(direct.total - viaCell) <= EPS,
          `${model} long ${settings.label}: ${direct.total} vs ${viaCell}`
        );
        if (model !== "deepseek-flash") {
          assert.equal(rateKeyFor(model, usage, time).key, "long");
        } else {
          // DeepSeek rows carry no long-context threshold.
          assert.notEqual(rateKeyFor(model, usage, time).key, "long");
        }
      }
    }
  }
});

test("bucket pricing: merged-cell equivalence (sum of records priced once)", () => {
  // Records of one model fold into per-rateKey cells; each cell is priced
  // once. Sum-of-per-record costs must equal Σ cell-token × cell-price.
  for (const model of MODELS) {
    for (const { time } of TIMES) {
      for (const settings of SETTINGS_CASES) {
        const cells = new Map();
        let directSum = 0;
        for (let n = 0; n < 12; n++) {
          const usage = randomUsage(false);
          const direct = costForUsage(model, { ...usage, time }, { settings });
          directSum += direct.total;
          const { key } = rateKeyFor(model, usage, time);
          if (!cells.has(key)) {
            cells.set(key, { i: 0, o: 0, cr: 0, cc: 0 });
          }
          const cell = cells.get(key);
          cell.i += usage.inputOther;
          cell.o += usage.output;
          cell.cr += usage.inputCacheRead;
          cell.cc += usage.inputCacheCreation;
        }
        let cellSum = 0;
        for (const [key, cell] of cells) {
          const p = priceForCell(model, key, settings);
          cellSum +=
            (cell.i / 1e6) * p.input +
            (cell.cr / 1e6) * p.cacheHit +
            costCacheCreation({ inputCacheCreation: cell.cc }, p) +
            (cell.o / 1e6) * p.output;
        }
        assert.ok(
          Math.abs(directSum - cellSum) <= EPS,
          `${model} merged (${cells.size} cells): sum=${directSum} cell=${cellSum}`
        );
      }
    }
  }
});

test("bucket pricing: preserves exact TTL tiers and averages only untyped cache writes", () => {
  const { bucketFromRecords, mergeBuckets } = require("../src/buckets");
  const { aggregateFromBuckets } = require("../src/aggregate");
  const base = {
    tool: "claude-code",
    model: "claude-sonnet-5",
    modelResolved: "claude-sonnet-5",
    time: Date.UTC(2026, 9, 20, 2),
    inputOther: 0,
    output: 0,
    inputCacheRead: 0,
  };
  const typed = { ...base, inputCacheCreation: 100_000, inputCacheCreationShort: 25_000, inputCacheCreationLong: 75_000 };
  const untyped = { ...base, inputCacheCreation: 100_000 };
  const bucket = bucketFromRecords([typed, untyped], [], "typed-ttl", null);
  const stats = aggregateFromBuckets([mergeBuckets([bucket])], { range: "all", fxRate: 7.2, customPrices: [] });
  const direct = costForUsage(base.model, typed, { settings: { fxRate: 7.2, customPrices: [] } }).total +
    costForUsage(base.model, untyped, { settings: { fxRate: 7.2, customPrices: [] } }).total;
  assert.ok(Math.abs(stats.totals.costCny - direct) < EPS);
  assert.equal(stats.totals.inputCacheCreation, 200_000);
  assert.equal(stats.models[0].costEstimated, true);
});

test("bucket pricing: rateKey classification sanity", () => {
  const peak = rateKeyFor("deepseek-flash", randomUsage(), Date.UTC(2026, 9, 20, 2, 0, 0));
  assert.equal(peak.key, "peak");
  const off = rateKeyFor("deepseek-flash", randomUsage(), Date.UTC(2026, 9, 20, 12, 0, 0));
  assert.equal(off.key, "off");
  const holiday = rateKeyFor("deepseek-flash", randomUsage(), Date.UTC(2026, 9, 1, 2, 0, 0));
  assert.equal(holiday.key, "off");
  const noTime = rateKeyFor("deepseek-flash", randomUsage(), undefined);
  assert.equal(noTime.key, "peak");
  assert.equal(noTime.estimated, true, "no-timestamp DeepSeek stays estimated");
  assert.equal(rateKeyFor("kimi-k2.6", randomUsage(), undefined).key, "std");
  assert.equal(rateKeyFor("nope", randomUsage(), undefined).estimated, true);
});
