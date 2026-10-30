"use strict";

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
  return provider !== "kimi" || usageScope !== "kimi-code-only" || record.tool === "kimi-code";
}

module.exports = { classifyQuotaModel, belongsToQuota };
