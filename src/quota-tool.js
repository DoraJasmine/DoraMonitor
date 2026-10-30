"use strict";

function createQuotaIntegrationRegistry(initial = []) {
  const integrations = new Map();
  const register = (integration) => {
    if (!integration || !integration.tool || !integration.quotaProvider || !integration.capabilities) {
      throw new Error("A quota integration requires tool, quotaProvider and capabilities");
    }
    if (integrations.has(integration.tool)) throw new Error(`Duplicate quota integration: ${integration.tool}`);
    integrations.set(integration.tool, integration);
    return integration;
  };
  for (const integration of initial) register(integration);
  return {
    register,
    get: (tool) => integrations.get(tool) || null,
    list: () => [...integrations.values()],
  };
}

const defaultRegistry = createQuotaIntegrationRegistry([
  { tool: "kimi-code", quotaProvider: "kimi", capabilities: { windows: ["session", "weekly"], estimation: true } },
  { tool: "codex", quotaProvider: "openai", capabilities: { windows: ["session", "weekly"], estimation: true } },
]);

function normalizeQuotaTool(value) {
  const tool = String(value || "").trim();
  return defaultRegistry.get(tool) ? tool : null;
}

function quotaProviderForTool(tool) {
  return defaultRegistry.get(normalizeQuotaTool(tool))?.quotaProvider || null;
}

function toolForQuotaProvider(quotaProvider) {
  return defaultRegistry.list().find((integration) => integration.quotaProvider === quotaProvider)?.tool || null;
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

function resolveQuotaAccount({ accountKey, accounts = [] } = {}) {
  const available = [...new Set(accounts.filter(Boolean))];
  if (accountKey) {
    if (available.length && !available.includes(accountKey)) throw requestError("account_unavailable", `Quota account is unavailable: ${accountKey}`);
    return accountKey;
  }
  if (available.length > 1) throw requestError("account_required", "accountKey is required when multiple quota accounts are available");
  return available[0] || null;
}

module.exports = {
  createQuotaIntegrationRegistry,
  normalizeQuotaTool,
  quotaProviderForTool,
  toolForQuotaProvider,
  resolveQuotaTool,
  resolveQuotaAccount,
};
