"use strict";

/**
 * Port of CC Switch's `model_pricing` resolution and fixed-point cost math
 * (`src-tauri/src/services/usage_stats.rs` & `src-tauri/src/proxy/usage/calculator.rs`),
 * taken from the ccs-ssh-sync port so bridged rows carry costs matching
 * CC Switch's own rows exactly (resolved from the live model_pricing table).
 */

const INPUT_TOKEN_SEMANTICS_LEGACY = 0;
const INPUT_TOKEN_SEMANTICS_TOTAL = 1;
const INPUT_TOKEN_SEMANTICS_FRESH = 2;

const CACHE_INCLUSIVE_APPS = new Set(["codex", "gemini", "grokbuild"]);

const KNOWN_NAMESPACES = [
  "openai.",
  "anthropic.",
  "google.",
  "moonshot.",
  "moonshotai.",
  "bedrock.",
  "global.",
];

const NON_ANTHROPIC_MARKERS = [
  "abab",
  "ark-code",
  "arctic",
  "astron",
  "codex",
  "command-r",
  "deepseek",
  "doubao",
  "ernie",
  "gemini",
  "gemma",
  "glm",
  "gpt",
  "grok",
  "hermes",
  "hy3",
  "hunyuan",
  "jamba",
  "kimi",
  "lfm",
  "llama",
  "longcat",
  "mercury",
  "mimo",
  "minimax",
  "mistral",
  "mixtral",
  "moonshot",
  "nemotron",
  "nova-",
  "openai",
  "qianfan",
  "qwen",
  "seed-",
  "solar",
  "stepfun",
];

const REASONING_EFFORT_SUFFIXES = [
  "-minimal",
  "-low",
  "-medium",
  "-high",
  "-xhigh",
];

const PREFIX_MATCH_FAMILIES = [
  "gpt-",
  "gemini-",
  "deepseek-",
  "qwen-",
  "glm-",
  "kimi-",
  "minimax-",
];

function isPlaceholderPricingModel(modelId) {
  if (!modelId) return true;
  const norm = String(modelId).trim().toLowerCase();
  return !norm || norm === "unknown" || norm === "null" || norm === "none";
}

function cleanModelIdForPricing(modelId) {
  const str = String(modelId || "");
  const slashIdx = str.lastIndexOf("/");
  const afterSlash = slashIdx >= 0 ? str.slice(slashIdx + 1) : str;
  const colonIdx = afterSlash.indexOf(":");
  const beforeColon = colonIdx >= 0 ? afterSlash.slice(0, colonIdx) : afterSlash;
  let norm = beforeColon.trim().replace(/@/g, "-").replace(/\s+/g, "-").toLowerCase();
  if (norm.endsWith("[1m]")) {
    norm = norm.slice(0, -4).trim();
  }
  return norm;
}

function stripKnownModelNamespace(modelId) {
  const claudeIdx = modelId.lastIndexOf("claude-");
  if (claudeIdx > 0) return modelId.slice(claudeIdx);
  for (const marker of KNOWN_NAMESPACES) {
    if (modelId.startsWith(marker)) return modelId.slice(marker.length);
  }
  return null;
}

function stripClaudeDesktopNonAnthropicPrefix(modelId) {
  if (!modelId.startsWith("claude-")) return null;
  const rest = modelId.slice("claude-".length);
  return NON_ANTHROPIC_MARKERS.some((m) => rest.startsWith(m)) ? rest : null;
}

function stripBedrockModelVersionSuffix(modelId) {
  const idx = modelId.lastIndexOf("-v");
  if (idx <= 0) return null;
  const suffix = modelId.slice(idx + 2);
  return suffix.length > 0 && /^[0-9]+$/.test(suffix) ? modelId.slice(0, idx) : null;
}

function stripModelDateSuffix(modelId) {
  if (modelId.length > 11 && /^-\d{4}-\d{2}-\d{2}$/.test(modelId.slice(-11))) {
    return modelId.slice(0, -11);
  }
  const dash = modelId.lastIndexOf("-");
  if (dash <= 0) return null;
  const suffix = modelId.slice(dash + 1);
  if (!/^[0-9]+$/.test(suffix)) return null;
  if (suffix.length === 8) return modelId.slice(0, dash);
  if (suffix.length === 6) {
    const month = Number(suffix.slice(2, 4));
    const day = Number(suffix.slice(4, 6));
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return modelId.slice(0, dash);
    }
  }
  return null;
}

function stripReasoningEffortSuffix(modelId) {
  for (const suffix of REASONING_EFFORT_SUFFIXES) {
    if (modelId.length > suffix.length && modelId.endsWith(suffix)) {
      return modelId.slice(0, -suffix.length);
    }
  }
  return null;
}

function stripGeminiFlashTieredSuffix(modelId) {
  if (!modelId.startsWith("gemini-") || !modelId.endsWith("-flash-tiered")) {
    return null;
  }
  const version = modelId.slice("gemini-".length, -"-flash-tiered".length);
  if (!version) return null;
  const parts = version.split(".");
  if (parts.every((p) => p.length > 0 && /^[0-9]+$/.test(p))) {
    return `gemini-${version}-flash`;
  }
  return null;
}

function stripClaudeThinkingSuffix(modelId) {
  if (!modelId.startsWith("claude-") || stripClaudeDesktopNonAnthropicPrefix(modelId)) {
    return null;
  }
  if (!modelId.endsWith("-thinking")) return null;
  const base = modelId.slice(0, -"-thinking".length);
  return base.length > "claude-".length ? base : null;
}

function shouldTryPricingPrefixMatch(modelId) {
  if (
    modelId === "gemini-4-hydrogen-tiered" ||
    modelId === "gemini-4-hydrogen-orchestrator" ||
    modelId === "gemini-flash-worker-agy" ||
    stripGeminiFlashTieredSuffix(modelId)
  ) {
    return false;
  }

  let dashCount = 0;
  for (let i = 0; i < modelId.length; i++) {
    if (modelId.charCodeAt(i) === 45) dashCount++;
  }
  if (modelId.startsWith("claude-")) return dashCount >= 3;
  if (["o1", "o3", "o4", "o5"].some((p) => modelId.startsWith(p))) return dashCount >= 1;
  return PREFIX_MATCH_FAMILIES.some((p) => modelId.startsWith(p)) && dashCount >= 2;
}

function pushUniqueCandidate(candidates, candidate) {
  if (!candidate.modelId) return false;
  const existing = candidates.find((c) => c.modelId === candidate.modelId);
  if (existing) {
    if (!existing.allowPrefixMatch && candidate.allowPrefixMatch) {
      existing.allowPrefixMatch = true;
      return true;
    }
    return false;
  }
  candidates.push(candidate);
  return true;
}

function modelPricingCandidates(modelId) {
  const cleaned = cleanModelIdForPricing(modelId);
  if (isPlaceholderPricingModel(cleaned)) return [];

  const candidates = [];
  const queue = [{ modelId: cleaned, allowPrefixMatch: true }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!pushUniqueCandidate(candidates, { ...current })) continue;
    const { modelId: c, allowPrefixMatch } = current;
    const pushDerived = (derived) => queue.push({ modelId: derived, allowPrefixMatch });

    const ns = stripKnownModelNamespace(c);
    if (ns) pushDerived(ns);

    const cd = stripClaudeDesktopNonAnthropicPrefix(c);
    if (cd) pushDerived(cd);

    const bv = stripBedrockModelVersionSuffix(c);
    if (bv) pushDerived(bv);

    if (c.startsWith("claude-") && c.includes(".") && !stripClaudeDesktopNonAnthropicPrefix(c)) {
      pushDerived(c.replace(/\./g, "-"));
    }

    const ds = stripModelDateSuffix(c);
    if (ds) pushDerived(ds);

    const rs = stripReasoningEffortSuffix(c);
    if (rs) pushDerived(rs);

    const gft = stripGeminiFlashTieredSuffix(c);
    if (gft) queue.push({ modelId: gft, allowPrefixMatch: false });

    if (c === "gemini-4-hydrogen-tiered") {
      queue.push({ modelId: "gemini-4-hydrogen", allowPrefixMatch: false });
    }
    if (c === "gemini-4-hydrogen-orchestrator" || c === "gemini-flash-worker-agy") {
      queue.push({ modelId: "gemini-4-hydrogen", allowPrefixMatch: false });
    }

    const ct = stripClaudeThinkingSuffix(c);
    if (ct) pushDerived(ct);
  }

  return candidates;
}

// Parse non-negative decimal string `v` into BigInt scaled by 10^PRICE_SCALE (exact to 12 decimals).
const PRICE_SCALE = 12n;
const PRICE_FACTOR = 10n ** PRICE_SCALE;
const MILLION = 1_000_000n;
const COST_DIVISOR = MILLION * PRICE_FACTOR; // 10^18

function parseDecimalToScaled(str, scale = PRICE_SCALE) {
  const s = String(str ?? "0").trim();
  if (!s || s === "0") return 0n;
  const m = s.match(/^([+-])?(\d+)(?:\.(\d+))?$/);
  if (!m) {
    const num = Number(s);
    if (!Number.isFinite(num) || num <= 0) return 0n;
    return BigInt(Math.round(num * Number(10n ** scale)));
  }
  if (m[1] === "-") return 0n;
  const whole = BigInt(m[2]);
  const fracRaw = (m[3] || "").slice(0, Number(scale)).padEnd(Number(scale), "0");
  return whole * 10n ** scale + BigInt(fracRaw || "0");
}

/**
 * Format exact quotient `numerator / COST_DIVISOR` with full decimal precision
 * (up to 18 decimals, trimmed, min 6 decimals when > 0 — matching CC Switch `usage_stats.rs`).
 */
function formatScaledCost(numerator) {
  if (numerator <= 0n) return "0";
  const scale = 18;
  const whole = numerator / COST_DIVISOR;
  const rem = numerator % COST_DIVISOR;
  if (rem === 0n) return `${whole}.000000`;
  let frac = rem.toString().padStart(scale, "0").replace(/0+$/, "");
  if (frac.length < 6) frac = frac.padEnd(6, "0");
  return `${whole}.${frac}`;
}

class PricingCatalog {
  constructor(rows = []) {
    this.exact = new Map();
    this.prefixes = new Map();
    this.lookupCache = new Map();

    // Expect rows sorted by LENGTH(model_id), rowid just like CC Switch SQLite catalog load.
    const sorted = [...rows].sort((a, b) => a.model_id.length - b.model_id.length);
    for (const row of sorted) {
      const modelLower = String(row.model_id || "").toLowerCase();
      if (!modelLower) continue;
      const pricing = {
        modelId: row.model_id,
        input: parseDecimalToScaled(row.input_cost_per_million),
        output: parseDecimalToScaled(row.output_cost_per_million),
        cacheRead: parseDecimalToScaled(row.cache_read_cost_per_million),
        cacheCreation: parseDecimalToScaled(row.cache_creation_cost_per_million),
      };
      for (let i = 0; i < modelLower.length; i++) {
        if (modelLower.charCodeAt(i) === 45) {
          const prefix = modelLower.slice(0, i);
          if (!this.prefixes.has(prefix)) {
            this.prefixes.set(prefix, pricing);
          }
        }
      }
      if (!this.exact.has(modelLower)) {
        this.exact.set(modelLower, pricing);
      }
    }
  }

  static fromDatabase(conn) {
    try {
      const rows = conn
        .prepare(
          `SELECT model_id, input_cost_per_million, output_cost_per_million,
                  cache_read_cost_per_million, cache_creation_cost_per_million
           FROM model_pricing
           ORDER BY LENGTH(model_id), rowid`
        )
        .all();
      return new PricingCatalog(rows);
    } catch {
      return new PricingCatalog([]);
    }
  }

  find(modelId) {
    if (!modelId) return null;
    if (this.lookupCache.has(modelId)) {
      return this.lookupCache.get(modelId);
    }
    const candidates = modelPricingCandidates(modelId);
    let hit = null;

    for (const cand of candidates) {
      const row = this.exact.get(cand.modelId);
      if (row) {
        hit = row;
        break;
      }
    }
    if (!hit) {
      for (const cand of candidates) {
        if (cand.allowPrefixMatch && shouldTryPricingPrefixMatch(cand.modelId)) {
          const row = this.prefixes.get(cand.modelId);
          if (row) {
            hit = row;
            break;
          }
        }
      }
    }

    this.lookupCache.set(modelId, hit);
    return hit;
  }

  /**
   * Calculate cost strings `[input_cost_usd, output_cost_usd, cache_read_cost_usd, cache_creation_cost_usd, total_cost_usd]`
   * aligned with CC Switch's `CostCalculator::calculate_for_app` / `maybe_backfill_log_costs`.
   */
  calculateCostColumns({
    appType,
    pricingModel,
    model,
    inputTokens = 0,
    outputTokens = 0,
    cacheReadTokens = 0,
    cacheCreationTokens = 0,
    cacheCreation1hTokens = 0,
    inputTokenSemantics = INPUT_TOKEN_SEMANTICS_FRESH,
  }) {
    const pricing =
      (pricingModel && !isPlaceholderPricingModel(pricingModel) && this.find(pricingModel)) ||
      this.find(model);
    if (!pricing) {
      return {
        inputCostUsd: "0",
        outputCostUsd: "0",
        cacheReadCostUsd: "0",
        cacheCreationCostUsd: "0",
        totalCostUsd: "0",
      };
    }

    const iTok = BigInt(Math.max(0, Math.trunc(Number(inputTokens) || 0)));
    const oTok = BigInt(Math.max(0, Math.trunc(Number(outputTokens) || 0)));
    const crTok = BigInt(Math.max(0, Math.trunc(Number(cacheReadTokens) || 0)));
    const ccTok = BigInt(Math.max(0, Math.trunc(Number(cacheCreationTokens) || 0)));
    const cc1hRaw = BigInt(Math.max(0, Math.trunc(Number(cacheCreation1hTokens) || 0)));
    const cc1h = cc1hRaw < ccTok ? cc1hRaw : ccTok;
    const cc5m = ccTok - cc1h;

    const cacheInclusive = CACHE_INCLUSIVE_APPS.has(appType);
    let billableInput = iTok;
    if (cacheInclusive && inputTokenSemantics !== INPUT_TOKEN_SEMANTICS_FRESH) {
      if (inputTokenSemantics === INPUT_TOKEN_SEMANTICS_TOTAL) {
        const sub = iTok - crTok - ccTok;
        billableInput = sub > 0n ? sub : 0n;
      } else {
        const sub = iTok - crTok;
        billableInput = sub > 0n ? sub : 0n;
      }
    }

    const inputNum = billableInput * pricing.input;
    const outputNum = oTok * pricing.output;
    const cacheReadNum = crTok * pricing.cacheRead;
    // 1h cache write = 1.6x of 5m cache_creation unit price (see calculator.rs line 85)
    const cacheCreationNum = ((cc5m * 10n + cc1h * 16n) * pricing.cacheCreation) / 10n;
    const totalNum = inputNum + outputNum + cacheReadNum + cacheCreationNum;

    return {
      inputCostUsd: formatScaledCost(inputNum),
      outputCostUsd: formatScaledCost(outputNum),
      cacheReadCostUsd: formatScaledCost(cacheReadNum),
      cacheCreationCostUsd: formatScaledCost(cacheCreationNum),
      totalCostUsd: formatScaledCost(totalNum),
    };
  }
}

module.exports = {
  INPUT_TOKEN_SEMANTICS_LEGACY,
  INPUT_TOKEN_SEMANTICS_TOTAL,
  INPUT_TOKEN_SEMANTICS_FRESH,
  CACHE_INCLUSIVE_APPS,
  PricingCatalog,
  modelPricingCandidates,
  cleanModelIdForPricing,
  isPlaceholderPricingModel,
  shouldTryPricingPrefixMatch,
  formatScaledCost,
};
