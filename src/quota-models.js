"use strict";

// Terminology map (three distinct axes — do not conflate):
//   tool            — the AI coding tool a record came from ("kimi-code", "codex", ...).
//   provider/quotaprovider — the quota account family ("kimi" | "openai") that a
//                     5-hour/weekly quota window belongs to. This module maps
//                     models+tools onto that axis.
//   modelProvider/vendor — the upstream vendor serving a model (pricing, identity).
// Stored samples/history embed the `provider` field name; it always means the
// quota account family, never the tool.

function normalize(value) {
  return String(value || "").trim().toLowerCase().replace(/_/g, "-");
}

function classifyQuotaModel(record) {
  const provider = normalize(record && record.modelProvider);
  const resolved = normalize(record && (record.modelResolved || record.model));
  const raw = normalize(record && record.model);
  const names = [...new Set([resolved, raw].filter(Boolean))];

  if (names.some((name) => /^(deepseek|claude|glm|qwen|gemini|minimax|grok)([-/]|$)/.test(name) || name.includes("deepseek-"))) {
    return { quotaProvider: null, modelKey: resolved || raw || "unknown", reason: "irrelevant_model" };
  }

  const openAiProvider = /^(openai|openai-codex|chatgpt|azure-openai)$/.test(provider);
  const kimiProvider = /^(kimi|moonshot|moonshotai|kimi-code)$/.test(provider);
  const openAiModel = names.some((name) => /^(gpt-|o[134](-|$)|codex-|chatgpt-)/.test(name) || /^(gpt|codex)$/.test(name));
  const kimiModel = names.some((name) => /^(kimi([-/]|$)|k[123]([-.]|$)|moonshot-)/.test(name));

  if (openAiModel || (openAiProvider && !kimiModel)) {
    return { quotaProvider: "openai", modelKey: resolved || raw || "unknown", reason: "matched" };
  }
  if (kimiModel || (kimiProvider && !openAiModel)) {
    return { quotaProvider: "kimi", modelKey: resolved || raw || "unknown", reason: "matched" };
  }
  return { quotaProvider: null, modelKey: resolved || raw || "unknown", reason: "unknown_model" };
}

function belongsToQuota(record, provider, usageScope = "all-clients") {
  const identity = classifyQuotaModel(record);
  if (identity.quotaProvider !== provider) return false;
  if (provider === "openai" && usageScope === "codex-only") return record.tool === "codex";
  if (provider === "kimi" && usageScope === "kimi-code-only") return record.tool === "kimi-code";
  return true;
}

module.exports = { classifyQuotaModel, belongsToQuota };
