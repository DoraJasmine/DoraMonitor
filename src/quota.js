"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

/**
 * Kimi Code quota client.
 *
 * GET https://api.kimi.com/coding/v1/usages (Bearer token) reports:
 * - top-level `usage`: the weekly FEATURE_CODING quota the console shows,
 *   including a reset timestamp
 * - `limits[]`: the rolling 5-hour rate window (duration=300, minutes)
 *
 * Kimi has no monthly quota window — the weekly quota refreshes every 7 days
 * from the subscription date. Access tokens are short-lived (~15 min) and are
 * refreshed by the kimi CLI itself; when our copy is stale we surface the
 * quota as unavailable instead of failing the dashboard.
 */

const USAGES_URL = "https://api.kimi.com/coding/v1/usages";
// Discovered from the kimi CLI binary: refresh endpoint + public client id.
const TOKEN_URL = "https://auth.kimi.ai/api/oauth/token";
const OAUTH_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const FETCH_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 60_000;

const DETAIL_USED_KEYS = ["used", "usedValue", "used_value", "usedAmount", "used_amount", "currentValue", "current_value"];
const DETAIL_LIMIT_KEYS = ["limit", "limitValue", "limit_value", "total", "totalValue", "total_value", "quota", "max"];
const DETAIL_REMAINING_KEYS = ["remaining", "remainingValue", "remaining_value"];
const DETAIL_PERCENT_KEYS = ["percent", "percentage", "usedPercent", "used_percent", "usagePercentage"];
const DETAIL_RESET_KEYS = ["reset_at", "resetAt", "resetTime", "reset_time"];
const LIMITS_ARRAY_KEYS = ["limits", "limitInfos", "limit_infos", "rateLimits", "rate_limits"];
const WINDOW_DURATION_KEYS = ["duration", "windowDuration", "window_duration", "size", "value"];
const WINDOW_UNIT_KEYS = ["timeUnit", "time_unit", "unit", "windowUnit"];
const ENTRY_DETAIL_KEYS = ["detail", "usage", "quota"];
const ENTRY_WINDOW_KEYS = ["window", "period", "rateLimit", "rate_limit"];

let cache = { fetchedAt: 0, payload: null };

function credentialsPath(home) {
  return path.join(home, "credentials", "kimi-code.json");
}

function readCredentials(home) {
  try {
    const raw = JSON.parse(fs.readFileSync(credentialsPath(home), "utf8"));
    return {
      accessToken: String(raw.access_token || "").trim(),
      refreshToken: String(raw.refresh_token || "").trim(),
      expiresAt: Number(raw.expires_at) || 0,
    };
  } catch {
    return { accessToken: null, refreshToken: null, expiresAt: 0 };
  }
}

/**
 * Exchange the refresh token for a fresh access token and persist it back to
 * the credentials file (same shape the kimi CLI writes). Best-effort: on
 * failure the caller sees the refresh error and local stats keep working.
 */
async function refreshAccessToken(home) {
  const creds = readCredentials(home);
  if (!creds.refreshToken) {
    return { ok: false, reason: "no_credentials" };
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: creds.refreshToken,
    client_id: OAUTH_CLIENT_ID,
  });
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const resp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) {
      return { ok: false, reason: `refresh_http_${resp.status}` };
    }
    const data = await resp.json();
    const accessToken = String(data.access_token || "").trim();
    const refreshToken = String(data.refresh_token || "").trim() || creds.refreshToken;
    const expiresIn = Number(data.expires_in) || 900;
    if (!accessToken) {
      return { ok: false, reason: "refresh_empty_token" };
    }
    // Persist in the kimi CLI's format so both tools share one token rotation.
    try {
      fs.mkdirSync(path.dirname(credentialsPath(home)), { recursive: true });
      const tmp = `${credentialsPath(home)}.${process.pid}.tmp`;
      fs.writeFileSync(
        tmp,
        JSON.stringify(
          {
            access_token: accessToken,
            refresh_token: refreshToken,
            expires_at: Math.floor(Date.now() / 1000) + expiresIn,
            scope: String(data.scope || "kimi-code"),
            token_type: String(data.token_type || "Bearer"),
            expires_in: expiresIn,
          },
          null,
          2
        ),
        { encoding: "utf8", mode: 0o600 }
      );
      fs.renameSync(tmp, credentialsPath(home));
    } catch {
      // Persistence failure is not fatal for this request.
    }
    return { ok: true, accessToken };
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err) };
  }
}

function num(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.replace(/[$,]/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function pickNumber(obj, keys) {
  if (!obj || typeof obj !== "object") return null;
  for (const key of keys) {
    const value = num(obj[key]);
    if (value !== null) return value;
  }
  return null;
}

function pickRaw(obj, keys) {
  if (!obj || typeof obj !== "object") return null;
  for (const key of keys) {
    const value = obj[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

function toIso(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value < 20_000_000_000 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function usedPercentFromDetail(detail) {
  if (!detail || typeof detail !== "object") return null;
  const used = pickNumber(detail, DETAIL_USED_KEYS);
  const limit = pickNumber(detail, DETAIL_LIMIT_KEYS);
  if (limit !== null && limit > 0) {
    if (used !== null) {
      return Math.max(0, Math.min(100, (used / limit) * 100));
    }
    // Canonical Kimi payload reports remaining instead of used.
    const remaining = pickNumber(detail, DETAIL_REMAINING_KEYS);
    if (remaining !== null) {
      return Math.max(0, Math.min(100, ((limit - remaining) / limit) * 100));
    }
  }
  const percent = pickNumber(detail, DETAIL_PERCENT_KEYS);
  if (percent !== null) return Math.max(0, Math.min(100, percent));
  return null;
}

// Protobuf-style enums like TIME_UNIT_MINUTE / TIME_UNIT_DAY; match by substring.
function windowMinutes(duration, timeUnit) {
  const amount = num(duration);
  if (amount === null || amount <= 0) return null;
  const unit = String(timeUnit || "").trim().toUpperCase();
  if (unit.includes("MIN")) return amount;
  if (unit.includes("HOUR")) return amount * 60;
  if (unit.includes("DAY")) return amount * 24 * 60;
  if (unit.includes("WEEK")) return amount * 7 * 24 * 60;
  return null;
}

function parseUsageBody(body) {
  const data = body && typeof body.data === "object" ? body.data : body;
  if (!data || typeof data !== "object") return [];
  const windows = [];

  const usage = data.usage;
  if (usage && typeof usage === "object") {
    const usedPercent = usedPercentFromDetail(usage);
    if (usedPercent !== null) {
      windows.push({
        kind: "weekly",
        label: String(usage.name || "Weekly").trim() || "Weekly",
        usedPercent,
        resetsAt: toIso(pickRaw(usage, DETAIL_RESET_KEYS)),
      });
    }
  }

  const limits = LIMITS_ARRAY_KEYS.map((k) => (Array.isArray(data[k]) ? data[k] : null)).find(Boolean) || [];
  for (const entry of limits) {
    if (!entry || typeof entry !== "object") continue;
    const detail = ENTRY_DETAIL_KEYS.map((k) => (entry[k] && typeof entry[k] === "object" ? entry[k] : null)).find(Boolean) || entry;
    const usedPercent = usedPercentFromDetail(detail);
    if (usedPercent === null) continue;
    const window = ENTRY_WINDOW_KEYS.map((k) => (entry[k] && typeof entry[k] === "object" ? entry[k] : null)).find(Boolean) || {};
    const minutes = windowMinutes(pickNumber(window, WINDOW_DURATION_KEYS), String(pickRaw(window, WINDOW_UNIT_KEYS) || ""));
    windows.push({
      kind: minutes !== null && minutes <= 6 * 60 ? "session" : "weekly",
      label: minutes !== null && minutes <= 6 * 60 ? "5-hour" : "Weekly",
      usedPercent,
      resetsAt: toIso(pickRaw(detail, DETAIL_RESET_KEYS) ?? pickRaw(window, DETAIL_RESET_KEYS)),
    });
  }

  // De-duplicate: the top-level usage block and a 7-day limits[] entry can
  // describe the same weekly quota; prefer the entry with a reset time.
  const seen = new Map();
  for (const w of windows) {
    const prev = seen.get(w.kind);
    if (!prev || (!prev.resetsAt && w.resetsAt)) seen.set(w.kind, w);
  }
  return [...seen.values()];
}

async function fetchQuota(home, { force = false } = {}) {
  const now = Date.now();
  if (!force && cache.payload && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.payload;
  }
  // Credentials expire_at is in SECONDS (matches the kimi CLI file format);
  // mixing it with Date.now() ms would make the expiry check always true and
  // rotate the OAuth token on every quota fetch.
  const nowSec = Math.floor(now / 1000);

  const base = { fetchedAt: new Date(now).toISOString(), tool: "kimi-code", accountKey: "kimi:default" };
  let creds = readAccessTokenForCall(home);
  if (!creds) {
    cache = { fetchedAt: now, payload: { ...base, available: false, reason: "no_credentials", windows: [] } };
    return cache.payload;
  }

  // Short-lived (~15 min) token: refresh when expired or about to expire.
  if (creds.expiresAt && creds.expiresAt < nowSec + 30) {
    const refreshed = await refreshAccessToken(home);
    if (!refreshed.ok) {
      cache = { fetchedAt: now, payload: { ...base, available: false, reason: refreshed.reason, windows: [] } };
      return cache.payload;
    }
    creds = { token: refreshed.accessToken, expiresAt: nowSec + 900 };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const resp = await fetch(USAGES_URL, {
      headers: { Authorization: `Bearer ${creds.token}` },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) {
      cache = { fetchedAt: now, payload: { ...base, available: false, reason: `http_${resp.status}`, windows: [] } };
      return cache.payload;
    }
    const body = await resp.json();
    const windows = parseUsageBody(body);
    cache = { fetchedAt: now, payload: { ...base, available: windows.length > 0, reason: windows.length ? null : "empty", windows } };
  } catch (err) {
    cache = { fetchedAt: now, payload: { ...base, available: false, reason: String((err && err.message) || err), windows: [] } };
  }
  return cache.payload;
}

function readAccessTokenForCall(home) {
  const creds = readCredentials(home);
  if (!creds.accessToken) return null;
  return { token: creds.accessToken, expiresAt: creds.expiresAt };
}

module.exports = { fetchQuota, parseUsageBody, credentialsPath };
