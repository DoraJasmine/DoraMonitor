"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { n, openReadOnly, emptyRecord, expandHome } = require("./base");
const { costForUsage } = require("../pricing");
const { loadSettings } = require("../settings");
const { resolveModelIdentity } = require("../model-identity");

/**
 * QoderCN IDE provider — reads chat_message token_info from
 * ~/.config/QoderCN/SharedClientCache/cache/db/local.db (SQLite, read-only).
 *
 * token_info JSON: { prompt_tokens, completion_tokens, cached_tokens, ... }
 * prompt_tokens already includes cached_tokens (OpenAI convention), so the
 * non-cache input is prompt_tokens - cached_tokens.
 *
 * QoderCN stores internal model codes (model_info.model_key). Official display
 * names come from the app's i18n keys; codes change between releases, so
 * unmapped codes pass through unchanged instead of failing.
 */
// Display names live in src/model-identity.js so every provider (and dsh,
// which records the same routing codes) resolves them identically.
function displayName(modelKey) {
  return resolveModelIdentity(modelKey).modelDisplay;
}

const SQL_WITH_PROJECT = `
SELECT cm.session_id, cm.token_info, cm.model_info, cm.gmt_create,
  (SELECT cs.project_name FROM chat_session cs WHERE cs.session_id = cm.session_id LIMIT 1) AS project_name
FROM chat_message cm
WHERE cm.role = 'assistant'
  AND cm.token_info IS NOT NULL
  AND trim(cm.token_info) NOT IN ('', '{}')
ORDER BY cm.gmt_create, cm.rowid
`;

const SQL_NO_PROJECT = `
SELECT cm.session_id, cm.token_info, cm.model_info, cm.gmt_create
FROM chat_message cm
WHERE cm.role = 'assistant'
  AND cm.token_info IS NOT NULL
  AND trim(cm.token_info) NOT IN ('', '{}')
ORDER BY cm.gmt_create, cm.rowid
`;

function parseJsonSafe(text) {
  if (!text || typeof text !== "string") return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

// Timestamps arrive as ms epoch numbers in current builds; stay defensive
// about text dates and second-precision values.
function toMs(gmtCreate) {
  if (typeof gmtCreate === "number" && Number.isFinite(gmtCreate)) {
    return gmtCreate > 0 && gmtCreate < 100000000000 ? gmtCreate * 1000 : gmtCreate;
  }
  const text = String(gmtCreate || "").trim();
  if (!text) return 0;
  const asNum = Number(text);
  if (Number.isFinite(asNum) && asNum > 0) {
    return asNum < 100000000000 ? asNum * 1000 : asNum;
  }
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function rowToRecord(row, settings) {
  const rec = emptyRecord("qoder-cn");
  const info = parseJsonSafe(row.token_info);
  if (!info) return null;

  const promptTokens = n(info.prompt_tokens);
  const cached = Math.min(n(info.cached_tokens), promptTokens);
  rec.time = toMs(row.gmt_create);
  const modelInfo = parseJsonSafe(row.model_info);
  const modelKey = String((modelInfo && modelInfo.model_key) || "unknown");
  const identity = resolveModelIdentity(modelKey);
  rec.model = modelKey;
  rec.modelDisplay = identity.modelDisplay;
  rec.modelResolved = identity.pricingKey || modelKey;
  rec.inputOther = Math.max(0, promptTokens - cached);
  rec.inputCacheRead = cached;
  rec.output = n(info.completion_tokens);
  // Placeholder rows (empty or unrelated token_info) must not inflate the
  // request count; every other provider drops all-zero records too.
  if (rec.inputOther + rec.inputCacheRead + rec.inputCacheCreation + rec.output <= 0) {
    return null;
  }
  rec.session = row.session_id ? String(row.session_id) : null;
  const project = String(row.project_name || "").trim();
  rec.project = project === "." ? null : project || null;
  rec.sessionHint = { session: rec.session, project: rec.project };
  const cost = costForUsage(rec.modelResolved || rec.model, {
    time: rec.time,
    inputOther: rec.inputOther,
    output: rec.output,
    inputCacheRead: rec.inputCacheRead,
    inputCacheCreation: rec.inputCacheCreation,
  }, { settings });
  rec.costCny = cost.total;
  rec.costEstimated = cost.estimated;
  rec.priceId = cost.priceId;
  return rec;
}

const provider = {
  id: "qoder-cn",
  label: "QoderCN",

  defaultHome() {
    if (process.env.QODER_CN_CONFIG_HOME && process.env.QODER_CN_CONFIG_HOME.trim()) {
      return path.resolve(
        expandHome(process.env.QODER_CN_CONFIG_HOME.trim())
      );
    }
    // Linux: ~/.config/QoderCN; Windows/macOS handled via platform app-data.
    const platform = process.platform;
    if (platform === "win32" && process.env.APPDATA) {
      return path.join(process.env.APPDATA, "QoderCN");
    }
    if (platform === "darwin") {
      return path.join(os.homedir(), "Library", "Application Support", "QoderCN");
    }
    return path.join(os.homedir(), ".config", "QoderCN");
  },

  isAvailable(home) {
    return fs.existsSync(path.join(home, "SharedClientCache", "cache", "db", "local.db"));
  },

  scan(home) {
    const dbPath = path.join(home, "SharedClientCache", "cache", "db", "local.db");
    const records = [];
    const errors = [];
    let rowCount = 0;
    let hasProjectTable = false;

    try {
      const db = openReadOnly(dbPath);
      try {
        // Probe chat_session.project_name once per scan; older builds lack it.
        try {
          const probe = db
            .prepare(
              `SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_session'
               AND EXISTS (SELECT 1 FROM pragma_table_info('chat_session') WHERE name='project_name') LIMIT 1`
            )
            .get();
          hasProjectTable = !!probe;
        } catch {
          hasProjectTable = false;
        }

        const settings = (() => {
          try {
            return loadSettings();
          } catch {
            return null;
          }
        })();
        const rows = db.prepare(hasProjectTable ? SQL_WITH_PROJECT : SQL_NO_PROJECT).all();
        rowCount = rows.length;
        for (const row of rows) {
          const rec = rowToRecord(row, settings);
          if (rec) records.push(rec);
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
