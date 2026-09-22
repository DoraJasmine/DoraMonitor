"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { n, openReadOnly, emptyRecord, expandHome } = require("./base");
const { costForUsage } = require("../pricing");
const { loadSettings } = require("../settings");

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
const QODER_CN_DB_SUFFIX = path.join("QoderCN", "SharedClientCache", "cache", "db", "local.db");

// Mapping borrowed from token-monitor (Javis603/token-monitor, qoderCnUsage.js).
const MODEL_DISPLAY_NAMES = Object.freeze({
  auto: "Auto",
  dashscope_qmodel: "Qwen3.7-Plus",
  dashscope_qwen3_coder: "Qwen3-Coder-Plus",
  dashscope_qwen_max_latest: "Qwen3-Max",
  dfmodel: "DeepSeek-V4-Flash",
  dmodel: "DeepSeek-V4-Pro",
  efficient: "Efficient",
  gm51model: "GLM-5.2",
  gmodel: "GLM-5",
  kmodel: "Kimi-K2.7-Code",
  lite: "Lite",
  mmodel: "MiniMax-M3",
  performance: "Performance",
  q35model: "Qwen3.5-Plus",
  q35model_preview: "Qwen3.8-Max-Preview",
  q36fmodel: "Qwen3.6-Flash",
  qmodel: "Qwen3.7-Plus",
  qmodel_latest: "Qwen3.7-Max",
  qmodel_preview: "Qwen3.8-Max-Preview",
  ultimate: "Ultimate",
});

// Routing tiers are selectors, not real models; keep them as-is so the user
// sees what the app actually billed.
function displayName(modelKey) {
  const key = String(modelKey || "").trim();
  return MODEL_DISPLAY_NAMES[key] || key || "unknown";
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
  rec.model = modelKey;
  rec.modelDisplay = displayName(modelKey);
  rec.modelResolved = modelKey;
  rec.inputOther = Math.max(0, promptTokens - cached);
  rec.inputCacheRead = cached;
  rec.output = n(info.completion_tokens);
  rec.session = row.session_id ? String(row.session_id) : null;
  const project = String(row.project_name || "").trim();
  rec.project = project === "." ? null : project || null;
  rec.sessionHint = { session: rec.session, project: rec.project };
  const cost = costForUsage(rec.model, {
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
