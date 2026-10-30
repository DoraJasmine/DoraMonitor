"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

/**
 * Global settings — currency display and custom model prices.
 * Stored at ~/.doramonitor/config.json (best-effort; defaults on any
 * read/write failure so the dashboard never breaks because of config).
 *
 * Cost model: token costs are normalized to CNY in the internal `costCny`
 * field. Domestic providers remain at their official CNY prices; USD-only
 * providers are converted once using fxRate. Every output then displays CNY
 * unchanged or divides by fxRate for USD.
 *
 * customPrices entry:
 *   { model: "glm-5.3", input: 6.5, cacheHit: 1.3, output: 27,
 *     currency: "CNY", label: "GLM-5.3" }
 * `model` is matched case-insensitively: exact match first, then substring.
 */

const DEFAULTS = {
  currency: "CNY", // display currency: "CNY" | "USD"
  currencySymbol: "¥", // display symbol (auto-set from currency, overridable)
  fxRate: 6.67, // USD -> CNY
  customPrices: [], // see module doc
  quotaEstimation: {
    kimiCodeOnly: false,
  },
  sync: {
    enabled: false,
    backend: "ssh", // "ssh" | "webdav"
    deviceName: "", // defaults to hostname
    syncInterval: 300, // daemon sync interval seconds
    ssh: {
      host: "",
      user: "",
      port: 22,
      remotePath: "~/.kimi-status-sync", // shared root; files live under ai-usage-monitor/
      identityFile: "",
    },
    webdav: {
      url: "",
      username: "",
      password: "",
    },
  },
};

const CURRENCY_SYMBOLS = { USD: "$", CNY: "¥" };

let cache = { path: null, mtimeMs: 0, data: null };

function configDir() {
  return path.join(os.homedir(), ".doramonitor");
}

function configPath() {
  return path.join(configDir(), "config.json");
}

function sanitizeSettings(raw) {
  const out = { ...DEFAULTS, customPrices: [] };
  if (!raw || typeof raw !== "object") return out;

  if (raw.currency === "CNY" || raw.currency === "USD") {
    out.currency = raw.currency;
    out.currencySymbol = CURRENCY_SYMBOLS[raw.currency];
  }
  if (typeof raw.currencySymbol === "string" && raw.currencySymbol.trim()) {
    out.currencySymbol = raw.currencySymbol.trim().slice(0, 4);
  }
  const fx = Number(raw.fxRate);
  if (Number.isFinite(fx) && fx > 0 && fx < 100000) {
    out.fxRate = fx;
  }
  if (raw.quotaEstimation && typeof raw.quotaEstimation === "object") {
    out.quotaEstimation = { kimiCodeOnly: raw.quotaEstimation.kimiCodeOnly === true };
  }
  if (raw.sync && typeof raw.sync === "object") {
    const s = raw.sync;
    const outSync = { ...DEFAULTS.sync };
    outSync.enabled = s.enabled === true;
    outSync.backend = s.backend === "webdav" ? "webdav" : "ssh";
    outSync.deviceName = String(s.deviceName || "").trim().slice(0, 64);
    const interval = Number(s.syncInterval);
    if (Number.isFinite(interval) && interval >= 30) outSync.syncInterval = Math.floor(interval);
    if (s.ssh && typeof s.ssh === "object") {
      outSync.ssh = {
        host: String(s.ssh.host || "").trim().slice(0, 200),
        user: String(s.ssh.user || "").trim().slice(0, 64),
        port: clampInt(s.ssh.port, 1, 65535, 22),
        remotePath: String(s.ssh.remotePath || DEFAULTS.sync.ssh.remotePath).trim().slice(0, 300),
        identityFile: String(s.ssh.identityFile || "").trim().slice(0, 300),
      };
    }
    if (s.webdav && typeof s.webdav === "object") {
      outSync.webdav = {
        url: String(s.webdav.url || "").trim().slice(0, 300),
        username: String(s.webdav.username || "").trim().slice(0, 120),
        password: String(s.webdav.password || "").slice(0, 200),
      };
    }
    out.sync = outSync;
  }
  if (Array.isArray(raw.customPrices)) {
    for (const p of raw.customPrices) {
      if (!p || typeof p !== "object") continue;
      const model = String(p.model || "").trim();
      if (!model) continue;
      const entry = {
        model: model.slice(0, 120),
        input: posNum(p.input),
        cacheHit: posNum(p.cacheHit),
        output: posNum(p.output),
        currency: p.currency === "USD" ? "USD" : "CNY",
        label: String(p.label || "").trim().slice(0, 120),
      };
      if (entry.input === null && entry.cacheHit === null && entry.output === null) continue;
      out.customPrices.push(entry);
    }
  }
  return out;
}

function clampInt(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function posNum(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function loadSettings() {
  const p = configPath();
  try {
    const st = fs.statSync(p);
    if (cache.data && cache.path === p && st.mtimeMs === cache.mtimeMs) {
      return cache.data;
    }
    const data = sanitizeSettings(JSON.parse(fs.readFileSync(p, "utf8")));
    cache = { path: p, mtimeMs: st.mtimeMs, data };
    return data;
  } catch {
    return { ...DEFAULTS, customPrices: [] };
  }
}

function saveSettings(raw) {
  const data = sanitizeSettings(raw);
  fs.mkdirSync(configDir(), { recursive: true });
  const tmp = `${configPath()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, configPath());
  cache = { path: configPath(), mtimeMs: fs.statSync(configPath()).mtimeMs, data };
  return data;
}

/** Cost in internal CNY -> selected display-currency value (no symbol). */
function toDisplay(cnyCost, settings) {
  const s = settings || loadSettings();
  if (s.currency !== "USD") return cnyCost;
  const fx = Number(s.fxRate);
  return cnyCost / (Number.isFinite(fx) && fx > 0 ? fx : DEFAULTS.fxRate);
}

module.exports = {
  DEFAULTS,
  CURRENCY_SYMBOLS,
  loadSettings,
  saveSettings,
  sanitizeSettings,
  toDisplay,
  configPath,
};
