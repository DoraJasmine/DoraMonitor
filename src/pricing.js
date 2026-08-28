"use strict";

/**
 * Official Kimi API Platform list prices (USD per 1M tokens).
 * Sources: https://platform.kimi.ai/  and /docs/pricing/*
 * Fields: cacheHit (input cache read), input (non-cache / miss), output
 * cacheCreation is billed at the input rate when not separately listed.
 */
const KIMI_PRICES = [
  {
    id: "kimi-k3",
    patterns: [/^kimi-k3$/i, /^k3$/i, /\/kimi-k3$/i, /kimi[_-]?k3/i],
    cacheHit: 0.3,
    input: 3.0,
    output: 15.0,
    context: 1_048_576,
  },
  {
    id: "kimi-k2.7-code",
    patterns: [/^kimi-k2\.7-code$/i, /kimi[_-]?k2\.7[_-]?code/i, /k2\.7[_-]?code/i],
    cacheHit: 0.19,
    input: 0.95,
    output: 4.0,
    context: 262_144,
  },
  {
    id: "kimi-k2.6",
    patterns: [/^kimi-k2\.6$/i, /kimi[_-]?k2\.6/i, /k2\.6/i],
    cacheHit: 0.16,
    input: 0.95,
    output: 4.0,
    context: 262_144,
  },
  {
    id: "kimi-k2.5",
    patterns: [/^kimi-k2\.5$/i, /kimi[_-]?k2\.5/i, /k2\.5/i],
    cacheHit: 0.1,
    input: 0.6,
    output: 3.0,
    context: 262_144,
  },
  {
    id: "kimi-k2-turbo",
    patterns: [/kimi[_-]?k2[_-]?turbo/i, /k2[_-]?thinking[_-]?turbo/i, /k2[_-]?turbo/i],
    cacheHit: 0.15,
    input: 1.15,
    output: 8.0,
    context: 262_144,
  },
  {
    id: "kimi-k2",
    patterns: [
      /^kimi-k2$/i,
      /kimi[_-]?k2[_-]?(0905|0711|thinking)/i,
      /kimi[_-]?k2/i,
      /\bk2\b/i,
    ],
    cacheHit: 0.15,
    input: 0.6,
    output: 2.5,
    context: 262_144,
  },
];

/** Fallback when model cannot be mapped to a Kimi SKU — estimate only. */
const FALLBACK_PRICE = {
  id: "kimi-k2.6",
  cacheHit: 0.16,
  input: 0.95,
  output: 4.0,
  estimated: true,
};

function matchPrice(modelName) {
  if (!modelName) return { ...FALLBACK_PRICE, match: null };
  const name = String(modelName);
  // Prefer the bare model segment after provider/
  const bare = name.includes("/") ? name.split("/").pop() : name;
  for (const row of KIMI_PRICES) {
    for (const re of row.patterns) {
      if (re.test(bare) || re.test(name)) {
        return {
          id: row.id,
          cacheHit: row.cacheHit,
          input: row.input,
          output: row.output,
          context: row.context,
          estimated: false,
          match: bare,
        };
      }
    }
  }
  return { ...FALLBACK_PRICE, match: bare, estimated: true };
}

/**
 * Cost for one usage.record in USD.
 * usage fields from Kimi Code wire:
 *   inputOther, output, inputCacheRead, inputCacheCreation
 */
function costForUsage(modelName, usage) {
  const price = matchPrice(modelName);
  const u = usage || {};
  const inputOther = num(u.inputOther);
  const output = num(u.output);
  const cacheRead = num(u.inputCacheRead);
  const cacheCreate = num(u.inputCacheCreation);

  const costInput = (inputOther / 1e6) * price.input;
  const costCacheRead = (cacheRead / 1e6) * price.cacheHit;
  // Cache creation is not separately listed on platform pages; bill as input.
  const costCacheCreate = (cacheCreate / 1e6) * price.input;
  const costOutput = (output / 1e6) * price.output;
  const total = costInput + costCacheRead + costCacheCreate + costOutput;

  return {
    total,
    breakdown: {
      input: costInput,
      cacheRead: costCacheRead,
      cacheCreate: costCacheCreate,
      output: costOutput,
    },
    priceId: price.id,
    estimated: !!price.estimated,
  };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function listPrices() {
  return KIMI_PRICES.map((p) => ({
    id: p.id,
    cacheHit: p.cacheHit,
    input: p.input,
    output: p.output,
    context: p.context,
    unit: "USD / 1M tokens",
    source: "https://platform.kimi.ai/",
  }));
}

module.exports = {
  KIMI_PRICES,
  FALLBACK_PRICE,
  matchPrice,
  costForUsage,
  listPrices,
};
