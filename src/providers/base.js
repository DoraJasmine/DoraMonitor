"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

/**
 * Shared helpers for usage providers.
 *
 * A provider turns one AI coding tool's local data into normalized records:
 * {
 *   tool, time, model, modelDisplay, modelResolved,
 *   inputOther, output, inputCacheRead, inputCacheCreation,
 *   costUsd, costEstimated, priceId, credits,
 *   project, session, sessionHint,
 * }
 * Only metadata (model, time, tokens, paths) is ever read — never prompts,
 * replies, code, or credentials.
 */

const TOOL_META = {
  "kimi-code": { label: "Kimi Code", color: "#22c55e" },
  zcode: { label: "ZCode", color: "#3b82f6" },
  "qoder-cn": { label: "QoderCN", color: "#f59e0b" },
  "qoder-cn-cli": { label: "QoderCN CLI", color: "#eab308" },
};

function toolMeta(id) {
  return TOOL_META[id] || { label: id, color: "#94a3b8" };
}

function expandHome(p) {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  // Windows %VAR% style
  return p.replace(/%([^%]+)%/g, (_, name) => process.env[name] || `%${name}%`);
}

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

function fileStamp(filePath) {
  try {
    const st = fs.statSync(filePath);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

/** True when the file changed (or was not seen) since the given stamp. */
function stampChanged(prev, filePath) {
  if (!prev) return true;
  const cur = fileStamp(filePath);
  if (!cur) return prev.exists !== false;
  return cur.mtimeMs !== prev.mtimeMs || cur.size !== prev.size;
}

/** Open a SQLite database read-only via node:sqlite. Throws on failure. */
function openReadOnly(dbPath) {
  const { DatabaseSync } = require("node:sqlite");
  return new DatabaseSync(dbPath, { readOnly: true });
}

/** Empty record factory so every provider returns the same shape. */
function emptyRecord(tool) {
  return {
    tool,
    time: 0,
    model: "unknown",
    modelDisplay: "unknown",
    modelResolved: null,
    inputOther: 0,
    output: 0,
    inputCacheRead: 0,
    inputCacheCreation: 0,
    costUsd: 0,
    costEstimated: false,
    priceId: null,
    credits: null,
    project: null,
    session: null,
    sessionHint: null,
  };
}

module.exports = {
  TOOL_META,
  toolMeta,
  expandHome,
  n,
  fileStamp,
  stampChanged,
  openReadOnly,
  emptyRecord,
};
