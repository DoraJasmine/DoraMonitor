"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { DatabaseSync } = require("node:sqlite");
const { toolMeta, expandHome } = require("./tools/base");
const {
  PricingCatalog,
  INPUT_TOKEN_SEMANTICS_FRESH,
  INPUT_TOKEN_SEMANTICS_TOTAL,
  CACHE_INCLUSIVE_APPS,
  cleanModelIdForPricing,
} = require("./ccswitch-pricing");

/**
 * DoraMonitor → CC Switch bridge.
 *
 * Writes the multi-device usage the /sync pull already aggregated (peer
 * summaries cached under ~/.doramonitor/remote-cache/*.json) into CC
 * Switch's `proxy_request_logs`, so CC Switch's 使用统计 also shows the
 * remote hosts — the same write discipline ccs-ssh-sync established:
 *   - dynamic column projection (PRAGMA table_info per open) so CC Switch
 *     migrations never break external writes;
 *   - deterministic request_ids → INSERT OR IGNORE is idempotent, content
 *     changes go through a guarded UPDATE;
 *   - a sidecar ledger (~/.doramonitor/cc-switch-bridge-state.db) records
 *     written row hashes: unchanged rows never touch cc-switch.db, and rows
 *     CC Switch already archived (30-day rollup_and_prune) are never
 *     resurrected;
 *   - crash-safe order: cc-switch.db commits first, the ledger follows;
 *   - costs come from CC Switch's own model_pricing table at write time
 *     (BigInt fixed point, see ccswitch-pricing.js).
 *
 * Everything lives under `data_source = 'dora_bridge'` — a namespace of its
 * own, disjoint from ccs-ssh-sync's 'remote_sync' (whose reset command must
 * not delete bridged rows, and vice versa).
 *
 * CONFLICT PAUSE: when ccs-ssh-sync is running (or has already written
 * remote_sync rows), the same remote hosts' usage would land in CC Switch
 * twice. The bridge then pauses itself — even while enabled — and reports
 * the reason so the UI can show a persistent notice. It resumes
 * automatically once the conflict disappears.
 */

const DATA_SOURCE = "dora_bridge";
const CCS_SOURCE = "remote_sync"; // ccs-ssh-sync's namespace — observed, never written

/** DoraMonitor tool id → CC Switch app_type. Unmapped tools are skipped. */
const APP_TYPE_BY_TOOL = {
  "kimi-code": "kimi",
  codex: "codex",
  "claude-code": "claude",
  dsh: "dsh",
  omp: "omp",
  antigravity: "agy",
  zcode: "zcode",
  gemini: "gemini",
};

const REQUIRED_LOG_COLUMNS = [
  "request_id",
  "provider_id",
  "app_type",
  "model",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_creation_tokens",
  "total_cost_usd",
  "status_code",
  "created_at",
];

const PROVIDER_LABEL_SEPARATOR = " · ";

// ---------------------------------------------------------------------------
// Paths & status file
// ---------------------------------------------------------------------------

function bridgeConfigDir() {
  return path.join(os.homedir(), ".doramonitor");
}

function statusPath() {
  return process.env.DORAMONITOR_CC_BRIDGE_STATUS || path.join(bridgeConfigDir(), "cc-switch-bridge.json");
}

function stateDbPath() {
  return process.env.DORAMONITOR_CC_BRIDGE_STATE || path.join(bridgeConfigDir(), "cc-switch-bridge-state.db");
}

function defaultCcSwitchDbPath() {
  return path.join(os.homedir(), ".cc-switch", "cc-switch.db");
}

function resolveDbPath(cfg) {
  const raw = cfg && cfg.dbPath ? String(cfg.dbPath).trim() : "";
  return raw ? path.resolve(expandHome(raw)) : defaultCcSwitchDbPath();
}

function remoteCacheDir() {
  return process.env.DORAMONITOR_REMOTE_CACHE_DIR || path.join(bridgeConfigDir(), "remote-cache");
}

function readStatus() {
  try {
    return JSON.parse(fs.readFileSync(statusPath(), "utf8"));
  } catch {
    return { firstSeenAt: new Date().toISOString() };
  }
}

function writeStatus(status) {
  try {
    fs.mkdirSync(path.dirname(statusPath()), { recursive: true });
    const tmp = `${statusPath()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(status, null, 2), "utf8");
    fs.renameSync(tmp, statusPath());
  } catch {
    /* status is best-effort */
  }
}

// ---------------------------------------------------------------------------
// ccs-ssh-sync conflict detection
// ---------------------------------------------------------------------------

let processCheckCache = { at: 0, running: false };

/** True when a node process whose command line mentions ccs-ssh-sync runs.
 *  Windows-only (ccs-ssh-sync targets Windows CC Switch); cached for 20s so
 *  repeated daemon ticks do not spawn PowerShell every time. */
function ccsSshSyncProcessRunning() {
  if (process.platform !== "win32") return false;
  // Escape hatch for headless environments / CI (and for users who accept
  // the double-count risk and want the bridge to run anyway).
  if (process.env.DORAMONITOR_CC_BRIDGE_NO_PROCESS_PROBE === "1") return false;
  const now = Date.now();
  if (now - processCheckCache.at < 20_000) return processCheckCache.running;
  let running = false;
  try {
    const res = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object -ExpandProperty CommandLine"],
      { timeout: 8000, windowsHide: true, encoding: "utf8" }
    );
    if (res.status === 0 && typeof res.stdout === "string") {
      running = /ccs-ssh-sync/i.test(res.stdout);
    }
  } catch {
    /* probe failure is not evidence of a conflict */
  }
  processCheckCache = { at: now, running };
  return running;
}

function ccSwitchHasRemoteSyncRows(dbPath) {
  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db
      .prepare(`SELECT EXISTS(SELECT 1 FROM proxy_request_logs WHERE data_source = ? LIMIT 1) AS hit`)
      .get(CCS_SOURCE);
    return Number(row && row.hit) > 0;
  } catch {
    return false;
  } finally {
    try { if (db) db.close(); } catch { /* ignore */ }
  }
}

function ccsSshSyncConfigured() {
  try {
    const cfgPath = path.join(os.homedir(), ".cc-switch", "remote-sync.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    return Array.isArray(cfg.sources) && cfg.sources.some((s) => s && s.enabled !== false);
  } catch {
    return false;
  }
}

/**
 * Three-level detection: a running ccs-ssh-sync daemon (process probe), rows
 * it already wrote ('remote_sync' data), and — informational — its config.
 * `running` and `data` pause the bridge; `configured` only annotates status.
 */
let processProbeImpl = ccsSshSyncProcessRunning;

/** Test hook: swap the (slow, Windows-only) process probe. */
function _setProcessProbeForTest(fn) {
  processProbeImpl = fn;
}

/**
 * Only a RUNNING ccs-ssh-sync daemon pauses the bridge (concurrent writes to
 * the same days would race). Mere remote_sync DATA does not pause anything
 * any more — the per-app time watermark resumes from its last write, so the
 * two writers can be switched back and forth without resetting any data.
 */
function detectCcsSshSyncConflict(dbPath) {
  const checkedAt = new Date().toISOString();
  if (processProbeImpl()) {
    return { conflict: true, reason: "process", detail: "ccs-ssh-sync 守护进程正在运行", checkedAt };
  }
  return {
    conflict: false,
    reason: null,
    otherWriterData: ccSwitchHasRemoteSyncRows(dbPath),
    configured: ccsSshSyncConfigured(),
    checkedAt,
  };
}

// ---------------------------------------------------------------------------
// Sidecar ledger
// ---------------------------------------------------------------------------

const STATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS synced_rows (
  request_id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  device TEXT NOT NULL,
  app_type TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_synced_rows_device ON synced_rows(device);

CREATE TABLE IF NOT EXISTS covered_days (
  device TEXT NOT NULL,
  day TEXT NOT NULL,
  PRIMARY KEY (device, day)
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

class BridgeState {
  constructor(dbPath = stateDbPath()) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(STATE_SCHEMA_SQL);
  }

  close() {
    if (this.db) {
      try { this.db.close(); } catch { /* ignore */ }
      this.db = null;
    }
  }

  /** request_id → content_hash for the given candidate ids (400/batch IN). */
  knownHashes(requestIds) {
    const map = new Map();
    for (let i = 0; i < requestIds.length; i += 400) {
      const slice = requestIds.slice(i, i + 400);
      const rows = this.db
        .prepare(`SELECT request_id, content_hash FROM synced_rows WHERE request_id IN (${slice.map(() => "?").join(",")})`)
        .all(...slice);
      for (const r of rows) map.set(r.request_id, r.content_hash);
    }
    return map;
  }

  recordWritten(rows) {
    if (!rows || rows.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO synced_rows (request_id, content_hash, device, app_type, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(request_id) DO UPDATE SET
         content_hash = excluded.content_hash,
         updated_at = excluded.updated_at`
    );
    const now = Math.floor(Date.now() / 1000);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const r of rows) {
        stmt.run(r.requestId, r.contentHash, r.device, r.appType, now);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
      throw err;
    }
  }

  count() {
    return Number(this.db.prepare(`SELECT COUNT(*) AS n FROM synced_rows`).get().n) || 0;
  }

  /** Days whose proxy_request_logs rows are per-request (v6 window). */
  coveredDays(device) {
    const rows = this.db
      .prepare(`SELECT day FROM covered_days WHERE device = ?`)
      .all(device);
    return new Set(rows.map((r) => String(r.day)));
  }

  markCoveredDays(device, days) {
    if (!days || !days.length) return;
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO covered_days (device, day) VALUES (?, ?)`
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const day of days) stmt.run(device, String(day));
      this.db.exec("COMMIT");
    } catch (err) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
      throw err;
    }
  }

  getMeta(key) {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key);
    return row ? row.value : null;
  }

  setMeta(key, value) {
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(String(key), String(value));
  }

  /**
   * Cross-writer resume positions: the newest created_at (epoch SECONDS)
   * the OTHER writer (ccs-ssh-sync) has written, per app_type. Monotonic —
   * CC Switch's 30-day rollup pruning removes its raw rows, so the
   * persisted map must never regress. Requests at/before the watermark are
   * already in CC Switch; the bridge writes only what comes after
   * (time-level incremental resume). `clearWatermarks` after genuinely
   * resetting the other writer's data.
   */
  otherWriterWatermarks() {
    try {
      const raw = JSON.parse(this.getMeta("other_writer_watermarks") || "{}");
      return raw && typeof raw === "object" ? raw : {};
    } catch {
      return {};
    }
  }

  advanceOtherWriterWatermarks(live) {
    const current = this.otherWriterWatermarks();
    let changed = false;
    for (const [app, sec] of Object.entries(live || {})) {
      const n = Math.floor(Number(sec) || 0);
      if (n > 0 && n > (Number(current[app]) || 0)) {
        current[app] = n;
        changed = true;
      }
    }
    if (changed) this.setMeta("other_writer_watermarks", JSON.stringify(current));
  }

  clearWatermarks() {
    this.db.prepare(`DELETE FROM meta WHERE key = ?`).run("other_writer_watermarks");
  }

  clearAll() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec("DELETE FROM synced_rows; DELETE FROM covered_days; DELETE FROM meta;");
      this.db.exec("COMMIT");
    } catch (err) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// CC Switch target database
// ---------------------------------------------------------------------------

function sleepMs(ms) {
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, ms);
}

function isSqliteBusyError(err) {
  const msg = String((err && err.message) || err || "");
  return (
    (err && err.errcode === 5) ||
    (err && err.code === "ERR_SQLITE_ERROR" && /busy|locked/i.test(msg))
  );
}

function runWithBusyRetry(fn, maxAttempts = 6) {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return fn();
    } catch (err) {
      if (!isSqliteBusyError(err) || attempt >= maxAttempts) throw err;
      sleepMs(80 * attempt + Math.floor(Math.random() * 60));
    }
  }
}

class CcSwitchTarget {
  constructor(dbPath) {
    if (!fs.existsSync(dbPath)) {
      throw new Error(`CC Switch database not found at ${dbPath}`);
    }
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath);
    // Match ccs-ssh-sync: only concurrency/FK pragmas — never touch CC
    // Switch's own WAL / auto_vacuum settings.
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    this.schemaInfo = this.inspectSchema();
    this.catalog = PricingCatalog.fromDatabase(this.db);
  }

  close() {
    if (this.db) {
      try { this.db.close(); } catch { /* ignore */ }
      this.db = null;
    }
  }

  inspectSchema() {
    const versionRow = this.db.prepare("PRAGMA user_version").get();
    const userVersion = Number(versionRow && versionRow.user_version) || 0;
    const cols = this.db.prepare("PRAGMA table_info(proxy_request_logs)").all();
    const colSet = new Set(cols.map((c) => c.name));
    const missing = REQUIRED_LOG_COLUMNS.filter((c) => !colSet.has(c));
    if (missing.length > 0) {
      throw new Error(
        `CC Switch schema unsupported (user_version=${userVersion}); missing columns: ${missing.join(", ")}`
      );
    }
    return { userVersion, columns: colSet };
  }

  /**
   * Cross-writer resume positions per app: the OTHER writer's newest
   * created_at (epoch SECONDS) per app_type among its `remote_sync` rows.
   */
  remoteSyncWatermarksByApp() {
    const out = {};
    try {
      const rows = this.db
        .prepare(`SELECT app_type, MAX(created_at) AS mx FROM proxy_request_logs WHERE data_source = ? GROUP BY app_type`)
        .all(CCS_SOURCE);
      for (const r of rows) {
        const v = Number(r && r.mx) || 0;
        if (v > 0 && r.app_type) out[String(r.app_type)] = v;
      }
    } catch {
      /* best effort */
    }
    return out;
  }

  /**
   * Usage fingerprints of the other writer's rows around the resume
   * boundary. Both writers parse the same source data, so a boundary
   * request matches on (app, normalized model, token counts) with a small
   * created_at tolerance — this absorbs the two projects' different
   * timestamp sources (e.g. Antigravity brain-JSONL vs steps.protobuf).
   */
  remoteSyncFingerprintsSince(sec) {
    const map = new Map();
    try {
      const rows = this.db
        .prepare(
          `SELECT app_type, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, created_at
           FROM proxy_request_logs WHERE data_source = ? AND created_at >= ?`
        )
        .all(CCS_SOURCE, Math.max(0, Math.floor(sec)));
      for (const r of rows) {
        const key = usageFingerprintKey(r.app_type, r.model, r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_creation_tokens);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(Number(r.created_at) || 0);
      }
    } catch {
      /* best effort */
    }
    return map;
  }

  hasAnyBridgeData(deviceLabels) {
    const logs = this.db
      .prepare(`SELECT EXISTS(SELECT 1 FROM proxy_request_logs WHERE data_source = ? LIMIT 1) AS hit`)
      .get(DATA_SOURCE);
    if (Number(logs && logs.hit) > 0) return true;
    // Rolled-up history lives in usage_daily_rollups keyed by provider_id.
    try {
      for (const label of deviceLabels) {
        if (!label) continue;
        const hit = this.db
          .prepare(`SELECT EXISTS(SELECT 1 FROM usage_daily_rollups WHERE provider_id = ? OR provider_id LIKE ? LIMIT 1) AS hit`)
          .get(label, `${label}%`);
        if (Number(hit && hit.hit) > 0) return true;
      }
    } catch {
      /* older CC Switch without rollups — logs check already ran */
    }
    return false;
  }

  rowExists(requestId) {
    const row = this.db
      .prepare(`SELECT EXISTS(SELECT 1 FROM proxy_request_logs WHERE request_id = ? AND data_source = ? LIMIT 1) AS hit`)
      .get(requestId, DATA_SOURCE);
    return Number(row && row.hit) > 0;
  }

  /** Ordered INSERT spec projected onto the CURRENT schema. */
  buildInsertSpec() {
    const candidates = [
      ["request_id", (r) => r.requestId],
      ["provider_id", (r) => r.providerId],
      ["app_type", (r) => r.appType],
      ["model", (r) => r.model || "unknown"],
      ["request_model", (r) => r.requestModel || r.model || "unknown"],
      ["pricing_model", (r) => r.pricingModel ?? null],
      ["input_tokens", (r) => Math.max(0, Math.trunc(r.inputTokens || 0))],
      ["output_tokens", (r) => Math.max(0, Math.trunc(r.outputTokens || 0))],
      ["cache_read_tokens", (r) => Math.max(0, Math.trunc(r.cacheReadTokens || 0))],
      ["cache_creation_tokens", (r) => Math.max(0, Math.trunc(r.cacheCreationTokens || 0))],
      ["input_cost_usd", (r) => r.inputCostUsd || "0"],
      ["output_cost_usd", (r) => r.outputCostUsd || "0"],
      ["cache_read_cost_usd", (r) => r.cacheReadCostUsd || "0"],
      ["cache_creation_cost_usd", (r) => r.cacheCreationCostUsd || "0"],
      ["total_cost_usd", (r) => r.totalCostUsd || "0"],
      ["latency_ms", (r) => (r.latencyMs != null ? Math.max(0, Math.trunc(r.latencyMs)) : 0)],
      ["first_token_ms", (r) => (r.firstTokenMs != null ? Math.max(0, Math.trunc(r.firstTokenMs)) : null)],
      ["duration_ms", (r) => (r.durationMs != null ? Math.max(0, Math.trunc(r.durationMs)) : null)],
      ["status_code", (r) => Math.trunc(r.statusCode ?? 200)],
      ["error_message", (r) => r.errorMessage ?? null],
      ["session_id", (r) => r.sessionId ?? null],
      ["provider_type", (r) => r.providerType || DATA_SOURCE],
      ["is_streaming", (r) => (r.isStreaming === 0 ? 0 : 1)],
      ["cost_multiplier", (r) => r.costMultiplier || "1.0"],
      ["created_at", (r) => Math.trunc(r.createdAt || 0)],
      ["data_source", () => DATA_SOURCE],
      ["input_token_semantics", (r) => r.inputTokenSemantics ?? INPUT_TOKEN_SEMANTICS_FRESH],
    ];
    const active = candidates.filter(([col]) => this.schemaInfo.columns.has(col));
    return {
      sql: `INSERT OR IGNORE INTO proxy_request_logs (${active.map(([c]) => `"${c}"`).join(", ")}) VALUES (${active.map(() => "?").join(", ")})`,
      extractParams: (r) => active.map(([, fn]) => fn(r)),
    };
  }

  insertRows(rows) {
    if (!rows || rows.length === 0) return 0;
    const spec = this.buildInsertSpec();
    const stmt = this.db.prepare(spec.sql);
    let inserted = 0;
    runWithBusyRetry(() => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        for (let i = 0; i < rows.length; i += 400) {
          for (const r of rows.slice(i, i + 400)) {
            const info = stmt.run(...spec.extractParams(r));
            inserted += Number(info.changes || 0);
          }
        }
        this.db.exec("COMMIT");
      } catch (err) {
        try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
        throw err;
      }
    });
    return inserted;
  }

  updateRows(rows) {
    if (!rows || rows.length === 0) return 0;
    const stmt = this.db.prepare(
      `UPDATE proxy_request_logs
       SET provider_id = ?, app_type = ?, model = ?, request_model = ?, pricing_model = ?,
           input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_creation_tokens = ?,
           input_cost_usd = ?, output_cost_usd = ?, cache_read_cost_usd = ?,
           cache_creation_cost_usd = ?, total_cost_usd = ?,
           latency_ms = ?, first_token_ms = ?, duration_ms = ?,
           status_code = ?, created_at = ?, input_token_semantics = ?
       WHERE request_id = ? AND data_source = ?`
    );
    let updated = 0;
    runWithBusyRetry(() => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        for (const r of rows) {
          const info = stmt.run(
            r.providerId,
            r.appType,
            r.model || "unknown",
            r.requestModel || r.model || "unknown",
            r.pricingModel ?? null,
            Math.max(0, Math.trunc(r.inputTokens || 0)),
            Math.max(0, Math.trunc(r.outputTokens || 0)),
            Math.max(0, Math.trunc(r.cacheReadTokens || 0)),
            Math.max(0, Math.trunc(r.cacheCreationTokens || 0)),
            r.inputCostUsd || "0",
            r.outputCostUsd || "0",
            r.cacheReadCostUsd || "0",
            r.cacheCreationCostUsd || "0",
            r.totalCostUsd || "0",
            r.latencyMs != null ? Math.max(0, Math.trunc(r.latencyMs)) : 0,
            r.firstTokenMs != null ? Math.max(0, Math.trunc(r.firstTokenMs)) : null,
            r.durationMs != null ? Math.max(0, Math.trunc(r.durationMs)) : null,
            Math.trunc(r.statusCode ?? 200),
            Math.trunc(r.createdAt || 0),
            r.inputTokenSemantics ?? INPUT_TOKEN_SEMANTICS_FRESH,
            r.requestId,
            DATA_SOURCE
          );
          updated += Number(info.changes || 0);
        }
        this.db.exec("COMMIT");
      } catch (err) {
        try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
        throw err;
      }
    });
    return updated;
  }

  /**
   * Remove our own day-aggregate rows for days that have transitioned into
   * the v6 per-request window (they are superseded by request-level rows;
   * keeping both would double count the day). Scoped to the aggregate
   * request_id shape `dora_bridge:<devKey>:<tool>:<model>:<day>` — request
   * rows use the `dora_bridge:r:<devKey>:<hash>` prefix and never match.
   */
  deleteAggregateRows(deviceKey, days) {
    if (!days || !days.length) return 0;
    const stmt = this.db.prepare(
      `DELETE FROM proxy_request_logs
       WHERE data_source = ? AND request_id LIKE ?`
    );
    let deleted = 0;
    runWithBusyRetry(() => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        for (const day of days) {
          const info = stmt.run(DATA_SOURCE, `dora_bridge:${deviceKey}:%:${day}`);
          deleted += Number(info.changes || 0);
        }
        this.db.exec("COMMIT");
      } catch (err) {
        try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
        throw err;
      }
    });
    return deleted;
  }
}

// ---------------------------------------------------------------------------
// Row building
// ---------------------------------------------------------------------------

function sanitizeIdSegment(value, max = 80) {
  const s = String(value == null ? "" : value).trim();
  return (s.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "x").slice(0, max);
}

function dayNoonSec(day) {
  const [y, m, d] = String(day).split("-").map(Number);
  if (!y || !m || !d) return 0;
  // proxy_request_logs.created_at is epoch SECONDS (matches CC Switch's own
  // rows and ccs-ssh-sync's writer).
  return Math.floor(new Date(y, m - 1, d, 12, 0, 0).getTime() / 1000);
}

/** Stable short device key for request_id encoding (deviceId when present). */
function deviceKeyOf(summary) {
  return summary && summary.deviceId
    ? sanitizeIdSegment(summary.deviceId, 24)
    : crypto.createHash("sha1").update(String((summary && summary.device) || "peer")).digest("hex").slice(0, 12);
}

function cellTimingMs(value) {
  if (value == null) return null;
  const x = Number(value);
  return Number.isFinite(x) && x >= 0 ? Math.round(x) : null;
}

function contentHashOf(row) {
  return crypto
    .createHash("sha1")
    .update(
      JSON.stringify([
        row.providerId,
        row.appType,
        row.model,
        row.inputTokens,
        row.outputTokens,
        row.cacheReadTokens,
        row.cacheCreationTokens,
        row.inputCostUsd,
        row.outputCostUsd,
        row.cacheReadCostUsd,
        row.cacheCreationCostUsd,
        row.totalCostUsd,
        row.latencyMs,
        row.firstTokenMs,
        row.durationMs,
        row.createdAt,
        row.inputTokenSemantics,
      ])
    )
    .digest("hex");
}

// --- cross-writer boundary fingerprints -------------------------------------

/** created_at tolerance (seconds) when matching boundary requests. */
const FINGERPRINT_TIME_TOLERANCE_SEC = 10;
/** Request rows this close AFTER the watermark get fingerprint-checked. */
const BOUNDARY_CHECK_WINDOW_SEC = 120;

/**
 * Writer-agnostic identity of one request: both projects parse the same
 * source data with aligned token semantics, so (app, normalized model,
 * token counts) identifies a request across the two request_id namespaces.
 */
function usageFingerprintKey(appType, model, i, o, cr, cc) {
  return [
    String(appType || ""),
    cleanModelIdForPricing(model),
    Math.max(0, Math.trunc(Number(i) || 0)),
    Math.max(0, Math.trunc(Number(o) || 0)),
    Math.max(0, Math.trunc(Number(cr) || 0)),
    Math.max(0, Math.trunc(Number(cc) || 0)),
  ].join("\u0000");
}

function fingerprintMatched(map, key, createdAt) {
  const times = map.get(key);
  if (!times) return false;
  const t = Math.trunc(Number(createdAt) || 0);
  return times.some((x) => Math.abs(x - t) <= FINGERPRINT_TIME_TOLERANCE_SEC);
}

/**
 * Turn one peer summary into day-aggregate bridge rows for the days NOT
 * covered by the v6 request window (covered days get per-request rows from
 * requestRowsFromSummary instead — never both, or CC Switch double counts)
 * and NOT at/before the other writer's per-app watermark day (its request
 * rows already own those days). Tools CC Switch does not know are skipped.
 */
function rowsFromSummary(summary, catalog, coveredDays = null, watermarks = {}) {
  const rows = [];
  const skippedTools = {};
  const device = String((summary && summary.device) || "peer").slice(0, 48) || "peer";
  const deviceKey = deviceKeyOf(summary);
  const days = (summary && summary.days) || {};
  for (const rawDay of Object.keys(days)) {
    if (String(rawDay).startsWith("__")) continue;
    const day = String(rawDay);
    if (coveredDays && coveredDays.has(day)) continue;
    const createdAt = dayNoonSec(day);
    const dayEntry = days[day] || {};
    for (const rawTool of Object.keys(dayEntry)) {
      if (String(rawTool).startsWith("__")) continue;
      const tool = String(rawTool);
      const appType = APP_TYPE_BY_TOOL[tool];
      if (!appType) {
        skippedTools[tool] = (skippedTools[tool] || 0) + 1;
        continue;
      }
      // Days at/before the other writer's watermark are owned by its
      // request rows — an aggregate row here would double count.
      const wm = Number(watermarks[appType]) || 0;
      if (wm > 0 && day <= dayKeyOf(wm * 1000)) continue;
      const toolLabel = toolMeta(tool).label;
      const providerId = `${device}${PROVIDER_LABEL_SEPARATOR}${toolLabel}`.slice(0, 120);
      const models = dayEntry[tool] || {};
      for (const rawModel of Object.keys(models)) {
        if (String(rawModel).startsWith("__")) continue;
        const model = String(rawModel || "unknown").slice(0, 200) || "unknown";
        const b = models[rawModel] || {};
        const reqs = Math.max(1, Math.trunc(Number(b.req) || 1));
        const inputFresh = Math.max(0, Math.trunc(Number(b.i) || 0));
        const cacheRead = Math.max(0, Math.trunc(Number(b.cr) || 0));
        const cacheCreate = Math.max(0, Math.trunc(Number(b.cc) || 0));
        const cacheCreate1h = Math.max(0, Math.trunc(Number(b.cl) || 0));
        const output = Math.max(0, Math.trunc(Number(b.o) || 0));
        // Codex/Gemini rollouts count the cached portions inside input;
        // CC Switch expects TOTAL input + TOTAL semantics for those apps so
        // its own recomputations agree with the stored cost columns.
        const cacheInclusive = CACHE_INCLUSIVE_APPS.has(appType);
        const inputTokens = cacheInclusive ? inputFresh + cacheRead + cacheCreate : inputFresh;
        const inputTokenSemantics = cacheInclusive ? INPUT_TOKEN_SEMANTICS_TOTAL : INPUT_TOKEN_SEMANTICS_FRESH;
        // v5 cells carry timing SUMS; per-request averages go to
        // latency_ms/first_token_ms, duration_ms keeps the SUM so CC
        // Switch's tok/s derivation (output ÷ duration) is the true
        // weighted average for the day.
        const latSum = cellTimingMs(b.lat);
        const ftSum = cellTimingMs(b.ft);
        const durSum = cellTimingMs(b.dur);
        const latencyMs = latSum != null ? Math.round(latSum / reqs) : null;
        const firstTokenMs = ftSum != null ? Math.round(ftSum / reqs) : null;
        const costs = catalog.calculateCostColumns({
          appType,
          pricingModel: model,
          model,
          inputTokens,
          outputTokens: output,
          cacheReadTokens: cacheRead,
          cacheCreationTokens: cacheCreate,
          cacheCreation1hTokens: cacheCreate1h,
          inputTokenSemantics,
        });
        const row = {
          requestId: `dora_bridge:${deviceKey}:${sanitizeIdSegment(tool, 32)}:${sanitizeIdSegment(model, 80)}:${day}`,
          providerId,
          device,
          appType,
          model,
          requestModel: model,
          pricingModel: model,
          inputTokens,
          outputTokens: output,
          cacheReadTokens: cacheRead,
          cacheCreationTokens: cacheCreate,
          latencyMs,
          firstTokenMs,
          durationMs: durSum,
          statusCode: 200,
          errorMessage: null,
          sessionId: null,
          providerType: DATA_SOURCE,
          isStreaming: 1,
          costMultiplier: "1.0",
          createdAt,
          inputTokenSemantics,
          ...costs,
        };
        row.contentHash = contentHashOf(row);
        rows.push(row);
      }
    }
  }
  return { rows, skippedTools, device };
}

/**
 * v6 request-level rows: one proxy_request_logs row per ORIGINAL request
 * from the summary's 7-day window. Identity is the peer-side stable id
 * (`n:<nativeId>` or `h:<content hash>`) → deterministic request_id, so
 * repeated syncs dedup naturally (INSERT OR IGNORE + hash-guarded UPDATE).
 */
function requestRowsFromSummary(summary, catalog) {
  const requests = Array.isArray(summary && summary.requests) ? summary.requests : [];
  const days = Array.isArray(summary && summary.requestsDays) ? summary.requestsDays : [];
  const requestDays = new Set(days.map((d) => String(d)));
  for (const rq of requests) {
    if (rq && typeof rq === "object" && rq.t) requestDays.add(dayKeyOf(rq.t));
  }
  if (!requests.length) return { rows: [], requestDays, skippedTools: {} };

  const device = String((summary && summary.device) || "peer").slice(0, 48) || "peer";
  const deviceKey = deviceKeyOf(summary);
  const rows = [];
  const skippedTools = {};
  for (const rq of requests) {
    if (!rq || typeof rq !== "object" || !rq.t) continue;
    const tool = String(rq.l || "unknown");
    const appType = APP_TYPE_BY_TOOL[tool];
    if (!appType) {
      skippedTools[tool] = (skippedTools[tool] || 0) + 1;
      continue;
    }
    const toolLabel = toolMeta(tool).label;
    const providerId = `${device}${PROVIDER_LABEL_SEPARATOR}${toolLabel}`.slice(0, 120);
    const model = String(rq.m || "unknown").slice(0, 200) || "unknown";
    const inputFresh = Math.max(0, Math.trunc(Number(rq.iv) || 0));
    const cacheRead = Math.max(0, Math.trunc(Number(rq.cr) || 0));
    const cacheCreate = Math.max(0, Math.trunc(Number(rq.cc) || 0));
    const cacheCreate1h = Math.max(0, Math.trunc(Number(rq.cl) || 0));
    const output = Math.max(0, Math.trunc(Number(rq.o) || 0));
    const cacheInclusive = CACHE_INCLUSIVE_APPS.has(appType);
    const inputTokens = cacheInclusive ? inputFresh + cacheRead + cacheCreate : inputFresh;
    const inputTokenSemantics = cacheInclusive ? INPUT_TOKEN_SEMANTICS_TOTAL : INPUT_TOKEN_SEMANTICS_FRESH;
    const costs = catalog.calculateCostColumns({
      appType,
      pricingModel: model,
      model,
      inputTokens,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheCreationTokens: cacheCreate,
      cacheCreation1hTokens: cacheCreate1h,
      inputTokenSemantics,
    });
    const row = {
      requestId: `dora_bridge:r:${deviceKey}:${sanitizeIdSegment(String(rq.i || ""), 100)}`,
      providerId,
      device,
      appType,
      model,
      requestModel: model,
      pricingModel: model,
      inputTokens,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheCreationTokens: cacheCreate,
      latencyMs: cellTimingMs(rq.la),
      firstTokenMs: cellTimingMs(rq.ft),
      durationMs: cellTimingMs(rq.du),
      statusCode: 200,
      errorMessage: null,
      sessionId: rq.s ? String(rq.s).slice(0, 200) : null,
      providerType: DATA_SOURCE,
      isStreaming: 1,
      costMultiplier: "1.0",
      // created_at is epoch SECONDS (CC Switch convention).
      createdAt: Math.floor((Number(rq.t) || 0) / 1000),
      inputTokenSemantics,
      ...costs,
    };
    row.contentHash = contentHashOf(row);
    rows.push(row);
  }
  return { rows, requestDays, skippedTools, device };
}

/** Day key of an epoch-ms timestamp (local calendar). */
function dayKeyOf(ms) {
  const d = new Date(Number(ms) || 0);
  if (!Number.isFinite(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Local-device rows (opt-in via includeLocal): day×tool×model cells folded
 *  from the store's bucketView, same row shape as peer rows. */
function buildLocalRows(catalog, store) {
  if (!store || typeof store.bucketView !== "function") return [];
  const view = store.bucketView({ tool: "all" });
  if (!view || !view.usageDays) return [];
  const device = os.hostname().slice(0, 48) || "local";
  const rows = [];
  for (const [day, tools] of Object.entries(view.usageDays)) {
    const createdAt = dayNoonSec(day);
    for (const [tool, models] of Object.entries(tools || {})) {
      const appType = APP_TYPE_BY_TOOL[tool];
      if (!appType) continue;
      const toolLabel = toolMeta(tool).label;
      const providerId = `${device}${PROVIDER_LABEL_SEPARATOR}${toolLabel}`.slice(0, 120);
      for (const [model, entry] of Object.entries(models || {})) {
        // Fold rate-key cells (std/peak/off/long) into one aggregate cell.
        let i = 0, o = 0, cr = 0, cc = 0, cl = 0, req = 0, lat = 0, ft = 0, dur = 0;
        let hasLat = false, hasFt = false, hasDur = false;
        for (const rateKey of ["std", "peak", "off", "long"]) {
          const cell = entry[rateKey];
          if (!cell) continue;
          i += cell.i || 0;
          o += cell.o || 0;
          cr += cell.cr || 0;
          cc += cell.cc || 0;
          cl += cell.cl || 0;
          req += cell.req || 0;
          if (cell.lat != null) { lat += cell.lat; hasLat = true; }
          if (cell.ft != null) { ft += cell.ft; hasFt = true; }
          if (cell.dur != null) { dur += cell.dur; hasDur = true; }
        }
        if (i + o + cr + cc <= 0) continue;
        const reqs = Math.max(1, req);
        const cacheInclusive = CACHE_INCLUSIVE_APPS.has(appType);
        const inputTokens = cacheInclusive ? i + cr + cc : i;
        const inputTokenSemantics = cacheInclusive ? INPUT_TOKEN_SEMANTICS_TOTAL : INPUT_TOKEN_SEMANTICS_FRESH;
        const costs = catalog.calculateCostColumns({
          appType,
          pricingModel: model,
          model,
          inputTokens,
          outputTokens: o,
          cacheReadTokens: cr,
          cacheCreationTokens: cc,
          cacheCreation1hTokens: cl,
          inputTokenSemantics,
        });
        const row = {
          requestId: `dora_bridge:local:${sanitizeIdSegment(tool, 32)}:${sanitizeIdSegment(model, 80)}:${day}`,
          providerId,
          device,
          appType,
          model: String(model).slice(0, 200) || "unknown",
          requestModel: String(model).slice(0, 200) || "unknown",
          pricingModel: String(model).slice(0, 200) || "unknown",
          inputTokens,
          outputTokens: o,
          cacheReadTokens: cr,
          cacheCreationTokens: cc,
          latencyMs: hasLat ? Math.round(lat / reqs) : null,
          firstTokenMs: hasFt ? Math.round(ft / reqs) : null,
          durationMs: hasDur ? dur : null,
          statusCode: 200,
          errorMessage: null,
          sessionId: null,
          providerType: DATA_SOURCE,
          isStreaming: 1,
          costMultiplier: "1.0",
          createdAt,
          inputTokenSemantics,
          ...costs,
        };
        row.contentHash = contentHashOf(row);
        rows.push(row);
      }
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Write pass
// ---------------------------------------------------------------------------

function loadPeerSummaries() {
  const dir = remoteCacheDir();
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const peers = [];
  for (const f of files) {
    try {
      const summary = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (summary && typeof summary === "object" && summary.days) peers.push(summary);
    } catch {
      /* a corrupt cache file must not break the pass */
    }
  }
  return peers;
}

/**
 * Run one bridge pass. Returns a result object describing what happened;
 * never throws for expected conditions (disabled, conflict, CC Switch
 * absent) — those surface as { ok: false, skipped/paused, reason }.
 */
function runBridge({ force = false } = {}) {
  const settings = (() => {
    try {
      return require("./settings").loadSettings();
    } catch {
      return null;
    }
  })();
  const cfg = (settings && settings.ccSwitch) || {};
  const status = readStatus();

  if (!cfg.enabled && !force) {
    return { ok: false, skipped: true, reason: "disabled" };
  }

  const dbPath = resolveDbPath(cfg);
  const conflict = detectCcsSshSyncConflict(dbPath);
  status.conflictCheckedAt = conflict.checkedAt;
  if (conflict.conflict) {
    status.pausedByConflict = true;
    status.conflictReason = conflict.reason;
    status.conflictDetail = conflict.detail;
    writeStatus(status);
    return { ok: false, paused: true, reason: conflict.reason, detail: conflict.detail };
  }
  status.pausedByConflict = false;
  status.conflictReason = null;
  status.conflictDetail = null;
  if (conflict.configured) status.ccsSshSyncConfigured = true;
  else delete status.ccsSshSyncConfigured;

  if (!fs.existsSync(dbPath)) {
    status.lastError = `CC Switch database not found at ${dbPath}`;
    writeStatus(status);
    return { ok: false, skipped: true, reason: "cc-switch-db-missing", detail: status.lastError };
  }

  const startedAt = Date.now();
  let target = null;
  let state = null;
  try {
    target = new CcSwitchTarget(dbPath);
    state = new BridgeState();

    // Cross-writer resume (time-level incremental): the other writer's
    // newest created_at per app defines the watermark — requests at/before
    // it are already in CC Switch, so the bridge writes only what comes
    // after, deduplicated. Monotonic in the sidecar: CC Switch's 30-day
    // rollup pruning of remote_sync rows never regresses it. Boundary
    // requests (just after the watermark) get a fingerprint check to absorb
    // the two projects' timestamp-source differences.
    const liveWatermarks = target.remoteSyncWatermarksByApp();
    state.advanceOtherWriterWatermarks(liveWatermarks);
    const watermarks = state.otherWriterWatermarks();
    const wmValues = Object.values(watermarks);
    const minWm = wmValues.length ? Math.min(...wmValues) : 0;
    const boundaryFingerprints = minWm > 0 ? target.remoteSyncFingerprintsSince(minWm - 300) : new Map();

    // Gather candidate rows per device, split into request-level rows (v6
    // window) and day-aggregate rows (everything older). A day is written
    // EITHER way — never both — so CC Switch never double counts.
    const skippedTools = {};
    const deviceLabels = new Set();
    const plans = [];
    let skippedOtherWriter = 0;
    for (const summary of loadPeerSummaries()) {
      const device = String((summary && summary.device) || "peer").slice(0, 48) || "peer";
      const deviceKey = deviceKeyOf(summary);
      deviceLabels.add(device);
      const req = requestRowsFromSummary(summary, target.catalog);
      for (const [t, n] of Object.entries(req.skippedTools || {})) skippedTools[t] = (skippedTools[t] || 0) + n;
      // Days ever covered by requests (ledger) ∪ currently covered.
      const ledgerCovered = state.coveredDays(device);
      const covered = new Set([...ledgerCovered, ...req.requestDays]);
      const { rows: aggRows, skippedTools: st } = rowsFromSummary(summary, target.catalog, covered, watermarks);
      for (const [t, n] of Object.entries(st)) skippedTools[t] = (skippedTools[t] || 0) + n;
      // Time-level resume: request rows at/before the per-app watermark are
      // already covered by the other writer; boundary rows (just after) are
      // fingerprint-checked against its rows.
      const reqRows = [];
      const newlyCoveredDays = [];
      for (const row of req.rows) {
        const wm = Number(watermarks[row.appType]) || 0;
        if (wm > 0 && row.createdAt <= wm) {
          skippedOtherWriter += 1;
          continue;
        }
        if (
          wm > 0 &&
          row.createdAt <= wm + BOUNDARY_CHECK_WINDOW_SEC &&
          fingerprintMatched(
            boundaryFingerprints,
            usageFingerprintKey(row.appType, row.model, row.inputTokens, row.outputTokens, row.cacheReadTokens, row.cacheCreationTokens),
            row.createdAt
          )
        ) {
          skippedOtherWriter += 1;
          continue;
        }
        reqRows.push(row);
        if (req.requestDays.has(dayKeyOf(row.createdAt * 1000))) newlyCoveredDays.push(dayKeyOf(row.createdAt * 1000));
      }
      plans.push({ device, deviceKey, reqRows, aggRows, covered, newlyCoveredDays });
    }
    if (cfg.includeLocal) {
      const store = require("./store");
      if (store.open()) {
        const rows = buildLocalRows(target.catalog, store);
        if (rows.length) {
          const device = os.hostname().slice(0, 48) || "local";
          deviceLabels.add(device);
          let plan = plans.find((p) => p.device === device);
          if (!plan) {
            plan = { device, deviceKey: "local", reqRows: [], aggRows: [], covered: new Set(), newlyCoveredDays: [] };
            plans.push(plan);
          }
          plan.aggRows.push(...rows);
        }
      }
    }
    const allRows = [];
    for (const plan of plans) allRows.push(...plan.reqRows, ...plan.aggRows);

    // Reset reconciliation: the ledger knows rows CC Switch forgot entirely.
    if (state.count() > 0 && allRows.length > 0 && !target.hasAnyBridgeData([...deviceLabels].map((d) => `${d}${PROVIDER_LABEL_SEPARATOR}`))) {
      state.clearAll();
    }

    // Days transitioning INTO the request window: their aggregate rows are
    // superseded — delete them (own namespace only) before writing requests.
    let deletedAgg = 0;
    for (const plan of plans) {
      const ledgerCovered = state.coveredDays(plan.device);
      const freshDays = [...plan.newlyCoveredDays].filter((d) => !ledgerCovered.has(d));
      if (freshDays.length) {
        deletedAgg += target.deleteAggregateRows(plan.deviceKey, freshDays);
      }
    }

    const known = state.knownHashes(allRows.map((r) => r.requestId));
    const toInsert = [];
    const toUpdate = [];
    const written = [];
    const result = {
      unchanged: 0,
      pruned: 0,
      inserted: 0,
      updated: 0,
      requestsWritten: 0,
      aggRowsWritten: 0,
      deletedAggregateRows: deletedAgg,
      skippedOtherWriter,
      watermarks,
    };
    for (const row of allRows) {
      const prevHash = known.get(row.requestId);
      if (prevHash === row.contentHash) {
        result.unchanged += 1;
        continue;
      }
      const exists = target.rowExists(row.requestId);
      if (exists) {
        toUpdate.push(row);
      } else if (prevHash != null) {
        // Ledger knows it, CC Switch doesn't, but other bridge rows exist →
        // this row was archived by CC Switch's 30-day rollup — never resurrect.
        result.pruned += 1;
        continue;
      } else {
        toInsert.push(row);
      }
      written.push(row);
    }

    result.inserted = toInsert.length ? target.insertRows(toInsert) : 0;
    result.updated = toUpdate.length ? target.updateRows(toUpdate) : 0;
    // Crash-safe order: the ledger follows a successful cc-switch commit.
    if (written.length) state.recordWritten(written);
    for (const plan of plans) {
      if (plan.reqRows.length) state.markCoveredDays(plan.device, plan.newlyCoveredDays);
      result.requestsWritten += plan.reqRows.length;
      result.aggRowsWritten += plan.aggRows.length;
    }

    const byDevice = {};
    for (const plan of plans) byDevice[plan.device] = plan.reqRows.length + plan.aggRows.length;
    status.lastRunAt = new Date().toISOString();
    status.lastSuccessAt = status.lastRunAt;
    status.lastError = null;
    status.lastResult = {
      ...result,
      candidates: allRows.length,
      byDevice,
      skippedTools,
      durationMs: Date.now() - startedAt,
      schemaVersion: target.schemaInfo.userVersion,
    };
    writeStatus(status);
    return { ok: true, ...result, byDevice, skippedTools };
  } catch (err) {
    status.lastRunAt = new Date().toISOString();
    status.lastError = String((err && err.message) || err).slice(0, 500);
    writeStatus(status);
    return { ok: false, error: status.lastError };
  } finally {
    if (target) target.close();
    if (state) state.close();
  }
}

/** Current status for the settings page / CLI (fresh conflict check). */
function bridgeStatus() {
  const status = readStatus();
  const settings = (() => {
    try {
      return require("./settings").loadSettings();
    } catch {
      return null;
    }
  })();
  const cfg = (settings && settings.ccSwitch) || {};
  const dbPath = resolveDbPath(cfg);
  const conflict = detectCcsSshSyncConflict(dbPath);
  status.enabled = cfg.enabled === true;
  status.dbPath = dbPath;
  status.dbExists = fs.existsSync(dbPath);
  status.includeLocal = cfg.includeLocal === true;
  status.pausedByConflict = conflict.conflict;
  if (conflict.conflict) {
    status.conflictReason = conflict.reason;
    status.conflictDetail = conflict.detail;
  } else {
    status.conflictReason = null;
    status.conflictDetail = null;
  }
  status.conflictCheckedAt = conflict.checkedAt;
  status.ccsSshSyncConfigured = conflict.configured === true;
  // Cross-writer coexistence: the other writer's rows no longer pause the
  // bridge — its per-app time watermarks define where the bridge resumes.
  status.otherWriterData = conflict.otherWriterData === true;
  try {
    const state = new BridgeState();
    status.watermarks = state.otherWriterWatermarks();
    state.close();
  } catch {
    /* sidecar unavailable — status only */
  }
  if (status.dbExists) {
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const r = db
        .prepare(`SELECT COUNT(*) AS n, MAX(created_at) AS mx FROM proxy_request_logs WHERE data_source = ?`)
        .get(CCS_SOURCE);
      db.close();
      status.remoteSyncRows = Number(r && r.n) || 0;
      const mx = Number(r && r.mx) || 0;
      status.remoteSyncLatest = mx > 0 ? new Date(mx * 1000).toISOString() : null;
    } catch {
      /* status only */
    }
  }
  return status;
}

module.exports = {
  DATA_SOURCE,
  APP_TYPE_BY_TOOL,
  detectCcsSshSyncConflict,
  runBridge,
  bridgeStatus,
  resolveDbPath,
  defaultCcSwitchDbPath,
  rowsFromSummary,
  buildLocalRows,
  BridgeState,
  CcSwitchTarget,
  _setProcessProbeForTest,
};
