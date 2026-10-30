"use strict";

const TOOL_TO_QUOTA_PROVIDER = { "kimi-code": "kimi", codex: "openai" };

function normalizeQuotaTool(value) {
  const tool = String(value || "").trim();
  return Object.hasOwn(TOOL_TO_QUOTA_PROVIDER, tool) ? tool : null;
}

function quotaProviderForTool(tool) {
  return TOOL_TO_QUOTA_PROVIDER[normalizeQuotaTool(tool)] || null;
}

function toolForQuotaProvider(quotaProvider) {
  return Object.keys(TOOL_TO_QUOTA_PROVIDER).find((tool) => TOOL_TO_QUOTA_PROVIDER[tool] === quotaProvider) || null;
}

function requestError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.status = 400;
  return error;
}

function resolveQuotaTool({ tool, provider, defaultTool = "kimi-code" } = {}) {
  const hasTool = tool !== undefined && tool !== null && String(tool).trim() !== "";
  const hasProvider = provider !== undefined && provider !== null && String(provider).trim() !== "";
  const normalizedTool = hasTool ? normalizeQuotaTool(tool) : null;
  const legacyTool = hasProvider ? toolForQuotaProvider(String(provider).trim()) : null;
  if (hasTool && !normalizedTool) throw requestError("unsupported_tool", `Unsupported quota tool: ${tool}`);
  if (hasProvider && !legacyTool) throw requestError("unsupported_provider", `Unsupported quota provider: ${provider}`);
  if (normalizedTool && legacyTool && normalizedTool !== legacyTool) {
    throw requestError("conflicting_tool_provider", "tool and legacy provider refer to different quota tools");
  }
  return normalizedTool || legacyTool || defaultTool;
}

module.exports = { normalizeQuotaTool, quotaProviderForTool, toolForQuotaProvider, resolveQuotaTool };
