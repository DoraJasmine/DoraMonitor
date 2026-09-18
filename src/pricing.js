"use strict";

const { loadSettings } = require("./settings");

/**
 * Official Kimi API Platform list prices (USD per 1M tokens).
 * Sources: https://platform.kimi.ai/  and /docs/pricing/*
 * Fields: cacheHit (input cache read), input (non-cache / miss), output
 * cacheCreation is billed at the input rate when not separately listed.
 *
 * User-defined prices (settings.customPrices) take precedence: exact model
 * match first, then case-insensitive substring. Prices entered in a non-USD
 * currency are converted to USD at the configured fx rate so internal costs
 * stay in one currency; the display layer converts back for CNY display.
 */
const KIMI_PRICES = [
  {
    id: "kimi-k3",
    // k3-256k is the same model at a longer context — same unit price.
    patterns: [/^kimi-k3$/i, /^k3$/i, /\/kimi-k3$/i, /kimi[_-]?k3/i, /k3[_-]?256k/i],
    cacheHit: 0.3,
    input: 3.0,
    output: 15.0,
    context: 1_048_576,
  },
  {
    id: "kimi-k2.7-code",
    // kimi-for-coding is the Coding Plan model id — priced as k2.7-code.
    patterns: [/^kimi-k2\.7-code$/i, /kimi[_-]?k2\.7[_-]?code/i, /k2\.7[_-]?code/i, /kimi[_-]?for[_-]?coding/i],
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

/**
 * Official OpenAI platform list prices (USD per 1M tokens), used by the
 * Codex provider. Sources: https://openai.com/api/pricing/ plus vendor
 * mirrors. GPT-5.6 family prices reflect the 2026-07-30 update
 * (Luna -80%, Terra -20%); a bare "gpt-5.6" id routes to Sol.
 * codex-auto-review is a plan-included background model with no public
 * list price — costed like Luna and flagged as an estimate.
 */
const OPENAI_PRICES = [
  {
    id: "gpt-6-astra",
    patterns: [/gpt[_-]?6[_-]?astra/i],
    cacheHit: 1.0,
    input: 10.0,
    output: 50.0,
    context: 1_050_000,
  },
  {
    id: "gpt-5.6-sol",
    patterns: [/gpt[_-]?5\.6[_-]?sol/i],
    cacheHit: 0.5,
    input: 5.0,
    output: 30.0,
    context: 1_050_000,
  },
  {
    id: "gpt-5.6-terra",
    patterns: [/gpt[_-]?5\.6[_-]?terra/i],
    cacheHit: 0.2,
    input: 2.0,
    output: 12.0,
    context: 1_050_000,
  },
  {
    id: "gpt-5.6-luna",
    patterns: [/gpt[_-]?5\.6[_-]?luna/i],
    cacheHit: 0.02,
    input: 0.2,
    output: 1.2,
    context: 1_050_000,
  },
  {
    // bare "gpt-5.6" aliases to Sol
    id: "gpt-5.6",
    patterns: [/gpt[_-]?5\.6/i],
    cacheHit: 0.5,
    input: 5.0,
    output: 30.0,
    context: 1_050_000,
  },
  {
    id: "gpt-5",
    patterns: [/gpt[_-]?5/i, /o[34][-_]?mini/i],
    cacheHit: 0.125,
    input: 1.25,
    output: 10.0,
    context: 400_000,
  },
  {
    id: "codex-auto-review",
    patterns: [/codex[_-]?auto[_-]?review/i],
    cacheHit: 0.02,
    input: 0.2,
    output: 1.2,
    context: null,
    estimated: true,
  },
];

function matchPrice(modelName) {
  if (!modelName) return { ...FALLBACK_PRICE, match: null };
  const name = String(modelName);
  // Prefer the bare model segment after provider/
  const bare = name.includes("/") ? name.split("/").pop() : name;
  for (const row of [...KIMI_PRICES, ...OPENAI_PRICES]) {
    for (const re of row.patterns) {
      if (re.test(bare) || re.test(name)) {
        return {
          id: row.id,
          cacheHit: row.cacheHit,
          input: row.input,
          output: row.output,
          context: row.context,
          estimated: !!row.estimated,
          match: bare,
        };
      }
    }
  }
  return { ...FALLBACK_PRICE, match: bare, estimated: true };
}

/** USD per 1M for one custom-price component (null when not set). */
function customComponentUsd(value, currency, fxRate) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return currency === "CNY" ? n / fxRate : n;
}

/**
 * Try to match modelName against user-defined custom prices.
 * Exact (case-insensitive) match first, then substring; longest pattern wins
 * so "glm-5.3-flash" beats "glm-5.3".
 */
function matchCustomPrice(modelName, customPrices, fxRate) {
  if (!Array.isArray(customPrices) || !customPrices.length || !modelName) return null;
  const name = String(modelName).toLowerCase();
  const bare = name.includes("/") ? name.split("/").pop() : name;
  let best = null;
  let bestLen = -1;
  for (const p of customPrices) {
    const pattern = String(p.model || "").toLowerCase();
    if (!pattern) continue;
    const hit = bare === pattern || name === pattern || bare.includes(pattern) || name.includes(pattern);
    if (hit && pattern.length > bestLen) {
      best = p;
      bestLen = pattern.length;
    }
  }
  if (!best) return null;
  const fx = Number(fxRate) > 0 ? Number(fxRate) : 7.2;
  const input = customComponentUsd(best.input, best.currency, fx);
  const cacheHit = customComponentUsd(best.cacheHit, best.currency, fx);
  const output = customComponentUsd(best.output, best.currency, fx);
  // Missing components fall back to the official fallback row so partial
  // price definitions still produce a full cost breakdown.
  return {
    id: `custom:${best.model}`,
    input: input ?? FALLBACK_PRICE.input,
    cacheHit: cacheHit ?? FALLBACK_PRICE.cacheHit,
    output: output ?? FALLBACK_PRICE.output,
    context: null,
    estimated: false,
    custom: true,
    match: best.model,
  };
}

/**
 * Cost for one usage record, in USD.
 * usage fields from Kimi Code wire:
 *   inputOther, output, inputCacheRead, inputCacheCreation
 * Custom prices from settings take precedence over the official table.
 */
function costForUsage(modelName, usage, options = {}) {
  let settings = options.settings;
  if (!settings && !options.skipSettings) {
    try {
      settings = loadSettings();
    } catch {
      settings = null;
    }
  }
  const custom = settings ? matchCustomPrice(modelName, settings.customPrices, settings.fxRate) : null;
  const price = custom || matchPrice(modelName);
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
    custom: !!price.custom,
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
  OPENAI_PRICES,
  FALLBACK_PRICE,
  matchPrice,
  matchCustomPrice,
  costForUsage,
  listPrices,
};
