"use strict";

const { emptyRecord } = require("./base");
const {
  cursorHome,
  isCursorInstalled,
  readCursorUsageCache,
  wakeCursorRefresh,
  stateDbPath,
} = require("../cursor-usage");

/**
 * Cursor tool adapter.
 *
 * Cursor keeps no token counts locally — usage lives in the account
 * dashboard (api/dashboard/v2/query-daily-usage, see ../cursor-usage.js).
 * Collection is synchronous, so `scan()` never blocks on the network: it
 * returns the persisted daily cells immediately and wakes a background
 * refresh, which the next collect tick picks up.
 *
 * One record per (day, model):
 *   time = local noon of that day (the API only labels UTC days)
 *   inputOther = tokens — the API gives a single total, so there is no
 *                output / cache split and cache-hit rate is meaningless
 *   requests = 0 — the API exposes no request count
 */

const SYNTH_SESSION = "cursor";
const NOTE_KEY = "toolCursorNote";

/** YYYY-MM-DD → local noon epoch ms (avoids DST edges / UTC day shifting). */
function dayMs(day) {
  const [y, m, d] = String(day).split("-").map(Number);
  return new Date(y, m - 1, d, 12, 0, 0, 0).getTime();
}

/** Persisted daily cells → normalized records. */
function recordsFromCells(cells) {
  const out = [];
  for (const cell of cells || []) {
    const tokens = Number(cell.tokens) || 0;
    if (tokens <= 0) continue;
    const time = dayMs(cell.day);
    if (!Number.isFinite(time)) continue;
    const model = String(cell.model || "unknown");
    const rec = emptyRecord("cursor");
    rec.time = time;
    rec.model = model;
    rec.modelDisplay = model;
    rec.modelResolved = model;
    rec.inputOther = tokens;
    rec.costCny = Number(cell.costUsd) || 0;
    rec.costEstimated = false;
    // The API has no request count — never claim one.
    rec.requests = 0;
    rec.session = SYNTH_SESSION;
    rec.sessionHint = { session: SYNTH_SESSION, project: null };
    out.push(rec);
  }
  out.sort((a, b) => b.time - a.time);
  return out;
}

const tool = {
  id: "cursor",
  label: "Cursor",
  /** No source files describe freshness (the credential DB changes on every
   *  Cursor write), so collect must re-enter scan() every tick; the TTL guard
   *  inside cursor-usage.js decides when to hit the network. */
  alwaysScan: true,
  noteKey: NOTE_KEY,

  defaultHome() {
    return cursorHome();
  },

  isAvailable(home) {
    return isCursorInstalled(home);
  },

  sourceFiles() {
    return [];
  },

  scan(home, { cacheFile } = {}) {
    wakeCursorRefresh({ home, cacheFile });
    const cached = readCursorUsageCache(cacheFile);
    const cells = cached ? cached.cells : [];
    const records = recordsFromCells(cells);
    const errors = [];
    if (!cached) {
      errors.push({ file: stateDbPath(home), message: "Cursor usage not fetched yet" });
    } else if (cached.reason) {
      errors.push({ message: `Cursor usage refresh failed: ${cached.reason}` });
    }
    return {
      records,
      events: [],
      meta: {
        filesScanned: 1,
        filesReread: 0,
        linesSeen: cells.length,
        recordCount: records.length,
        home,
        fetchedAt: cached ? cached.fetchedAt : null,
        errors,
      },
    };
  },
};

module.exports = tool;
module.exports.dayMs = dayMs;
module.exports.recordsFromCells = recordsFromCells;
