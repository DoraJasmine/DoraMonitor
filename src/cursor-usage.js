"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { expandHome } = require("./tools/base");

/**
 * Cursor usage from cursor.com's dashboard API.
 *
 * Cursor writes no token counts anywhere on disk: the local
 * `ai-code-tracking.db` only records edit metadata, and agent transcripts
 * carry no usage. The only source is the account dashboard endpoint
 *
 *   POST https://cursor.com/api/dashboard/v2/query-daily-usage
 *
 * authenticated by the session JWT Cursor stores in
 *
 *   %APPDATA%\Cursor\User\globalStorage\state.vscdb  (ItemTable,
 *   key `cursorAuth/accessToken`, value `cursor-safe-storage:v1:<base64>`)
 *
 * Decryption chain (verified against real installs):
 *   1. base64 payload = 3-byte header "v10" | 12-byte GCM nonce | ciphertext
 *      | 16-byte GCM tag
 *   2. AES-256-GCM key = DPAPI(CurrentUser) unseal of
 *      `%APPDATA%\Cursor\Local State` → os_crypt.encrypted_key (base64,
 *      minus its 5-byte "DPAPI" prefix)
 *   3. DPAPI has no Node binding, so PowerShell does the unseal
 *
 * The token is used only to sign this request, is never written to disk and
 * never logged. What IS persisted is the daily usage cell list in
 * ~/.doramonitor/cursor-usage.json (15-minute TTL) because collection is
 * synchronous while this fetch is not — see tools/cursor.js.
 *
 * KNOWN LIMITS (source-inherent):
 *   - daily × model totals only — no input/output/cache split, no per-request
 *     rows, no project/session dimension;
 *   - the API rejects windows longer than 31 days, so history is bounded;
 *   - the numbers are account-level: two devices signed into the same Cursor
 *     account see identical data and would double count when synced.
 */

const USAGE_URL = "https://cursor.com/api/dashboard/v2/query-daily-usage";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
/** API rejects ranges longer than 31 days; 30 keeps a stable 31-point series. */
const WINDOW_DAYS = 30;
const CACHE_TTL_MS = 15 * 60 * 1000;
/** After a failure, do not retry before this (protects the dashboard loop). */
const FAILURE_RETRY_MS = 60 * 1000;
const TIMEOUT_MS = 15_000;
const SAFE_STORAGE_PREFIX = "cursor-safe-storage:v1:";

const DEFAULT_CACHE_FILE = path.join(os.homedir(), ".doramonitor", "cursor-usage.json");

/** home -> in-flight refresh promise (dedupe concurrent ticks). */
const inflight = new Map();
/** home -> epoch ms of the last failed refresh. */
const failureAt = new Map();

/** Cursor's application data directory (the `home` of this tool). */
function cursorHome() {
  const override = process.env.CURSOR_HOME;
  if (override && override.trim()) return path.resolve(expandHome(override.trim()));
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "Cursor");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Cursor");
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "Cursor");
}

function stateDbPath(home) {
  return path.join(home, "User", "globalStorage", "state.vscdb");
}

function localStatePath(home) {
  return path.join(home, "Local State");
}

/** Cursor is usable as a source once its credential store exists. */
function isCursorInstalled(home) {
  return fs.existsSync(stateDbPath(home)) && fs.existsSync(localStatePath(home));
}

/**
 * Copy the live credential DB (plus WAL/SHM) before reading: Cursor keeps
 * state.vscdb open and locked while running, so a direct read throws.
 */
function readAccessTokenSnapshot(dbPath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doramonitor-cursor-"));
  try {
    const copy = path.join(dir, path.basename(dbPath));
    fs.copyFileSync(dbPath, copy);
    for (const suffix of ["-wal", "-shm"]) {
      try {
        fs.copyFileSync(`${dbPath}${suffix}`, `${copy}${suffix}`);
      } catch {
        // A missing WAL/SHM simply means everything is already in the main file.
      }
    }
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(copy, { readOnly: true });
    try {
      const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get("cursorAuth/accessToken");
      return row && row.value != null ? String(row.value) : null;
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Windows DPAPI unseal via PowerShell (no native Node binding). */
function dpapiKey(home, execFileSyncImpl = execFileSync) {
  if (process.platform !== "win32") {
    throw new Error("unsupported platform: Cursor credential decryption needs Windows DPAPI");
  }
  const localState = JSON.parse(fs.readFileSync(localStatePath(home), "utf8"));
  const encryptedKey = localState && localState.os_crypt && localState.os_crypt.encrypted_key;
  if (!encryptedKey) throw new Error("Cursor Local State has no os_crypt.encrypted_key");
  // The base64 value carries a 5-byte "DPAPI" marker before the DPAPI blob.
  const script = [
    "Add-Type -AssemblyName System.Security",
    `$raw = [Convert]::FromBase64String('${encryptedKey}')`,
    "$blob = $raw[5..($raw.Length-1)]",
    "$dec = [System.Security.Cryptography.ProtectedData]::Unprotect($blob, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Convert]::ToBase64String($dec)",
  ].join("\n");
  const out = execFileSyncImpl("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 20_000,
  });
  const key = Buffer.from(String(out).trim(), "base64");
  if (key.length !== 32) throw new Error(`unexpected Cursor key length ${key.length}`);
  return key;
}

/** AES-256-GCM unseal of a `cursor-safe-storage:v1:` value. */
function unsealValue(key, value) {
  const raw = String(value || "");
  if (!raw.startsWith(SAFE_STORAGE_PREFIX)) return null;
  const buf = Buffer.from(raw.slice(SAFE_STORAGE_PREFIX.length), "base64");
  // 3-byte version header | 12-byte nonce | ciphertext | 16-byte tag
  if (buf.length < 3 + 12 + 16) return null;
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, buf.subarray(3, 15));
  decipher.setAuthTag(buf.subarray(buf.length - 16));
  return Buffer.concat([decipher.update(buf.subarray(15, buf.length - 16)), decipher.final()]).toString("utf8");
}

function jwtClaims(jwt) {
  const part = String(jwt).split(".")[1];
  if (!part) throw new Error("malformed Cursor access token");
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

/** Decrypt the stored session token -> { jwt, userId }. */
function readCursorAuth(home, { execFileSyncImpl = execFileSync } = {}) {
  const sealed = readAccessTokenSnapshot(stateDbPath(home));
  if (!sealed) throw new Error("Cursor session token missing — sign in to Cursor");
  const jwt = unsealValue(dpapiKey(home, execFileSyncImpl), sealed);
  if (!jwt) throw new Error("unsupported Cursor credential format — sign in to Cursor");
  const claims = jwtClaims(jwt);
  const userId = String(claims.sub || "").split("|").pop();
  if (!userId) throw new Error("Cursor token has no user id");
  if (Number(claims.exp) > 0 && Number(claims.exp) * 1000 <= Date.now()) {
    throw new Error("Cursor session expired — sign in to Cursor again");
  }
  return { jwt, userId };
}

/** series/points -> flat daily cells; zero-token days are dropped. */
function cellsFromResponse(json) {
  const cells = [];
  for (const series of (json && json.series) || []) {
    const model = String((series.dimensions && series.dimensions.model) || "unknown");
    for (const point of series.points || []) {
      const tokens = Number(point.tokens) || 0;
      if (tokens <= 0) continue;
      const day = String(point.dayStartTime || "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      cells.push({
        day,
        model,
        tokens,
        includedTokens: Number(point.includedTokens) || 0,
        costUsd: Number(point.contractedCost) || 0,
      });
    }
  }
  cells.sort((a, b) => (a.day === b.day ? (a.model < b.model ? -1 : 1) : a.day < b.day ? 1 : -1));
  return cells;
}

function readCursorUsageCache(cacheFile = DEFAULT_CACHE_FILE) {
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    if (!cached || cached.available !== true || !Array.isArray(cached.cells)) return null;
    if (!Number.isFinite(Date.parse(cached.fetchedAt || ""))) return null;
    return cached;
  } catch {
    return null;
  }
}

function persist(cacheFile, payload) {
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    const tmp = `${cacheFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(payload));
    fs.renameSync(tmp, cacheFile);
  } catch {
    // The in-memory caller still has this round's cells; disk is a nicety.
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `groupBy: ["model"]` intermittently answers 500 on cursor.com — retry 5xx
 *  and transport failures, but never retry a 4xx (bad request/auth). */
async function postUsage(fetchImpl, headers, body, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    let err;
    try {
      const res = await fetchImpl(USAGE_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) return res.json();
      err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
    } catch (e) {
      err = e;
    }
    if (attempt >= attempts || (err.status && err.status < 500)) throw err;
    await sleep(300 * attempt);
  }
}

async function fetchUsage({ home, now, fetchImpl, authImpl = readCursorAuth }) {
  const auth = authImpl(home);
  const headers = {
    "User-Agent": USER_AGENT,
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    Origin: "https://cursor.com",
    Referer: "https://cursor.com/dashboard/usage",
    Cookie: `WorkosCursorSessionToken=${auth.userId}::${auth.jwt}`,
  };
  const base = {
    startTime: new Date(now - WINDOW_DAYS * 86_400_000).toISOString(),
    endTime: new Date(now).toISOString(),
    scope: "user",
  };
  // No topN: the documented default works, while topN + ["model"] is the
  // combination seen to 500. Per-model is preferred; if it keeps failing the
  // account total (groupBy []) still gives a correct, if model-less, number.
  let json;
  try {
    json = await postUsage(fetchImpl, headers, { ...base, groupBy: ["model"] });
  } catch (err) {
    if (err.status && err.status < 500) throw err;
    json = await postUsage(fetchImpl, headers, { ...base, groupBy: [] });
  }
  return {
    available: true,
    reason: null,
    fetchedAt: new Date(now).toISOString(),
    cells: cellsFromResponse(json),
    totalTokens: Number(json.totalTokens) || 0,
  };
}

/**
 * Refresh (TTL-gated, deduped) and persist the usage cells. Never throws:
 * failures return the last good cache flagged `stale`, else an unavailable
 * payload.
 */
async function refreshCursorUsage({
  home = cursorHome(),
  now = Date.now(),
  force = false,
  cacheFile = DEFAULT_CACHE_FILE,
  fetchImpl = fetch,
  authImpl = readCursorAuth,
} = {}) {
  const cached = readCursorUsageCache(cacheFile);
  if (!force && cached && now - Date.parse(cached.fetchedAt) < CACHE_TTL_MS) return cached;

  const running = inflight.get(home);
  if (running) return running;

  const task = (async () => {
    try {
      const fresh = await fetchUsage({ home, now, fetchImpl, authImpl });
      persist(cacheFile, fresh);
      failureAt.delete(home);
      return fresh;
    } catch (err) {
      failureAt.set(home, Date.now());
      const reason = err && err.message ? err.message : String(err);
      return cached ? { ...cached, stale: true, reason } : { available: false, reason, cells: [], fetchedAt: null };
    } finally {
      inflight.delete(home);
    }
  })();
  inflight.set(home, task);
  return task;
}

/**
 * Fire-and-forget refresh for synchronous collectors: returns immediately,
 * and skips work while the cache is fresh, a refresh is in flight, or the
 * last attempt failed < FAILURE_RETRY_MS ago.
 */
function wakeCursorRefresh({ home = cursorHome(), now = Date.now(), cacheFile = DEFAULT_CACHE_FILE, ...rest } = {}) {
  const cached = readCursorUsageCache(cacheFile);
  if (cached && now - Date.parse(cached.fetchedAt) < CACHE_TTL_MS) return false;
  if (now - (failureAt.get(home) || 0) < FAILURE_RETRY_MS) return false;
  if (inflight.has(home)) return false;
  refreshCursorUsage({ home, now, force: true, cacheFile, ...rest }).catch(() => {});
  return true;
}

module.exports = {
  cursorHome,
  isCursorInstalled,
  stateDbPath,
  readCursorAuth,
  readCursorUsageCache,
  refreshCursorUsage,
  wakeCursorRefresh,
  cellsFromResponse,
  unsealValue,
  dpapiKey,
  DEFAULT_CACHE_FILE,
  CACHE_TTL_MS,
  WINDOW_DAYS,
};
