"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

/**
 * Active Codex cloud-quota polling.
 *
 * Rollout files only carry a rate_limits snapshot while the Codex CLI itself
 * is running; burning GPT quota from other clients (omp, IDEs, …) consumes
 * the same account-side windows without touching ~/.codex, so rollout-only
 * quota goes stale. This module polls ChatGPT's wham/usage endpoint with the
 * OAuth token from ~/.codex/auth.json — the same mechanism CodexBar and
 * omp's own usage module (packages/ai/src/usage/openai-codex.ts) use.
 *
 * Successful snapshots persist to ~/.doramonitor/codex-quota.json; any
 * network/auth failure silently falls back to that persisted snapshot, and
 * the tool further falls back to rollout-derived quota.
 */

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
/** Codex CLI's public OAuth client id (same constant CodexBar uses). */
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const MIN_INTERVAL_MS = 60_000;
const TIMEOUT_MS = 8_000;

const DEFAULT_CACHE_FILE = path.join(os.homedir(), ".doramonitor", "codex-quota.json");

/** home -> last network attempt (epoch ms). force bypasses. */
const lastAttempt = new Map();

function unavailable(reason) {
  return { available: false, reason, windows: [], fetchedAt: null };
}

/** Last successfully polled snapshot, or null. */
function readCachedCodexQuota(cacheFile = DEFAULT_CACHE_FILE) {
  try {
    const q = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    if (!q || q.available !== true || !Array.isArray(q.windows) || !q.windows.length) return null;
    if (!Number.isFinite(Date.parse(q.fetchedAt || ""))) return null;
    return q;
  } catch {
    return null;
  }
}

function readAuth(home) {
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(home, "auth.json"), "utf8"));
    const t = auth.tokens || {};
    if (!t.access_token) return null;
    return {
      accessToken: String(t.access_token),
      accountId: t.account_id ? String(t.account_id) : null,
      refreshToken: t.refresh_token ? String(t.refresh_token) : null,
    };
  } catch {
    return null;
  }
}

function codexAccountKey(home) {
  const auth = readAuth(home);
  if (!auth || !auth.accountId) return "openai:default";
  return `openai:${crypto.createHash("sha256").update(auth.accountId).digest("hex").slice(0, 16)}`;
}

/** Merge refreshed tokens into a freshly re-read auth.json (tmp + rename). */
function writeBackTokens(home, tokens) {
  try {
    const file = path.join(home, "auth.json");
    const auth = JSON.parse(fs.readFileSync(file, "utf8"));
    auth.tokens = { ...(auth.tokens || {}), ...tokens };
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(auth, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    // Best-effort: the in-memory token still serves this request.
  }
}

async function fetchJson(fetchImpl, url, options) {
  const res = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function usageHeaders(auth) {
  const headers = {
    Authorization: `Bearer ${auth.accessToken}`,
    "User-Agent": "doramonitor",
  };
  if (auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId;
  return headers;
}

async function refreshTokens(fetchImpl, home, refreshToken) {
  const data = await fetchJson(fetchImpl, TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: CODEX_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!data || !data.access_token) throw new Error("refresh returned no access_token");
  const tokens = { access_token: data.access_token };
  if (data.refresh_token) tokens.refresh_token = data.refresh_token;
  if (data.id_token) tokens.id_token = data.id_token;
  writeBackTokens(home, tokens);
  return tokens;
}

/** wham/usage window -> the same shape rollout rate_limits produce. */
function windowFromWham(w, kind, label) {
  if (!w || typeof w !== "object") return null;
  const used = Number(w.used_percent);
  if (!Number.isFinite(used)) return null;
  let resetsAt = Number(w.reset_at);
  if (Number.isFinite(resetsAt) && resetsAt > 100000000000) resetsAt /= 1000;
  const date = Number.isFinite(resetsAt) && resetsAt > 0 ? new Date(resetsAt * 1000) : null;
  return {
    kind,
    label,
    usedPercent: Math.min(100, Math.max(0, used)),
    resetsAt: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null,
  };
}

function quotaFromWham(json, now, accountKey) {
  const rl = json && json.rate_limit;
  const windows = [
    windowFromWham(rl && rl.primary_window, "session", "5-hour"),
    windowFromWham(rl && rl.secondary_window, "weekly", "Weekly"),
  ].filter(Boolean);
  if (!windows.length) return null;
  const credits = json.credits || {};
  return {
    available: true,
    reason: null,
    windows,
    fetchedAt: new Date(now).toISOString(),
    planType: json.plan_type || null,
    creditsBalance: Number.isFinite(Number(credits.balance)) ? Number(credits.balance) : null,
    accountKey,
    source: "wham",
  };
}

function persist(cacheFile, quota) {
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    const tmp = `${cacheFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(quota));
    fs.renameSync(tmp, cacheFile);
  } catch {
    // Cache is a nicety; the in-memory result still stands.
  }
}

/**
 * Poll wham/usage (throttled to once a minute per home; force bypasses).
 * Never throws: failure returns the persisted snapshot, else an unavailable
 * payload. `fetchImpl`/`cacheFile` are injectable for tests.
 */
async function getCodexQuota(home, { force = false, fetchImpl = fetch, cacheFile = DEFAULT_CACHE_FILE } = {}) {
  const cached = readCachedCodexQuota(cacheFile);
  const last = lastAttempt.get(home) || 0;
  if (!force && Date.now() - last < MIN_INTERVAL_MS) {
    return cached || unavailable("throttled");
  }
  lastAttempt.set(home, Date.now());

  const auth = readAuth(home);
  if (!auth) return cached || unavailable("no_auth");

  try {
    let json;
    try {
      json = await fetchJson(fetchImpl, USAGE_URL, { headers: usageHeaders(auth) });
    } catch (err) {
      if (!auth.refreshToken || !(err && err.status === 401)) throw err;
      const tokens = await refreshTokens(fetchImpl, home, auth.refreshToken);
      auth.accessToken = tokens.access_token;
      json = await fetchJson(fetchImpl, USAGE_URL, { headers: usageHeaders(auth) });
    }
    const quota = quotaFromWham(json, Date.now(), codexAccountKey(home));
    if (!quota) throw new Error("no windows in wham response");
    persist(cacheFile, quota);
    return quota;
  } catch {
    return cached || unavailable("fetch_failed");
  }
}

module.exports = { getCodexQuota, readCachedCodexQuota, codexAccountKey, DEFAULT_CACHE_FILE };
