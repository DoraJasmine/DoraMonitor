"use strict";

const { loadSettings } = require("./settings");

/**
 * Official Kimi China API Platform list prices (CNY per 1M tokens).
 * Source: https://platform.kimi.com/
 * Fields: cacheHit (input cache read), input (non-cache / miss), output.
 * cacheCreation is billed at the input rate when not separately listed. Tiered
 * writes use exact TTL counts when available and the two-tier simple average otherwise.
 *
 * User-defined prices (settings.customPrices) take precedence: exact model
 * match first, then case-insensitive substring. Each provider's native list
 * price remains the source of truth. Values are normalized to CNY for the
 * internal cost ledger; only USD-denominated providers (OpenAI) use fxRate
 * during accounting. The display layer divides by fxRate when USD is chosen.
 */
const KIMI_PRICES = [
  {
    // High-speed K3.1 Pro variant, listed at exactly 2× the standard K3.1
    // Pro rates (cache reads stay at ¥1.30). Must precede the kimi-k3.1-pro
    // row: /k3[._-]1[_-]?pro/ matches the highspeed id too.
    id: "kimi-k3.1-pro-highspeed",
    patterns: [
      /^kimi-k3[._-]1[_-]?pro[_-]?highspeed$/i,
      /k3[._-]1[_-]?pro[_-]?highspeed/i,
    ],
    cacheHit: 1.3,
    cacheWrite: 26.0,
    cacheWriteLong: 52.0,
    input: 26.0,
    output: 136.0,
    context: 1_048_576,
    currency: "CNY",
  },
  {
    // Official China API prices, published 2026-10-24 on the pricing page.
    // Official cache write bills by TTL: ¥13 (5min) / ¥26 (1h).
    // Must precede the kimi-k3 row: /kimi[_-]?k3/ matches K3.1 ids too.
    id: "kimi-k3.1-pro",
    patterns: [/^kimi-k3[._-]1(?:[-_ ]?pro)?$/i, /kimi[_-]?k3[._-]1/i, /k3[._-]1[_-]?pro/i],
    cacheHit: 1.3,
    cacheWrite: 13.0,
    cacheWriteLong: 26.0,
    input: 13.0,
    output: 68.0,
    context: 1_048_576,
    currency: "CNY",
  },
  {
    id: "kimi-k3",
    // k3-256k is the same model at a longer context — same unit price.
    // Official cache write bills by TTL: ¥20 (5min) / ¥40 (1h).
    patterns: [/^kimi-k3$/i, /^k3$/i, /\/kimi-k3$/i, /kimi[_-]?k3/i, /k3[_-]?256k/i],
    cacheHit: 2.0,
    cacheWrite: 20.0,
    cacheWriteLong: 40.0,
    input: 20.0,
    output: 100.0,
    context: 1_048_576,
    currency: "CNY",
  },
  {
    // High-speed K2.7 Code variant (~180 tok/s output), listed on the
    // official price page at exactly 2× the standard K2.7 Code rates.
    // Must precede the kimi-k2.7-code row: /k2\.7[_-]?code/ matches the
    // highspeed id too.
    id: "kimi-k2.7-code-highspeed",
    patterns: [
      /^kimi-k2\.7-code-highspeed$/i,
      /k2\.7[_-]?code[_-]?highspeed/i,
      // The Coding Plan highspeed tier (config label: K2.7 Code Highspeed).
      /kimi[_-]?for[_-]?coding[_-]?highspeed/i,
    ],
    cacheHit: 2.6,
    input: 13.0,
    output: 54.0,
    context: 262_144,
    currency: "CNY",
  },
  {
    id: "kimi-k2.7-code",
    // kimi-for-coding is the Coding Plan model id. The plan currently serves
    // it as K2.8 Preview (Kimi Code model picker, 2026-10-24), but with no
    // published K2.8 API price it keeps billing at these K2.7 Code rates.
    // K2 models stop accepting new users 2026-10-31 and retire end of
    // 2026-12 (existing users unaffected); prices stay until then.
    patterns: [/^kimi-k2\.7-code$/i, /kimi[_-]?k2\.7[_-]?code/i, /k2\.7[_-]?code/i, /kimi[_-]?for[_-]?coding/i],
    cacheHit: 1.3,
    input: 6.5,
    output: 27.0,
    context: 262_144,
    currency: "CNY",
  },
  {
    id: "kimi-k2.6",
    patterns: [/^kimi-k2\.6$/i, /kimi[_-]?k2\.6/i, /k2\.6/i],
    cacheHit: 1.1,
    input: 6.5,
    output: 27.0,
    context: 262_144,
    currency: "CNY",
  },
];

/**
 * Official DeepSeek API list prices (CNY per 1M tokens).
 *
 * DeepSeek has time-of-use pricing: the values below are the peak prices;
 * off-peak prices are exactly half. Peak time is Monday–Friday, 09:00–12:00
 * and 14:00–18:00 Beijing time, except Chinese statutory holidays.
 * Keep this table separate from Kimi's fallback: a DeepSeek model used to be
 * silently costed as Kimi K2.6.
 * Source: https://api-docs.deepseek.com/quick_start/pricing/
 */
const DEEPSEEK_PRICES = [
  {
    id: "deepseek-flash",
    patterns: [
      /^deepseek[-_ ]?flash$/i,
      // -1017 is a dated internal suffix (codex records it as
      // deepseek-v4.1-flash-1017) — same model, same price row.
      /^deepseek[-_ ]?v4(?:\.1)?[-_ ]?flash(?:[-_ ]?\d{4})?(?:[-_ ]?vision[-_ ]?exp)?$/i,
      /^deepseek[-_ ]?(chat|reasoner)$/i,
      /^dfmodel$/i,
    ],
    cacheHit: 0.04,
    input: 2.0,
    output: 8.0,
    context: 1_000_000,
    currency: "CNY",
    offPeakMultiplier: 0.5,
  },
  {
    id: "deepseek-v4-pro",
    patterns: [/^deepseek[-_ ]?v4[-_ ]?pro(?:[-_ ].*)?$/i, /^dmodel$/i],
    cacheHit: 0.3,
    input: 9.0,
    output: 27.0,
    context: 1_000_000,
    currency: "CNY",
    offPeakMultiplier: 0.5,
  },
];

/**
 * Official Google Gemini API list prices (USD per 1M tokens), used by the
 * Gemini CLI provider. Source: https://ai.google.dev/gemini-api/docs/pricing
 * Gemini context caching bills ~10% of the standard input rate across the
 * family (3.8 Flash's published $0.075 on $0.75 input confirms the ratio);
 * Pro models double above the 200K context tier (input ×2, output ×1.5 —
 * same shape as the OpenAI long-context tier).
 */
const GOOGLE_PRICES = [
  {
    id: "gemini-3.1-pro",
    patterns: [/^gemini[-_ ]?3\.1[-_ ]?pro/i],
    cacheHit: 0.2,
    input: 2.0,
    output: 12.0,
    context: 1_048_576,
    longContextThreshold: 200_000,
    currency: "USD",
  },
  {
    id: "gemini-3.8-flash",
    patterns: [/^gemini[-_ ]?3\.8[-_ ]?flash/i],
    cacheHit: 0.075,
    input: 0.75,
    output: 3.75,
    context: 1_048_576,
    currency: "USD",
  },
  {
    id: "gemini-3-flash",
    patterns: [/^gemini[-_ ]?3[-_ ]?flash/i, /^gemini[-_ ]?3(?:\.0)?$/i],
    cacheHit: 0.05,
    input: 0.5,
    output: 3.0,
    context: 1_048_576,
    currency: "USD",
  },
];

/**
 * Official BigModel China list prices (CNY per 1M tokens).
 * Source: https://docs.bigmodel.cn/cn/guide/models
 * These are the current standard China API prices. BigModel currently lists
 * cache storage as free for a limited time, so cache creation is zero-rated.
 */
const ZHIPU_PRICES = [
  {
    id: "glm-5.3-flash",
    patterns: [/^glm[-_ ]?5\.3[-_ ]?flash$/i],
    cacheHit: 0.23,
    cacheWrite: 0,
    input: 0.8,
    output: 2.8,
    context: 1_000_000,
    currency: "CNY",
  },
  {
    id: "glm-5.3",
    patterns: [/^glm[-_ ]?5\.3$/i],
    cacheHit: 2.0,
    cacheWrite: 0,
    input: 8.0,
    output: 28.0,
    context: 1_000_000,
    currency: "CNY",
  },
];

/**
 * Alibaba Model Studio / QoderCN Qwen list prices (USD per 1M tokens).
 *
 * QoderCN records internal routing codes (qmodel_latest, qfmodel, ...) rather
 * than model ids; model-identity.js maps those to the ids below so traffic is
 * priced as the model actually served instead of falling through to the Kimi
 * fallback. Sources: https://opencode.ai/docs/go (cached 2026-08-17) and
 * https://www.alibabacloud.com/help/en/model-studio/model-pricing
 */
const QWEN_PRICES = [
  {
    id: "qwen3.8-max-preview",
    patterns: [/^qwen3\.8[-_ ]?max(?:[-_ ]?preview)?$/i],
    cacheHit: 0.25,
    cacheWrite: 2.5,
    input: 2.0,
    output: 6.0,
    context: 1_000_000,
    currency: "USD",
  },
  {
    id: "qwen3.8-flash",
    // Verified against dsh's own cost meter (dsh-cost-meter
    // provider-pricing.json, checkedAt 2026-10-03, source opencode.ai/docs/go)
    // so both dashboards bill the same model at the same rate.
    patterns: [/^qwen3\.8[-_ ]?flash$/i],
    cacheHit: 0.016,
    cacheWrite: 0.2,
    input: 0.15,
    output: 0.47,
    context: 1_000_000,
    currency: "USD",
  },
  {
    id: "qwen3.7-max",
    patterns: [/^qwen3\.7[-_ ]?max$/i],
    cacheHit: 0.5,
    cacheWrite: 3.125,
    input: 2.5,
    output: 7.5,
    context: 1_000_000,
    currency: "USD",
  },
  {
    id: "qwen3.7-plus",
    patterns: [/^qwen3\.7[-_ ]?plus$/i, /^qwen3\.7$/i],
    cacheHit: 0.04,
    cacheWrite: 0.5,
    input: 0.4,
    output: 1.6,
    context: 1_000_000,
    currency: "USD",
  },
  {
    id: "qwen3.6-flash",
    patterns: [/^qwen3\.6[-_ ]?flash$/i],
    cacheHit: 0.04,
    cacheWrite: 0.5,
    input: 0.25,
    output: 1.5,
    context: 1_000_000,
    currency: "USD",
  },
  {
    id: "qwen3.6-plus",
    patterns: [/^qwen3\.6[-_ ]?plus$/i],
    cacheHit: 0.05,
    cacheWrite: 0.625,
    input: 0.5,
    output: 3.0,
    context: 1_000_000,
    currency: "USD",
  },
  {
    id: "qwen3.5-plus",
    patterns: [/^qwen3\.5[-_ ]?plus$/i],
    cacheHit: 0.02,
    cacheWrite: 0.25,
    input: 0.4,
    output: 2.4,
    context: 1_000_000,
    currency: "USD",
  },
  {
    id: "qwen3-max",
    patterns: [/^qwen3[-_ ]?max$/i],
    cacheHit: 0.3,
    cacheWrite: 2.5,
    input: 1.6,
    output: 6.4,
    context: 262_144,
    currency: "USD",
  },
  {
    id: "qwen3-coder-plus",
    patterns: [/^qwen3[-_ ]?coder[-_ ]?plus$/i, /^qwen3[-_ ]?coder$/i],
    cacheHit: 0.2,
    cacheWrite: 1.0,
    input: 1.0,
    output: 5.0,
    context: 1_000_000,
    currency: "USD",
  },
];

/**
 * MiniMax list prices, used by QoderCN's "mmodel" code. M3 uses the official
 * China rate (CNY); M2.7 retains the published international USD rate.
 * Source: https://platform.minimaxi.com/document/Price
 */
const MINIMAX_PRICES = [
  {
    id: "minimax-m3",
    patterns: [/^minimax[-_ ]?m3$/i],
    cacheHit: 0.42,
    input: 2.1,
    output: 8.4,
    context: 1_000_000,
    currency: "CNY",
  },
  {
    id: "minimax-m2.7",
    patterns: [/^minimax[-_ ]?m2\.7$/i],
    cacheHit: 0.06,
    cacheWrite: 0.375,
    input: 0.3,
    output: 1.2,
    context: 1_000_000,
    currency: "USD",
  },
];

/**
 * Additional Chinese-vendor ids recorded by dsh plugins but absent from the
 * BigModel/Kimi tables above. Sources note the vendor attribution where it is
 * not officially published.
 */
const VENDOR_EXTRA_PRICES = [
  {
    id: "glm-5.2",
    patterns: [/^glm[-_ ]?5\.2$/i],
    cacheHit: 2.0,
    cacheWrite: 0,
    input: 8.0,
    output: 28.0,
    context: 1_000_000,
    currency: "CNY",
  },
  {
    id: "glm-5",
    patterns: [/^glm[-_ ]?5$/i, /^z-?ai\/glm-5$/i],
    cacheHit: 2.0,
    cacheWrite: 0,
    input: 4.0,
    output: 16.0,
    context: 1_000_000,
    currency: "CNY",
  },
  {
    // dsh's buddy plugin records the bare code "hy3". DSH's own cost meter
    // books it under Tencent at the OpenCode Go catalog rate and marks the
    // vendor attribution as unpublished — mirrored here so the number agrees.
    id: "hy3",
    patterns: [/^hy3(?:-x)?$/i, /^hy4[-_]preview$/i],
    cacheHit: 0.035,
    cacheWrite: 0.14,
    input: 0.14,
    output: 0.58,
    context: 192_000,
    estimated: true,
    currency: "USD",
  },
];

const ALL_PRICE_TABLES = () => [
  ...KIMI_PRICES,
  ...DEEPSEEK_PRICES,
  ...GOOGLE_PRICES,
  ...ZHIPU_PRICES,
  ...QWEN_PRICES,
  ...MINIMAX_PRICES,
  ...VENDOR_EXTRA_PRICES,
  ...OPENAI_PRICES,
  ...CLAUDE_PRICES,
];

/** Fallback when model cannot be mapped to a Kimi SKU — estimate only. */
const FALLBACK_PRICE = {
  id: "kimi-k2.6",
  cacheHit: 1.1,
  input: 6.5,
  output: 27.0,
  currency: "CNY",
  estimated: true,
};

/**
 * Official OpenAI platform list prices (USD per 1M tokens), used by the
 * Codex provider. Source: https://developers.openai.com/api/docs/pricing
 * A bare "gpt-5.6" model id routes to GPT-5.6 Sol.
 * codex-auto-review is a plan-included background model with no public
 * list price — costed like Luna and flagged as an estimate.
 */
const OPENAI_PRICES = [
  {
    // Long-context tier assumed to match the rest of the GPT-6 generation
    // (272K threshold). Prompt-cache writes are 30m / 12h.
    id: "gpt-6.1-sol",
    patterns: [/gpt[_-]?6\.1([_-]?sol)?$/i, /gpt[_-]?6\.1[_-]?sol/i, /^gpt[_-]?6\.1$/i],
    cacheHit: 0.1,
    cacheWrite: 2.5,
    cacheWriteLong: 5.0,
    input: 2.0,
    output: 10.0,
    context: 1_050_000,
    longContextThreshold: 272_000,
    currency: "USD",
  },
  {
    id: "gpt-6-astra",
    patterns: [/gpt[_-]?6[_-]?astra/i],
    cacheHit: 1.0,
    cacheWrite: 12.5,
    cacheWriteLong: 25.0,
    input: 10.0,
    output: 50.0,
    context: 1_050_000,
    longContextThreshold: 272_000,
    currency: "USD",
  },
  {
    id: "gpt-6-sol",
    patterns: [/gpt[_-]?6[_-]?sol/i],
    cacheHit: 0.2,
    cacheWrite: 2.5,
    cacheWriteLong: 5.0,
    input: 2.0,
    output: 10.0,
    context: 1_050_000,
    longContextThreshold: 272_000,
    currency: "USD",
  },
  {
    id: "gpt-6-luna",
    patterns: [/gpt[_-]?6[_-]?luna/i],
    cacheHit: 0.01,
    cacheWrite: 0.125,
    cacheWriteLong: 0.25,
    input: 0.1,
    output: 0.5,
    context: 1_050_000,
    longContextThreshold: 272_000,
    currency: "USD",
  },
  {
    id: "gpt-5.6-sol",
    patterns: [/gpt[_-]?5\.6[_-]?sol/i, /^gpt[_-]?5\.6$/i],
    cacheHit: 0.4,
    cacheWrite: 5.0,
    cacheWriteLong: 10.0,
    input: 4.0,
    output: 20.0,
    context: 1_050_000,
    longContextThreshold: 272_000,
    currency: "USD",
  },
  {
    id: "gpt-5.6-terra",
    patterns: [/gpt[_-]?5\.6[_-]?terra/i],
    cacheHit: 0.2,
    cacheWrite: 2.5,
    cacheWriteLong: 5.0,
    input: 2.0,
    output: 12.0,
    context: 1_050_000,
    longContextThreshold: 272_000,
    currency: "USD",
  },
  {
    id: "gpt-5.6-luna",
    patterns: [/gpt[_-]?5\.6[_-]?luna/i],
    cacheHit: 0.02,
    cacheWrite: 0.25,
    cacheWriteLong: 0.5,
    input: 0.2,
    output: 1.2,
    context: 1_050_000,
    longContextThreshold: 272_000,
    currency: "USD",
  },
  {
    id: "gpt-5",
    patterns: [/gpt[_-]?5/i, /o[34][-_]?mini/i],
    cacheHit: 0.125,
    input: 1.25,
    output: 10.0,
    context: 400_000,
    currency: "USD",
  },
  {
    id: "codex-auto-review",
    patterns: [/codex[_-]?auto[_-]?review/i],
    cacheHit: 0.02,
    input: 0.2,
    output: 1.2,
    context: null,
    estimated: true,
    currency: "USD",
  },
];

/**
 * Official Anthropic list prices (USD per 1M tokens), used by the Claude Code
 * provider. Sources: https://www.anthropic.com/pricing and
 * https://platform.claude.com/docs/en/docs/about-claude/models/overview
 * (2026-09 lineup: Fable/Mythos 5, Opus 5, Sonnet 5, Haiku 4.5).
 * Cache write defaults to 1.25× input; cache read is 10% on older models,
 * 5% on Opus 5.5, and 2.5% on Fable/Mythos 5.1. Specific versions precede
 * the generic family row — first match wins.
 */
const CLAUDE_PRICES = [
  {
    id: "claude-fable-5",
    // Mythos 5 shares Fable 5's specs and pricing (invitation-only preview).
    patterns: [/claude[_-]?(fable|mythos)/i],
    cacheHit: 0.25,
    cacheWrite: 12.5,
    input: 10.0,
    output: 50.0,
    context: 1_000_000,
    currency: "USD",
  },
  {
    id: "claude-opus-5-5",
    // Released 2026-09-22: 20% cheaper per token than Opus 5, cache reads
    // 60% cheaper ($0.20). Must precede the Opus 5 row below.
    patterns: [/claude[_-]?opus[_-]?5[_-]?5/i],
    cacheHit: 0.2,
    cacheWrite: 5.0,
    input: 4.0,
    output: 20.0,
    context: 1_000_000,
    currency: "USD",
  },
  {
    id: "claude-opus-5",
    // Opus 5 and the 4.5–4.8 generation all list at the same $5/$25 rates.
    patterns: [/claude[_-]?opus[_-]?5/i, /claude[_-]?opus[_-]?4[_-]?[5-9]/i],
    cacheHit: 0.5,
    cacheWrite: 6.25,
    input: 5.0,
    output: 25.0,
    context: 1_000_000,
    currency: "USD",
  },
  {
    id: "claude-sonnet-5",
    patterns: [/claude[_-]?sonnet[_-]?5/i],
    cacheHit: 0.2,
    cacheWrite: 2.5,
    input: 2.0,
    output: 10.0,
    context: 1_000_000,
    currency: "USD",
  },
  {
    id: "claude-haiku-4-5",
    patterns: [/claude[_-]?haiku[_-]?4[_-]?5/i],
    cacheHit: 0.1,
    cacheWrite: 1.25,
    input: 1.0,
    output: 5.0,
    context: 200_000,
    currency: "USD",
  },
  {
    id: "claude-3-haiku",
    patterns: [/claude[_-]?3[_-]?haiku/i],
    cacheHit: 0.03,
    cacheWrite: 0.3,
    input: 0.25,
    output: 1.25,
    context: 200_000,
    currency: "USD",
  },
  {
    id: "claude-sonnet",
    // Sonnet 3.5 / 3.7 / 4 / 4.5 / 4.6 all list at the same rates. 3.x ids
    // put the version before the family ("claude-3-7-sonnet"); 4.x after it.
    patterns: [/claude[_-]?sonnet/i, /claude[_-]?3[_-]?[57][_-]?sonnet/i],
    cacheHit: 0.3,
    cacheWrite: 3.75,
    input: 3.0,
    output: 15.0,
    context: 200_000,
    currency: "USD",
  },
  {
    id: "claude-opus",
    // Legacy Opus 3 / 4 / 4.1 ($15 tier); the $5 4.5+/5 generation is matched
    // above.
    patterns: [/claude[_-]?opus/i, /claude[_-]?3[_-]?opus/i],
    cacheHit: 1.5,
    cacheWrite: 18.75,
    input: 15.0,
    output: 75.0,
    context: 200_000,
    currency: "USD",
  },
  {
    id: "claude-3-5-haiku",
    patterns: [/claude[_-]?haiku/i, /claude[_-]?3[_-]?5[_-]?haiku/i],
    cacheHit: 0.08,
    cacheWrite: 1.0,
    input: 0.8,
    output: 4.0,
    context: 200_000,
    currency: "USD",
  },
].map((row) => ({ ...row, cacheWriteLong: row.cacheWrite * 2 }));

/** Find the first matching price row for a model id (first match wins). */
function matchRow(modelName) {
  if (!modelName) return null;
  const name = String(modelName);
  // Prefer the bare model segment after provider/
  const bare = name.includes("/") ? name.split("/").pop() : name;
  for (const row of ALL_PRICE_TABLES()) {
    for (const re of row.patterns) {
      if (re.test(bare) || re.test(name)) return row;
    }
  }
  return null;
}

/**
 * Pricing modifier class for one usage record — the bucket layer's key.
 * Query-time pricing (priceForCell) reproduces costForUsage exactly by
 * combining the row price with the multiplier of the recorded key:
 *   std  → no modifier
 *   peak → DeepSeek time-of-use peak window (also the conservative key for
 *          records without a timestamp; those carry estimated=true)
 *   off  → DeepSeek off-peak window / statutory holiday (half price)
 *   long → OpenAI long-context tier (single request input > threshold)
 * The two modifiers are mutually exclusive across today's tables (DeepSeek
 * rows have no longContextThreshold, OpenAI rows no offPeakMultiplier);
 * long wins if a future row ever carries both.
 */
const RATE_KEYS = Object.freeze(["std", "peak", "off", "long"]);

function rateKeyFor(modelName, usage = {}, time) {
  const row = matchRow(modelName);
  if (!row) return { key: "std", estimated: true }; // FALLBACK_PRICE is estimated
  const ttlEstimated = hasEstimatedCacheCreation(usage, row);
  if (row.longContextThreshold) {
    const tokens =
      num(usage.inputOther) + num(usage.inputCacheRead) + num(usage.inputCacheCreation);
    if (Number.isFinite(tokens) && tokens > row.longContextThreshold) {
      return { key: "long", estimated: ttlEstimated };
    }
  }
  if (row.offPeakMultiplier) {
    const t = deepSeekTimeOfUse(row, time);
    return t.multiplier === row.offPeakMultiplier
      ? { key: "off", estimated: ttlEstimated || t.estimated }
      : { key: "peak", estimated: ttlEstimated || t.estimated };
  }
  return { key: "std", estimated: ttlEstimated };
}

/**
 * Price for one aggregated bucket cell: the matched row's list prices with
 * the rateKey multiplier applied, normalized to the internal CNY ledger.
 * Mirrors what matchPrice computes per record, so folding records into
 * (model, rateKey) cells and pricing at query time reproduces costForUsage
 * up to floating-point summation order (guarded by equivalence tests).
 * Custom prices substitute components exactly like costForUsage does, with
 * missing components inheriting the multiplied official rates.
 */
function priceForCell(modelName, rateKey, options = {}) {
  const row = matchRow(modelName);
  // No row → fallback estimate; its rates are already approximate, so the
  // recorded modifier is ignored rather than compounding the guess.
  if (!row) {
    const fx0 = Number(options.fxRate) > 0 ? Number(options.fxRate) : 6.67;
    const fb = normalizedFallbackPrice(fx0, String(modelName || ""));
    return { id: fb.id, cacheHit: fb.cacheHit, cacheWrite: fb.cacheWrite, cacheWriteLong: null, input: fb.input, output: fb.output, estimated: true };
  }
  const fxRate = Number(options.fxRate) > 0 ? Number(options.fxRate) : 6.67;
  const cny = priceToCnyMultiplier(row, fxRate);
  let inputMult = 1;
  let outputMult = 1;
  if (rateKey === "off") {
    const off = row.offPeakMultiplier || 0.5;
    inputMult = off;
    outputMult = off;
  } else if (rateKey === "long") {
    inputMult = 2;
    outputMult = 1.5;
  }
  const official = {
    id: row.id,
    cacheHit: row.cacheHit * inputMult * cny,
    cacheWrite: (row.cacheWrite ?? row.input) * inputMult * cny,
    cacheWriteLong: row.cacheWriteLong == null ? null : row.cacheWriteLong * inputMult * cny,
    input: row.input * inputMult * cny,
    output: row.output * outputMult * cny,
    estimated: !!row.estimated,
  };
  const custom = Array.isArray(options.customPrices)
    ? matchCustomPrice(modelName, options.customPrices, fxRate, official)
    : null;
  return custom || official;
}

function matchPrice(modelName, options = {}) {
  if (!modelName) return normalizedFallbackPrice(options.fxRate, null);
  const name = String(modelName);
  // Prefer the bare model segment after provider/
  const bare = name.includes("/") ? name.split("/").pop() : name;
  const row = matchRow(modelName);
  if (!row) return normalizedFallbackPrice(options.fxRate, bare);
  {
    const timeOfUse = deepSeekTimeOfUse(row, options.time);
    const currencyMultiplier = priceToCnyMultiplier(row, options.fxRate);
    const context = longContextPricing(row, options.inputTokens);
    return {
      id: row.id,
      cacheHit: row.cacheHit * timeOfUse.multiplier * context.inputMultiplier * currencyMultiplier,
      cacheWrite: (row.cacheWrite ?? row.input) * timeOfUse.multiplier * context.inputMultiplier * currencyMultiplier,
      cacheWriteLong: row.cacheWriteLong == null ? null : row.cacheWriteLong * timeOfUse.multiplier * context.inputMultiplier * currencyMultiplier,
      input: row.input * timeOfUse.multiplier * context.inputMultiplier * currencyMultiplier,
      output: row.output * timeOfUse.multiplier * context.outputMultiplier * currencyMultiplier,
      context: row.context,
      // Without a request timestamp, a time-of-use DeepSeek calculation
      // cannot be exact.  We intentionally use the peak rate (the
      // conservative documented rate) and surface it as an estimate.
      estimated: !!row.estimated || timeOfUse.estimated,
      match: bare,
      ratePeriod: timeOfUse.ratePeriod,
      contextTier: context.tier,
    };
  }
}

function longContextPricing(row, inputTokens) {
  const tokens = Number(inputTokens);
  if (!row.longContextThreshold || !Number.isFinite(tokens) || tokens <= row.longContextThreshold) {
    return { inputMultiplier: 1, outputMultiplier: 1, tier: "standard" };
  }
  return { inputMultiplier: 2, outputMultiplier: 1.5, tier: "long-context" };
}

function normalizedFallbackPrice(fxRate, match) {
  const multiplier = priceToCnyMultiplier(FALLBACK_PRICE, fxRate);
  return {
    ...FALLBACK_PRICE,
    cacheHit: FALLBACK_PRICE.cacheHit * multiplier,
    input: FALLBACK_PRICE.input * multiplier,
    output: FALLBACK_PRICE.output * multiplier,
    cacheWrite: FALLBACK_PRICE.input * multiplier,
    cacheWriteLong: null,
    match,
    estimated: true,
  };
}

/**
 * Normalize a provider-native list price to the internal CNY ledger.
 * Chinese providers remain unchanged; USD prices are converted once using
 * the configured USD -> CNY exchange rate.
 */
function priceToCnyMultiplier(row, fxRate) {
  if (row.currency !== "USD") return 1;
  const fx = Number(fxRate);
  return Number.isFinite(fx) && fx > 0 ? fx : 6.67;
}

/**
 * Return the DeepSeek time-of-use multiplier for a request timestamp.
 * Other providers have no time-of-use price, so they keep a multiplier of 1.
 */
function deepSeekTimeOfUse(row, time) {
  if (!row.offPeakMultiplier) return { multiplier: 1, estimated: false, ratePeriod: null };
  const ms = Number(time);
  if (!Number.isFinite(ms) || ms <= 0) {
    return { multiplier: 1, estimated: true, ratePeriod: "peak (timestamp unavailable)" };
  }
  // Beijing is UTC+8 and has no daylight-saving changes. Shift first so both
  // weekday and hour reflect the tariff definition, rather than the viewer's
  // local time zone.
  const date = new Date(ms + 8 * 60 * 60 * 1000);
  const weekday = date.getUTCDay();
  const hour = date.getUTCHours();
  const beijingDay = date.toISOString().slice(0, 10);
  const peak =
    weekday >= 1 &&
    weekday <= 5 &&
    !CN_HOLIDAYS_2026.has(beijingDay) &&
    ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18));
  return peak
    ? { multiplier: 1, estimated: false, ratePeriod: "peak" }
    : { multiplier: row.offPeakMultiplier, estimated: false, ratePeriod: "off-peak" };
}

// DeepSeek excludes Chinese statutory holidays from the peak tariff. These
// 2026 leave dates are the published State Council schedule. Other years keep
// the documented weekday/time rule until their official calendars are added.
const CN_HOLIDAYS_2026 = new Set([
  "2026-01-01", "2026-01-02", "2026-01-03",
  "2026-02-15", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19", "2026-02-20", "2026-02-21", "2026-02-22", "2026-02-23",
  "2026-04-04", "2026-04-05", "2026-04-06",
  "2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05",
  "2026-06-19", "2026-06-20", "2026-06-21",
  "2026-09-25", "2026-09-26", "2026-09-27",
  "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07",
]);

/** CNY per 1M for one custom-price component (null when not set). */
function customComponentCny(value, currency, fxRate) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return currency === "USD" ? n * fxRate : n;
}

/**
 * Try to match modelName against user-defined custom prices.
 * Exact (case-insensitive) match first, then substring; longest pattern wins
 * so "glm-5.3-flash" beats "glm-5.3".
 */
function matchCustomPrice(modelName, customPrices, fxRate, fallbackPrice = FALLBACK_PRICE) {
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
  const fx = Number(fxRate) > 0 ? Number(fxRate) : 6.67;
  const input = customComponentCny(best.input, best.currency, fx);
  const cacheHit = customComponentCny(best.cacheHit, best.currency, fx);
  const output = customComponentCny(best.output, best.currency, fx);
  // Missing components inherit the matched official row.  This matters for
  // DeepSeek: a user may override just one rate while its other components
  // still need the model's time-of-use price rather than Kimi's fallback.
  const usesFallback = input === null || cacheHit === null || output === null;
  return {
    id: `custom:${best.model}`,
    input: input ?? fallbackPrice.input,
    cacheHit: cacheHit ?? fallbackPrice.cacheHit,
    output: output ?? fallbackPrice.output,
    cacheWrite: input ?? fallbackPrice.cacheWrite ?? fallbackPrice.input,
    cacheWriteLong: fallbackPrice.cacheWriteLong == null ? null : input ?? fallbackPrice.cacheWriteLong,
    context: null,
    estimated: usesFallback && !!fallbackPrice.estimated,
    custom: true,
    match: best.model,
    ratePeriod: fallbackPrice.ratePeriod,
  };
}

function cacheCreationAmounts(usage) {
  const u = usage || {};
  const total = num(u.inputCacheCreation);
  const typed = u.inputCacheCreationShort != null || u.inputCacheCreationLong != null;
  const short = typed ? num(u.inputCacheCreationShort) : 0;
  const long = typed ? num(u.inputCacheCreationLong) : 0;
  return { short, long, untyped: typed ? Math.max(0, total - short - long) : total };
}

function hasEstimatedCacheCreation(usage, price) {
  return price.cacheWriteLong != null && cacheCreationAmounts(usage).untyped > 0;
}

function costCacheCreation(usage, price) {
  const { short, long, untyped } = cacheCreationAmounts(usage);
  const shortRate = price.cacheWrite ?? price.input;
  const longRate = price.cacheWriteLong ?? shortRate;
  const untypedRate = price.cacheWriteLong == null ? shortRate : (shortRate + longRate) / 2;
  return (short * shortRate + long * longRate + untyped * untypedRate) / 1e6;
}

/**
 * Cost for one aggregated token cell {i,o,cr,cc,cs?,cl?} under a resolved
 * `priceForCell` row — the SINGLE cost-math implementation (M3.5 ③).
 * aggregate.js and store.js both consume this; pricing changes never touch
 * aggregation code and vice versa. Cell token counts are integers; result
 * is the internal CNY ledger currency.
 */
function cellCostCny(cell, price) {
  return (
    ((cell.i || 0) / 1e6) * price.input +
    ((cell.cr || 0) / 1e6) * price.cacheHit +
    costCacheCreation(
      {
        inputCacheCreation: cell.cc || 0,
        inputCacheCreationShort: cell.cs,
        inputCacheCreationLong: cell.cl,
      },
      price
    ) +
    ((cell.o || 0) / 1e6) * price.output
  );
}

/**
 * Cost for one usage record, in the internal CNY ledger currency.
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
  const u = usage || {};
  const fxRate = Number(settings?.fxRate) > 0 ? Number(settings.fxRate) : 6.67;
  const inputOther = num(u.inputOther);
  const output = num(u.output);
  const cacheRead = num(u.inputCacheRead);
  const cacheCreate = num(u.inputCacheCreation);
  const official = matchPrice(modelName, {
    time: u.time ?? u.pricedAt ?? options.time,
    fxRate,
    inputTokens: inputOther + cacheRead + cacheCreate,
  });
  const custom = settings
    ? matchCustomPrice(modelName, settings.customPrices, settings.fxRate, official)
    : null;
  const price = custom || official;
  const costInput = (inputOther / 1e6) * price.input;
  const costCacheRead = (cacheRead / 1e6) * price.cacheHit;
  const costCacheCreate = costCacheCreation(u, price);
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
    estimated: !!price.estimated || hasEstimatedCacheCreation(u, price),
    custom: !!price.custom,
  };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function priceSourceUrl(p) {
  if (OPENAI_PRICES.includes(p)) {
    return p.id === "codex-auto-review"
      ? "https://developers.openai.com/api/docs/pricing"
      : `https://developers.openai.com/api/docs/models/${p.id}`;
  }
  if (p.offPeakMultiplier) return "https://api-docs.deepseek.com/quick_start/pricing/";
  if (CLAUDE_PRICES.includes(p)) return "https://platform.claude.com/docs/en/docs/about-claude/models/overview";
  if (ZHIPU_PRICES.includes(p)) return "https://docs.bigmodel.cn/cn/guide/models";
  if (GOOGLE_PRICES.includes(p)) return "https://ai.google.dev/gemini-api/docs/pricing";
  if (QWEN_PRICES.includes(p)) return "https://www.alibabacloud.com/help/en/model-studio/model-pricing";
  if (MINIMAX_PRICES.includes(p)) return "https://platform.minimaxi.com/document/Price";
  if (p.id === "hy3") return "https://models.dev/models/tencent/hy3";
  if (VENDOR_EXTRA_PRICES.includes(p)) return "https://docs.bigmodel.cn/cn/guide/models";
  return "https://platform.kimi.com/docs/pricing/chat";
}

function listPrices(options = {}) {
  const rows = [];
  for (const p of ALL_PRICE_TABLES()) {
    const add = (period, multiplier) => rows.push({
      id: p.id,
      cacheHit: p.cacheHit * multiplier * priceToCnyMultiplier(p, options.fxRate),
      cacheWrite: p.cacheWrite == null ? null : p.cacheWrite * multiplier * priceToCnyMultiplier(p, options.fxRate),
      cacheWriteLong: p.cacheWriteLong == null ? null : p.cacheWriteLong * multiplier * priceToCnyMultiplier(p, options.fxRate),
      cacheWritePeriod: p.cacheWriteLong == null ? null : OPENAI_PRICES.includes(p) ? "30m" : "5min",
      cacheWriteLongPeriod: p.cacheWriteLong == null ? null : OPENAI_PRICES.includes(p) ? "12h" : "1h",
      input: p.input * multiplier * priceToCnyMultiplier(p, options.fxRate),
      output: p.output * multiplier * priceToCnyMultiplier(p, options.fxRate),
      context: p.context,
      estimated: !!p.estimated,
      period,
      nativeCurrency: p.currency || "USD",
      unit: `${p.currency || "USD"} / 1M tokens`,
      source: priceSourceUrl(p),
      sourceUrl: priceSourceUrl(p),
    });
    if (p.offPeakMultiplier) {
      add("peak", 1);
      add("offPeak", p.offPeakMultiplier);
    } else {
      add(null, 1);
    }
  }
  return rows;
}

module.exports = {
  KIMI_PRICES,
  DEEPSEEK_PRICES,
  GOOGLE_PRICES,
  ZHIPU_PRICES,
  QWEN_PRICES,
  MINIMAX_PRICES,
  VENDOR_EXTRA_PRICES,
  OPENAI_PRICES,
  CLAUDE_PRICES,
  FALLBACK_PRICE,
  matchRow,
  rateKeyFor,
  priceForCell,
  RATE_KEYS,
  matchPrice,
  matchCustomPrice,
  costForUsage,
  costCacheCreation,
  cellCostCny,
  listPrices,
};
