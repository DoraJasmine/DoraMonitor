"use strict";

/**
 * Model identity resolution — the single place that turns a bare routing code
 * into a human-readable display name and a pricing key.
 *
 * Some tools record an internal routing code instead of a real model id:
 *   QoderCN / QoderCN CLI  →  "dfmodel", "qfmodel", "qmodel_latest", ...
 *   dsh (via its plugins)  →  the same codes, because the plugin forwards the
 *                             provider's own id unchanged.
 * Before this module existed the mapping lived in two provider files, so dsh
 * records (which had no mapping at all) rendered as the raw code while the
 * identical QoderCN traffic rendered as "DeepSeek-V4-Flash".
 *
 * Lookup order:
 *   1. exact code (case-insensitive)
 *   2. `provider` prefix + code, e.g. "qodercn:qfmodel"
 *   3. a small set of obvious aliases (dfmodel ↔ deepseek-v4-flash)
 *
 * Unmapped codes pass through unchanged: a new routing code must never make a
 * record disappear or throw — it should just stay visible as its raw id.
 */

/**
 * QoderCN internal codes → official display name.
 * Mirrors the table borrowed from token-monitor (Javis603/token-monitor,
 * qoderCnUsage.js) and kept in sync with the QoderCN app's own model list.
 */
const QODER_DISPLAY_NAMES = Object.freeze({
  // Routing tiers are selectors, not real models; keep them readable.
  auto: "Auto",
  efficient: "Efficient",
  lite: "Lite",
  performance: "Performance",
  ultimate: "Ultimate",
  // Alibaba Qwen family
  dashscope_qmodel: "Qwen3.7-Plus",
  dashscope_qwen3_coder: "Qwen3-Coder-Plus",
  dashscope_qwen_max_latest: "Qwen3-Max",
  qmodel: "Qwen3.7-Plus",
  qmodel_latest: "Qwen3.7-Max",
  qmodel_preview: "Qwen3.8-Max-Preview",
  q35model: "Qwen3.5-Plus",
  q35model_preview: "Qwen3.8-Max-Preview",
  q36fmodel: "Qwen3.6-Flash",
  // "qfmodel" is the fast-tier Qwen routing code. The QoderCN CLI table maps
  // it to Qwen3.6-Flash; the IDE table had no entry for it at all, which is
  // why it used to render raw.
  qfmodel: "Qwen3.6-Flash",
  // DeepSeek
  dfmodel: "DeepSeek-V4-Flash",
  dmodel: "DeepSeek-V4-Pro",
  // Zhipu GLM
  gmodel: "GLM-5",
  gm51model: "GLM-5.2",
  // Moonshot Kimi
  kmodel: "Kimi-K2.7-Code",
  // MiniMax
  mmodel: "MiniMax-M3",
});

/**
 * Display-only aliases for codes that some tools record but that are NOT
 * QoderCN routing codes (e.g. dsh plugin providers forwarding their own ids).
 */
const EXTRA_DISPLAY_NAMES = Object.freeze({
  // Tencent/OpenCode "Go" catalog id used by dsh's buddy plugin. Vendor
  // attribution is not officially published; keep the id readable.
  hy3: "Hy3",
  "hy3-x": "Hy3",
  "hy4-preview": "Hy4 Preview",
  dfmodel: "DeepSeek-V4-Flash",
});

/**
 * Routing code → canonical model id used for pricing.
 * The display name is for humans; pricing needs the id the price table
 * matches on. Without this, a code with no price row silently fell back to
 * Kimi K2.6 pricing while the UI showed a Qwen label.
 */
const PRICING_KEYS = Object.freeze({
  qfmodel: "qwen3.6-flash",
  qmodel: "qwen3.7-plus",
  qmodel_latest: "qwen3.7-max",
  qmodel_preview: "qwen3.8-max-preview",
  q35model: "qwen3.5-plus",
  q35model_preview: "qwen3.8-max-preview",
  q36fmodel: "qwen3.6-flash",
  dashscope_qmodel: "qwen3.7-plus",
  dashscope_qwen3_coder: "qwen3-coder-plus",
  dashscope_qwen_max_latest: "qwen3-max",
  dfmodel: "deepseek-v4-flash",
  dmodel: "deepseek-v4-pro",
  gmodel: "glm-5",
  gm51model: "glm-5.2",
  kmodel: "kimi-k2.7-code",
  mmodel: "minimax-m3",
});

function normalizeCode(value) {
  return String(value == null ? "" : value)
    .trim()
    .toLowerCase();
}

/**
 * Resolve a model code to { model, modelDisplay, pricingKey, known, provider }.
 *
 * @param {string} code      raw model id / routing code as recorded
 * @param {object} [opts]
 * @param {string} [opts.provider] provider id recorded next to the model
 *                                 (e.g. dsh's "qodercn"); used only to build a
 *                                 qualified lookup key and echoed back.
 */
function resolveModelIdentity(code, opts = {}) {
  const raw = String(code == null ? "" : code).trim();
  const key = normalizeCode(raw);
  const provider = opts.provider ? String(opts.provider).trim() : null;

  if (!key || key === "unknown") {
    return { model: raw || "unknown", modelDisplay: "unknown", pricingKey: null, known: false, provider };
  }

  // A provider-qualified id ("qodercn:dfmodel", "alibaba/qwen3.7-max"):
  // try the full id first, then the trailing segment.
  let bare = key;
  if (key.includes(":")) bare = key.split(":").pop();
  if (key.includes("/")) bare = key.split("/").pop();

  const display =
    QODER_DISPLAY_NAMES[bare] ||
    EXTRA_DISPLAY_NAMES[bare] ||
    QODER_DISPLAY_NAMES[key] ||
    EXTRA_DISPLAY_NAMES[key] ||
    raw;

  const pricingKey = PRICING_KEYS[bare] || PRICING_KEYS[key] || null;

  return {
    model: raw,
    modelDisplay: display,
    // Pricing still runs on the raw id as a fallback so custom user prices
    // keyed on the code keep matching; `pricingKey` is the better hint.
    pricingKey,
    known: display !== raw || pricingKey !== null,
    provider,
  };
}

/** Display name for a code, or the code itself when unmapped. */
function displayNameFor(code) {
  return resolveModelIdentity(code).modelDisplay;
}

module.exports = {
  QODER_DISPLAY_NAMES,
  EXTRA_DISPLAY_NAMES,
  PRICING_KEYS,
  resolveModelIdentity,
  displayNameFor,
};
