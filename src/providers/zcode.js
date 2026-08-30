"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { n, openReadOnly, emptyRecord, expandHome } = require("./base");
const { costForUsage } = require("../pricing");
const { loadSettings } = require("../settings");

/**
 * ZCode provider — reads model_usage from ~/.zcode/cli/db/db.sqlite
 * (SQLite, opened read-only; WAL databases are safe to read concurrently).
 *
 * Each row is one model request with full token accounting and timestamps.
 */
const ZCODE_DB = path.join(".zcode", "cli", "db", "db.sqlite");

const SQL_ALL = `
SELECT model_id, session_id, input_tokens, output_tokens, reasoning_tokens,
       cache_creation_input_tokens, cache_read_input_tokens,
       computed_total_tokens, started_at, status
FROM model_usage
WHERE started_at < 20000000000000
ORDER BY started_at DESC
`;

// Rows without a finished status still carry usage; count them like
// kimicode-dashboard counts in-flight kimi turns — a request happened.
function providerRowToRecord(row, settings) {
  const rec = emptyRecord("zcode");
  const startedMs = n(row.started_at);
  // zcode stores ms epoch already; guard against second-precision rows.
  rec.time = startedMs > 0 && startedMs < 100000000000 ? startedMs * 1000 : startedMs;
  rec.model = String(row.model_id || "unknown");
  rec.modelDisplay = rec.model;
  rec.modelResolved = rec.model;
  // input_tokens is the TOTAL prompt input: computed_total_tokens equals
  // input_tokens + output_tokens on every local row, and cache_read is a
  // component inside it (OpenAI-style prompt_tokens convention). Subtract
  // the cache components so tokens don't double count and the cache hit
  // rate reflects reality (~97% for GLM plans, not ~48%).
  const totalInput = n(row.input_tokens);
  const cacheRead = Math.min(n(row.cache_read_input_tokens), totalInput);
  const cacheCreate = Math.min(n(row.cache_creation_input_tokens), totalInput - cacheRead);
  rec.inputCacheRead = cacheRead;
  rec.inputCacheCreation = cacheCreate;
  rec.inputOther = Math.max(0, totalInput - cacheRead - cacheCreate);
  rec.output = n(row.output_tokens) + n(row.reasoning_tokens);
  rec.session = row.session_id ? String(row.session_id) : null;
  rec.sessionHint = { session: rec.session };
  const cost = costForUsage(rec.model, {
    inputOther: rec.inputOther,
    output: rec.output,
    inputCacheRead: rec.inputCacheRead,
    inputCacheCreation: rec.inputCacheCreation,
  }, { settings });
  rec.costUsd = cost.total;
  rec.costEstimated = cost.estimated;
  rec.priceId = cost.priceId;
  return rec;
}

const provider = {
  id: "zcode",
  label: "ZCode",

  defaultHome() {
    if (process.env.ZCODE_HOME && process.env.ZCODE_HOME.trim()) {
      return path.resolve(
        expandHome(process.env.ZCODE_HOME.trim())
      );
    }
    return path.join(os.homedir(), ".zcode");
  },

  isAvailable(home) {
    return fs.existsSync(path.join(home, "cli", "db", "db.sqlite"));
  },

  scan(home) {
    const dbPath = path.join(home, "cli", "db", "db.sqlite");
    const records = [];
    const errors = [];
    let rowCount = 0;

    const settings = (() => {
      try {
        return loadSettings();
      } catch {
        return null;
      }
    })();
    try {
      const db = openReadOnly(dbPath);
      try {
        const rows = db.prepare(SQL_ALL).all();
        rowCount = rows.length;
        for (const row of rows) {
          records.push(providerRowToRecord(row, settings));
        }
      } finally {
        db.close();
      }
    } catch (err) {
      errors.push({ file: dbPath, message: String(err && err.message ? err.message : err) });
    }

    records.sort((a, b) => b.time - a.time);

    return {
      records,
      meta: {
        filesScanned: 1,
        linesSeen: rowCount,
        recordCount: records.length,
        home,
        dbPath,
        errors: errors.slice(0, 20),
      },
    };
  },
};

module.exports = provider;
