"use strict";

const crypto = require("crypto");

const ENDPOINTS = {
  bigmodel: "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
  zai: "https://api.z.ai/api/monitor/usage/quota/limit",
};
const cache = new Map();

function accountForKey(key) {
  return key ? `zcode:${crypto.createHash("sha256").update(key).digest("hex").slice(0, 16)}` : "zcode:default";
}

function parseZcodeUsage(body, { accountKey = "zcode:default", now = Date.now() } = {}) {
  const limits = body && body.data && Array.isArray(body.data.limits) ? body.data.limits : [];
  const windows = [];
  for (const entry of limits) {
    if (!entry || !["TOKENS_LIMIT", "CREDIT_LIMIT"].includes(entry.type)) continue;
    const usedPercent = Number(entry.percentage);
    if (!Number.isFinite(usedPercent)) continue;
    const kind = entry.unit === 3 ? "session" : entry.unit === 6 ? "weekly" : null;
    if (!kind) continue;
    const resetMs = Number(entry.nextResetTime);
    windows.push({
      kind,
      label: kind === "session" ? "5-hour" : "Weekly",
      usedPercent: Math.max(0, Math.min(100, usedPercent)),
      resetsAt: Number.isFinite(resetMs) && resetMs > 0 ? new Date(resetMs).toISOString() : null,
    });
  }
  return {
    available: windows.length > 0,
    reason: windows.length ? null : "empty",
    fetchedAt: new Date(now).toISOString(),
    tool: "zcode",
    accountKey,
    windows,
  };
}

async function fetchZcodeQuota({ env = process.env, force = false, fetchImpl = fetch, now = Date.now() } = {}) {
  const regional = env.BIGMODEL_API_KEY && env.BIGMODEL_API_KEY.trim();
  const international = env.Z_AI_API_KEY && env.Z_AI_API_KEY.trim();
  const key = regional || international;
  const accountKey = accountForKey(key);
  if (!key) return { available: false, reason: "no_credentials", fetchedAt: new Date(now).toISOString(), tool: "zcode", accountKey, windows: [] };
  const cached = cache.get(accountKey);
  if (!force && cached && now - cached.time < 60_000) return cached.quota;
  const endpoint = regional ? ENDPOINTS.bigmodel : ENDPOINTS.zai;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const response = await fetchImpl(endpoint, {
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) {
      return { available: false, reason: `http_${response.status}`, fetchedAt: new Date(now).toISOString(), tool: "zcode", accountKey, windows: [] };
    }
    const quota = parseZcodeUsage(await response.json(), { accountKey, now });
    cache.set(accountKey, { time: now, quota });
    return quota;
  } catch (error) {
    return { available: false, reason: String(error.message || error), fetchedAt: new Date(now).toISOString(), tool: "zcode", accountKey, windows: [] };
  }
}

module.exports = { fetchZcodeQuota, parseZcodeUsage, accountForKey };
