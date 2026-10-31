"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

/**
 * Local SQLite row store (node:sqlite) — see
 * docs/usage-insights-improvement-plan.md §1.2.
 *
 * One row per usage request (append-only, replaced per tool on rescan), plus
 * event counters and a one-time import of day-bucket cells for history whose
 * source files no longer exist (deleted/archived sessions).
 *
 * Invariants:
 *   - Token counts are integers; costs are computed at QUERY time from the
 *     current price table (same policy as buckets.js — a price update
 *     retroactively applies to all history with zero invalidation).
 *   - `bucketView()` reproduces the bucket shape so aggregateFromBuckets()
 *     consumes the store unchanged (equivalence guarded by test/store.test.js).
 *   - Legacy import skips any bucket whose source file still exists — those
 *     days come from the fresh scan, so the two sources never double count.
 *
 * Any failure (module missing, DB unreadable) disables the store; callers
 * fall back to the day-bucket path unchanged.
 */

const { DatabaseSync } = tryRequireSqlite();
const { rateKeyFor, priceForCell, RATE_KEYS, cellCostCny } = require("./pricing");
const { dayKey } = require("./aggregate");
const { normalizeWorkspace } = require("./workspaces");
const { validateRecord } = require("./record-schema");
const { loadSettings } = require("./settings");

function tryRequireSqlite() {
  try {
    return require("node:sqlite");
  } catch {
    return {};
  }
}

/**
 * Ordered schema migrations, guarded by PRAGMA user_version. Every future
 * schema change (new columns, indexes, backfills) appends ONE entry here;
 * open() applies pending migrations once, inside a transaction. Never edit
 * an already-shipped migration — always append.
 */
const MIGRATIONS = [
  {
    version: 1,
    name: "initial-schema",
    sql: `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS usage_records (
  id INTEGER PRIMARY KEY,
  tool TEXT NOT NULL,
  time INTEGER NOT NULL,
  day TEXT NOT NULL,
  hour INTEGER NOT NULL,
  device TEXT,
  workspace_key TEXT NOT NULL DEFAULT '__unknown__',
  workspace_name TEXT,
  model TEXT,
  model_display TEXT,
  model_resolved TEXT,
  model_provider TEXT,
  rate_key TEXT NOT NULL DEFAULT 'std',
  i INTEGER NOT NULL DEFAULT 0,
  o INTEGER NOT NULL DEFAULT 0,
  cr INTEGER NOT NULL DEFAULT 0,
  cc INTEGER NOT NULL DEFAULT 0,
  cs INTEGER,
  cl INTEGER,
  req INTEGER NOT NULL DEFAULT 1,
  est_req INTEGER NOT NULL DEFAULT 0,
  credits REAL NOT NULL DEFAULT 0,
  price_id TEXT,
  cost_estimated INTEGER NOT NULL DEFAULT 0,
  session TEXT,
  sig TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rec_tool_day ON usage_records(tool, day);
CREATE INDEX IF NOT EXISTS idx_rec_tool_model ON usage_records(tool, model);
CREATE INDEX IF NOT EXISTS idx_rec_tool_time ON usage_records(tool, time);
CREATE INDEX IF NOT EXISTS idx_rec_ws ON usage_records(workspace_key, day);
CREATE TABLE IF NOT EXISTS event_counts (
  tool TEXT NOT NULL,
  day TEXT NOT NULL,
  name TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tool, day, name)
);
CREATE TABLE IF NOT EXISTS usage_daily_legacy (
  day TEXT NOT NULL,
  tool TEXT NOT NULL,
  model TEXT NOT NULL,
  rate_key TEXT NOT NULL,
  display TEXT,
  pricing_key TEXT,
  i INTEGER NOT NULL DEFAULT 0,
  o INTEGER NOT NULL DEFAULT 0,
  cr INTEGER NOT NULL DEFAULT 0,
  cc INTEGER NOT NULL DEFAULT 0,
  cs INTEGER,
  cl INTEGER,
  req INTEGER NOT NULL DEFAULT 0,
  est_req INTEGER NOT NULL DEFAULT 0,
  credits REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (day, tool, model, rate_key)
);
`,
  },
];

/** Apply pending migrations (idempotent — CREATE IF NOT EXISTS keeps
 *  pre-migration databases created before this mechanism existed). */
function applyMigrations() {
  const row = db.prepare("PRAGMA user_version").get();
  let current = Number(row && row.user_version) || 0;
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    try {
      db.exec("BEGIN");
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec("COMMIT");
      current = migration.version;
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw err;
    }
  }
}

/** Current applied schema version (0 when the store is closed). */
function schemaVersion() {
  if (!db) return 0;
  const row = db.prepare("PRAGMA user_version").get();
  return Number(row && row.user_version) || 0;
}

function defaultDbPath() {
  return path.join(os.homedir(), ".doramonitor", "doramonitor.db");
}

let db = null;
let dbPath = null;

/** Open (or reuse) the store. Returns false when unavailable.
 *  First successful open wins — later calls reuse it (tests pass an
 *  explicit tmpdir path; production resolves DORAMONITOR_DB or the default). */
function open(dbPathOverride) {
  if (!DatabaseSync) return false;
  if (db) return true;
  const p = dbPathOverride || process.env.DORAMONITOR_DB || defaultDbPath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    db = new DatabaseSync(p);
    db.exec("PRAGMA journal_mode = WAL");
    applyMigrations();
    dbPath = p;
    return true;
  } catch (err) {
    console.warn(`[doramonitor] row store unavailable (${p}):`, err && err.message ? err.message : err);
    db = null;
    dbPath = null;
    return false;
  }
}

function isAvailable() {
  return !!db;
}

function close() {
  if (db) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
  db = null;
  dbPath = null;
}

function getMeta(key) {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return row ? row.value : null;
}

function setMeta(key, value) {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(value));
}

/** Cheap per-tool fingerprint so unchanged light tools skip re-ingestion. */
function fingerprintOf(records, events) {
  let sumTime = 0;
  let sumTokens = 0;
  let sumReq = 0;
  for (const r of records || []) {
    sumTime += r.time || 0;
    sumTokens += (r.inputOther || 0) + (r.output || 0) + (r.inputCacheRead || 0) + (r.inputCacheCreation || 0);
    const n = Number(r.requests);
    sumReq += Number.isFinite(n) && n >= 0 ? n : 1;
  }
  let evCount = 0;
  for (const e of events || []) evCount += 1;
  return `${(records || []).length}|${sumTime}|${sumTokens}|${sumReq}|${evCount}`;
}

function recordSig(rec) {
  return crypto
    .createHash("sha1")
    .update(
      [
        rec.tool || "",
        rec.time || 0,
        rec.model || "",
        rec.inputOther || 0,
        rec.output || 0,
        rec.inputCacheRead || 0,
        rec.inputCacheCreation || 0,
        rec.credits || 0,
        rec.session || "",
      ].join("\u0000")
    )
    .digest("hex");
}

/**
 * Replace one tool's rows with its current scan output. No-op when the
 * fingerprint is unchanged (light tools rescan on every collect tick).
 * `home` is the tool data home (needed for kimi wd_* → workDir mapping).
 */
function ingestTool({ tool, home, records, events, force = false }) {
  if (!open()) return { ok: false, skipped: true };
  const fp = fingerprintOf(records, events);
  if (!force && getMeta(`fp2:${tool}`) === fp) return { ok: true, skipped: true };

  const insert = db.prepare(`
    INSERT OR IGNORE INTO usage_records
      (tool, time, day, hour, device, workspace_key, workspace_name, model, model_display,
       model_resolved, model_provider, rate_key, i, o, cr, cc, cs, cl, req, est_req,
       credits, price_id, cost_estimated, session, sig)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertEvent = db.prepare(`
    INSERT INTO event_counts (tool, day, name, count) VALUES (?, ?, ?, ?)
    ON CONFLICT (tool, day, name) DO UPDATE SET count = count + excluded.count
  `);

  try {
    db.exec("BEGIN");
    db.prepare("DELETE FROM usage_records WHERE tool = ?").run(tool);
    let rows = 0;
    let invalid = 0;
    for (const raw of records || []) {
      if (!raw || raw.kind === "event") continue;
      // Normalize then validate at the contract boundary (M3.5 ②): malformed
      // records are skipped and counted, never silently folded.
      const rec = raw.time == null ? { ...raw, time: 0 } : raw;
      const check = validateRecord(rec);
      if (!check.ok) {
        invalid += 1;
        continue;
      }
      const rate = rateKeyFor(rec.modelResolved || rec.model, rec, rec.time);
      const reqs = Number.isFinite(Number(rec.requests)) && Number(rec.requests) >= 0 ? Number(rec.requests) : 1;
      const ws = normalizeWorkspace(tool, rec, home);
      const short = rec.inputCacheCreationShort;
      const long = rec.inputCacheCreationLong;
      insert.run(
        tool,
        rec.time || 0,
        dayKey(rec.time || 0),
        new Date(rec.time || 0).getHours(),
        rec.device || null,
        ws.workspaceKey,
        ws.workspaceName || null,
        rec.model || null,
        rec.modelDisplay || null,
        rec.modelResolved || null,
        rec.modelProvider || null,
        rate.key,
        rec.inputOther || 0,
        rec.output || 0,
        rec.inputCacheRead || 0,
        rec.inputCacheCreation || 0,
        short == null ? null : short,
        long == null ? null : long,
        reqs,
        rate.estimated ? reqs : 0,
        rec.credits || 0,
        rec.priceId || null,
        rec.costEstimated ? 1 : 0,
        rec.session || null,
        recordSig(rec)
      );
      rows += 1;
    }
    db.prepare("DELETE FROM event_counts WHERE tool = ?").run(tool);
    for (const ev of events || []) {
      if (!ev || !ev.eventName) continue;
      insertEvent.run(tool, dayKey(ev.time || 0), ev.eventName, 1);
    }
    setMeta(`fp2:${tool}`, fp);
    db.exec("COMMIT");
    return { ok: true, rows, invalid };
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    return { ok: false, error: String(err && err.message) };
  }
}

/** Cell totals for one grouped row set, priced at query time. */
function priceRows({ fxRate, customPrices }) {
  const priceCache = new Map();
  const priceFor = (model, key) => {
    const k = `${model}\u0000${key}`;
    if (!priceCache.has(k)) priceCache.set(k, priceForCell(model, key, { fxRate, customPrices }));
    return priceCache.get(k);
  };
  return { priceFor, cellCost: cellCostCny };
}

function cellTotals(cell) {
  return {
    requests: cell.req || 0,
    inputOther: cell.i || 0,
    output: cell.o || 0,
    inputCacheRead: cell.cr || 0,
    inputCacheCreation: cell.cc || 0,
    credits: cell.credits || 0,
    costCny: 0,
    totalTokens: (cell.i || 0) + (cell.o || 0) + (cell.cr || 0) + (cell.cc || 0),
  };
}

function addTotals(target, src) {
  target.requests += src.requests;
  target.inputOther += src.inputOther;
  target.output += src.output;
  target.inputCacheRead += src.inputCacheRead;
  target.inputCacheCreation += src.inputCacheCreation;
  target.credits += src.credits;
  target.costCny += src.costCny;
  target.totalTokens += src.totalTokens;
}

function hitRateOf(t) {
  const denom = t.inputOther + t.inputCacheRead + t.inputCacheCreation;
  return denom > 0 ? t.inputCacheRead / denom : 0;
}

/** WHERE fragment for the shared filters. `resolvedColumn` selects which
 *  column the resolved filter matches — "pricing_key" for the legacy table. */
function filterSql({ tool, workspace, model, resolved, startDay, endDay, resolvedColumn = "model_resolved" }) {
  const where = [];
  const params = [];
  if (tool && tool !== "all") {
    where.push("tool = ?");
    params.push(tool);
  }
  if (startDay) {
    where.push("day >= ?");
    params.push(startDay);
  }
  if (endDay) {
    where.push("day <= ?");
    params.push(endDay);
  }
  if (workspace && workspace !== "all") {
    where.push("workspace_key = ?");
    params.push(workspace);
  }
  if (model && model !== "all") {
    where.push("model = ?");
    params.push(model);
  }
  if (resolved && resolved !== "all") {
    where.push(`${resolvedColumn} = ?`);
    params.push(resolved);
  }
  return { where, params };
}

/** Cells grouped per (day, tool, model, rate_key) — the shared aggregate base.
 *  Legacy imported rows are included when no workspace filter is set (they
 *  carry no workspace identity), keeping /api/usage/query totals consistent
 *  with the bucketView path that /api/summary consumes. */
function groupedCells(filters) {
  const { where, params } = filterSql(filters);
  const select = `SELECT day, tool, model, MAX(model_display) AS model_display, MAX(model_resolved) AS model_resolved,
              rate_key, SUM(i) AS i, SUM(o) AS o, SUM(cr) AS cr, SUM(cc) AS cc,
              SUM(cs) AS cs, SUM(cl) AS cl, SUM(req) AS req, SUM(est_req) AS est_req, SUM(credits) AS credits`;
  const group = `GROUP BY day, tool, model, rate_key`;
  const rows = db
    .prepare(`${select} FROM usage_records ${where.length ? "WHERE " + where.join(" AND ") : ""} ${group}`)
    .all(...params);
  const legacyOk = !filters.workspace || filters.workspace === "all";
  if (legacyOk) {
    const legacyFilter = filterSql({ ...filters, resolvedColumn: "pricing_key" });
    const legacyRows = db
      .prepare(
        `SELECT day, tool, model, MAX(display) AS model_display, MAX(pricing_key) AS model_resolved,
              rate_key, SUM(i) AS i, SUM(o) AS o, SUM(cr) AS cr, SUM(cc) AS cc,
              SUM(cs) AS cs, SUM(cl) AS cl, SUM(req) AS req, SUM(est_req) AS est_req, SUM(credits) AS credits
       FROM usage_daily_legacy ${legacyFilter.where.length ? "WHERE " + legacyFilter.where.join(" AND ") : ""} ${group}`
      )
      .all(...legacyFilter.params);
    rows.push(...legacyRows);
  }
  return rows;
}

/**
 * Full aggregate for /api/usage/query — same pricing semantics as
 * aggregateFromBuckets (query-time priceForCell on the resolved key).
 * `singleDay` fills the hourly distribution (FR-11).
 */
function usageQuery({ startDay, endDay = null, tool = "all", workspace = "all", model = "all", resolved = "all", singleDay = null, perRange = false, fxRate, customPrices }) {
  if (!open()) return null;
  const { priceFor, cellCost } = priceRows({ fxRate, customPrices });
  const filters = { tool, workspace, model, resolved, startDay, endDay };

  const totals = { requests: 0, inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0, costCny: 0, credits: 0, totalTokens: 0 };
  const byDay = new Map();
  const byModel = new Map();
  const byWorkspace = new Map();
  const byHour = singleDay ? new Map() : null;

  const accCell = (groupMap, key, cell, price) => {
    if (!groupMap.has(key)) {
      groupMap.set(key, { requests: 0, inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0, costCny: 0, credits: 0, totalTokens: 0 });
    }
    const row = groupMap.get(key);
    const priced = cellTotals(cell);
    priced.costCny = cellCost(cell, price);
    addTotals(row, priced);
    return row;
  };

  for (const cell of groupedCells(filters)) {
    const price = priceFor(cell.model_resolved || cell.model, cell.rate_key);
    addTotals(totals, (() => {
      const t = cellTotals(cell);
      t.costCny = cellCost(cell, price);
      return t;
    })());
    accCell(byDay, cell.day, cell, price);

    const mk = `${cell.tool}\u0000${cell.model}`;
    if (!byModel.has(mk)) {
      byModel.set(mk, {
        model: cell.model,
        modelDisplay: cell.model_display || cell.model,
        modelResolved: cell.model_resolved || cell.model,
        tool: cell.tool,
        priceId: null,
        costEstimated: false,
        estReq: 0,
        credits: 0,
        requests: 0, inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0, costCny: 0, totalTokens: 0,
      });
    }
    const m = byModel.get(mk);
    const priced = cellTotals(cell);
    priced.costCny = cellCost(cell, price);
    addTotals(m, priced);
    m.credits += cell.credits || 0;
    m.estReq += cell.est_req || 0;
    const p = priceFor(cell.model_resolved || cell.model, cell.rate_key);
    if (!m.priceId && p.id) m.priceId = p.id;
    if (p.estimated || (cell.est_req || 0) > 0) m.costEstimated = true;
  }

  // Hourly needs per-hour rows — separate cheap grouped query (single day only).
  let hourly = [];
  if (singleDay) {
    const { where, params } = filterSql({ ...filters, startDay: singleDay, endDay: singleDay });
    const rows = db
      .prepare(
        `SELECT hour, tool, model, MAX(model_resolved) AS model_resolved, rate_key,
                SUM(i) AS i, SUM(o) AS o, SUM(cr) AS cr, SUM(cc) AS cc,
                SUM(cs) AS cs, SUM(cl) AS cl, SUM(req) AS req, SUM(credits) AS credits
         FROM usage_records ${where.length ? "WHERE " + where.join(" AND ") : ""}
         GROUP BY hour, tool, model, rate_key`
      )
      .all(...params);
    const hourMap = new Map();
    for (const cell of rows) {
      const price = priceFor(cell.model_resolved || cell.model, cell.rate_key);
      const t = cellTotals(cell);
      t.costCny = cellCost(cell, price);
      if (!hourMap.has(cell.hour)) {
        hourMap.set(cell.hour, { hour: cell.hour, requests: 0, inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0, costCny: 0, credits: 0, totalTokens: 0 });
      }
      addTotals(hourMap.get(cell.hour), t);
    }
    hourly = [...hourMap.values()].sort((a, b) => a.hour - b.hour);
  }

  // Workspace breakdown (records only — legacy rows carry no workspace).
  if (!workspace || workspace === "all") {
    const wf = { tool, model, resolved, startDay, endDay };
    const { where, params } = filterSql(wf);
    const rows = db
      .prepare(
        `SELECT workspace_key, MAX(workspace_name) AS workspace_name,
                SUM(i) AS i, SUM(o) AS o, SUM(cr) AS cr, SUM(cc) AS cc, SUM(req) AS req, SUM(credits) AS credits
         FROM usage_records ${where.length ? "WHERE " + where.join(" AND ") : ""}
         GROUP BY workspace_key`
      )
      .all(...params);
    for (const row of rows) {
      byWorkspace.set(row.workspace_key, {
        workspaceKey: row.workspace_key,
        workspaceName: row.workspace_name || row.workspace_key,
        requests: row.req || 0,
        totalTokens: (row.i || 0) + (row.o || 0) + (row.cr || 0) + (row.cc || 0),
        inputOther: row.i || 0,
        output: row.o || 0,
        inputCacheRead: row.cr || 0,
        inputCacheCreation: row.cc || 0,
        credits: row.credits || 0,
      });
    }
  }

  const daily = [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, t]) => ({ date, ...t, cacheHitRate: hitRateOf(t) }));
  for (const t of [totals, ...byWorkspace.values()]) {
    t.cacheHitRate = hitRateOf(t);
  }

  // perRange: unfiltered-by-range totals for today/7d/30d/all so the UI can
  // keep its range switcher working while workspace/model filters stay active.
  let perRangeOut = null;
  if (perRange) {
    const nowMs = Date.now();
    const startFor = (days) => (days ? dayKey(nowMs - (days - 1) * 86400_000) : null);
    perRangeOut = {};
    for (const [name, rangeStart] of [
      ["today", dayKey(nowMs)],
      ["7d", startFor(7)],
      ["30d", startFor(30)],
      ["all", null],
    ]) {
      const acc = { requests: 0, inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0, costCny: 0, credits: 0, totalTokens: 0 };
      for (const cell of groupedCells({ tool, workspace, model, resolved, startDay: rangeStart, endDay: null })) {
        const t = cellTotals(cell);
        t.costCny = cellCost(cell, priceFor(cell.model_resolved || cell.model, cell.rate_key));
        addTotals(acc, t);
      }
      acc.cacheHitRate = hitRateOf(acc);
      perRangeOut[name] = acc;
    }
  }

  return {
    range: { startDay, endDay, singleDay },
    tool,
    workspace,
    model,
    totals,
    perRange: perRangeOut,
    daily,
    hourly,
    models: [...byModel.values()].map((m) => ({ ...m, cacheHitRate: hitRateOf(m) })).sort((a, b) => b.totalTokens - a.totalTokens),
    workspaces: [...byWorkspace.values()].sort((a, b) => b.totalTokens - a.totalTokens),
  };
}

/** Paginated per-request rows (FR-11/FR-12 detail lists). */
function recordsPage({ fromMs = 0, toMs = null, tool = "all", workspace = "all", model = "all", resolved = "all", limit = 50, offset = 0 }) {
  if (!open()) return null;
  const where = [];
  const params = [];
  if (tool && tool !== "all") {
    where.push("tool = ?");
    params.push(tool);
  }
  if (fromMs) {
    where.push("time >= ?");
    params.push(fromMs);
  }
  if (toMs) {
    where.push("time < ?");
    params.push(toMs);
  }
  if (workspace && workspace !== "all") {
    where.push("workspace_key = ?");
    params.push(workspace);
  }
  if (model && model !== "all") {
    where.push("model = ?");
    params.push(model);
  }
  if (resolved && resolved !== "all") {
    where.push("model_resolved = ?");
    params.push(resolved);
  }
  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
  const total = db.prepare(`SELECT COUNT(*) AS n FROM usage_records ${whereSql}`).get(...params).n;
  const rows = db
    .prepare(
      `SELECT time, tool, model, model_display, model_resolved, workspace_key, workspace_name,
              i, o, cr, cc, req, credits, cost_estimated, session
       FROM usage_records ${whereSql}
       ORDER BY time DESC LIMIT ? OFFSET ?`
    )
    .all(...params, Math.min(Math.max(1, limit | 0), 500), Math.max(0, offset | 0));
  return {
    rows: rows.map((r) => ({
      time: r.time,
      tool: r.tool,
      model: r.model,
      modelDisplay: r.model_display,
      modelResolved: r.model_resolved,
      workspaceKey: r.workspace_key,
      workspaceName: r.workspace_name,
      inputOther: r.i,
      output: r.o,
      inputCacheRead: r.cr,
      inputCacheCreation: r.cc,
      totalTokens: (r.i || 0) + (r.o || 0) + (r.cr || 0) + (r.cc || 0),
      requests: r.req,
      credits: r.credits,
      costEstimated: !!r.cost_estimated,
      session: r.session,
    })),
    total,
    limit: Math.min(Math.max(1, limit | 0), 500),
    offset: Math.max(0, offset | 0),
  };
}

/** Distinct workspace rows for the filter dropdown. */
function workspaceOptions() {
  if (!open()) return [];
  const rows = db
    .prepare(
      `SELECT workspace_key AS workspaceKey, MAX(workspace_name) AS workspaceName, COUNT(*) AS n
       FROM usage_records GROUP BY workspace_key ORDER BY n DESC`
    )
    .all();
  return rows;
}

// ---------------------------------------------------------------------------
// bucketView adapter — reproduces buckets.js shape from SQL so
// aggregateFromBuckets/mergeBuckets/byToolFromBuckets consume it unchanged.
// ---------------------------------------------------------------------------

/** Build one tool's view (records + legacy) into a single pseudo-bucket. */
function bucketView({ tool = "all" } = {}) {
  if (!open()) return null;
  const usageDays = {};
  const ensure = (day, toolId, model, display, pricingKey) => {
    usageDays[day] ||= {};
    usageDays[day][toolId] ||= {};
    const models = usageDays[day][toolId];
    if (!models[model]) {
      models[model] = { display: display || model, pricingKey: pricingKey || model };
    }
    return models[model];
  };
  const ensureCell = (entry, rateKey) => {
    if (!entry[rateKey]) entry[rateKey] = { i: 0, o: 0, cr: 0, cc: 0, req: 0, estReq: 0, credits: 0 };
    return entry[rateKey];
  };
  const mergeCell = (cell, row) => {
    cell.i += row.i || 0;
    cell.o += row.o || 0;
    cell.cr += row.cr || 0;
    cell.cc += row.cc || 0;
    if (row.cs != null) cell.cs = (cell.cs || 0) + row.cs;
    if (row.cl != null) cell.cl = (cell.cl || 0) + row.cl;
    cell.req += row.req || 0;
    cell.estReq += row.est_req || 0;
    cell.credits += row.credits || 0;
  };

  const where = tool && tool !== "all" ? "WHERE tool = ?" : "";
  const params = tool && tool !== "all" ? [tool] : [];
  const rows = db
    .prepare(
      `SELECT day, tool, model, MAX(model_display) AS model_display, MAX(model_resolved) AS model_resolved,
              rate_key, SUM(i) AS i, SUM(o) AS o, SUM(cr) AS cr, SUM(cc) AS cc,
              SUM(cs) AS cs, SUM(cl) AS cl, SUM(req) AS req, SUM(est_req) AS est_req, SUM(credits) AS credits
       FROM usage_records ${where} GROUP BY day, tool, model, rate_key`
    )
    .all(...params);
  for (const row of rows) {
    const entry = ensure(row.day, row.tool, row.model, row.model_display, row.model_resolved);
    mergeCell(ensureCell(entry, row.rate_key), row);
  }
  const legacyRows = db
    .prepare(
      `SELECT day, tool, model, MAX(display) AS display, MAX(pricing_key) AS pricing_key,
              rate_key, SUM(i) AS i, SUM(o) AS o, SUM(cr) AS cr, SUM(cc) AS cc,
              SUM(cs) AS cs, SUM(cl) AS cl, SUM(req) AS req, SUM(est_req) AS est_req, SUM(credits) AS credits
       FROM usage_daily_legacy ${where} GROUP BY day, tool, model, rate_key`
    )
    .all(...params);
  for (const row of legacyRows) {
    const entry = ensure(row.day, row.tool, row.model, row.display, row.pricing_key);
    mergeCell(ensureCell(entry, row.rate_key), row);
  }

  const eventDays = {};
  const evRows = db
    .prepare(`SELECT day, tool, name, count FROM event_counts ${where}`)
    .all(...params);
  for (const row of evRows) {
    eventDays[row.day] ||= {};
    eventDays[row.day][row.tool] ||= {};
    eventDays[row.day][row.tool][row.name] = (eventDays[row.day][row.tool][row.name] || 0) + row.count;
  }
  return { usageDays, eventDays };
}

// ---------------------------------------------------------------------------
// Legacy bucket import — history whose source files no longer exist.
// ---------------------------------------------------------------------------

/**
 * Import day-bucket cells for buckets whose source file is gone. Sources
 * that still exist are skipped: their history is re-ingested from the fresh
 * scan, so the two sources never double count.
 * entries: [{ toolId, home }] — home resolves bucket.source (relPath).
 */
function importLegacyBuckets(entries) {
  if (!open()) return { ok: false, imported: 0, skippedExisting: 0, missing: 0 };
  const bucketsDir =
    process.env.DORAMONITOR_BUCKETS_DIR || path.join(os.homedir(), ".doramonitor", "buckets");
  const cellSum = new Map();
  let skippedExisting = 0;
  let missing = 0;
  for (const { toolId, home } of entries || []) {
    if (!home) continue;
    const dir = path.join(bucketsDir, toolId.replace(/[^A-Za-z0-9_-]/g, "_"));
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    } catch {
      continue;
    }
    for (const f of files) {
      let bucket;
      try {
        bucket = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      } catch {
        continue;
      }
      if (!bucket || typeof bucket !== "object" || !bucket.usageDays) continue;
      const absSource = bucket.source ? path.join(home, bucket.source) : null;
      if (absSource) {
        try {
          if (fs.existsSync(absSource)) {
            skippedExisting += 1;
            continue;
          }
        } catch {
          /* treat as missing */
        }
      }
      missing += 1;
      for (const [day, tools] of Object.entries(bucket.usageDays || {})) {
        for (const [tool, models] of Object.entries(tools || {})) {
          for (const [model, entry] of Object.entries(models || {})) {
            for (const rateKey of RATE_KEYS) {
              const cell = entry[rateKey];
              if (!cell) continue;
              const key = `${day}|${tool}|${model}|${rateKey}`;
              const cur = cellSum.get(key) || {
                day, tool, model, rate_key: rateKey,
                display: entry.display || model,
                pricing_key: entry.pricingKey || model,
                i: 0, o: 0, cr: 0, cc: 0, cs: null, cl: null, req: 0, est_req: 0, credits: 0,
              };
              cur.i += cell.i || 0;
              cur.o += cell.o || 0;
              cur.cr += cell.cr || 0;
              cur.cc += cell.cc || 0;
              if (cell.cs != null) cur.cs = (cur.cs || 0) + cell.cs;
              if (cell.cl != null) cur.cl = (cur.cl || 0) + cell.cl;
              cur.req += cell.req || 0;
              cur.est_req += cell.estReq || 0;
              cur.credits += cell.credits || 0;
              cellSum.set(key, cur);
            }
          }
        }
      }
    }
  }
  try {
    db.exec("BEGIN");
    db.prepare("DELETE FROM usage_daily_legacy").run();
    const insert = db.prepare(`
      INSERT OR REPLACE INTO usage_daily_legacy
        (day, tool, model, rate_key, display, pricing_key, i, o, cr, cc, cs, cl, req, est_req, credits)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of cellSum.values()) {
      insert.run(row.day, row.tool, row.model, row.rate_key, row.display, row.pricing_key,
        row.i, row.o, row.cr, row.cc, row.cs, row.cl, row.req, row.est_req, row.credits);
    }
    setMeta("legacy_imported_at", String(Date.now()));
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    return { ok: false, error: String(err && err.message) };
  }
  return { ok: true, imported: cellSum.size, skippedExisting, missing };
}

function stats() {
  if (!open()) return null;
  const records = db.prepare("SELECT COUNT(*) AS n FROM usage_records").get().n;
  const legacy = db.prepare("SELECT COUNT(*) AS n FROM usage_daily_legacy").get().n;
  const events = db.prepare("SELECT COUNT(*) AS n FROM event_counts").get().n;
  return { records, legacyCells: legacy, events, dbPath };
}

module.exports = {
  open,
  close,
  isAvailable,
  schemaVersion,
  MIGRATIONS,
  ingestTool,
  bucketView,
  usageQuery,
  recordsPage,
  workspaceOptions,
  importLegacyBuckets,
  stats,
  defaultDbPath,
};
