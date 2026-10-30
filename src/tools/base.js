"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

/**
 * Shared helpers for usage tools.
 *
 * A tool adapter turns one AI coding tool's local data into normalized records:
 * {
 *   tool, time, model, modelDisplay, modelResolved,
 *   inputOther, output, inputCacheRead, inputCacheCreation,
 *   costCny, costEstimated, priceId, credits,
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
  codex: { label: "Codex", color: "#10a37f" },
  "claude-code": { label: "Claude Code", color: "#d97757" },
  dsh: { label: "dsh", color: "#4D6BFE" },
  gemini: { label: "Gemini CLI", color: "#1a73e8" },
  omp: { label: "Oh My Pi", color: "#d946ef" },
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

/** Open a SQLite database read-only.
 *
 * Prefers node:sqlite (Node 22.5+). On older Node, falls back to the
 * `sqlite3` CLI in read-only JSON mode; the CLI adapter exposes just
 * prepare().all() which is all providers need.
 */
let _sqliteMode = null; // "builtin" | "cli" | null
function sqliteMode() {
  if (_sqliteMode) return _sqliteMode;
  try {
    require("node:sqlite");
    _sqliteMode = "builtin";
  } catch {
    _sqliteMode = "cli";
  }
  return _sqliteMode;
}

function openReadOnly(dbPath) {
  if (sqliteMode() === "builtin") {
    const { DatabaseSync } = require("node:sqlite");
    return new DatabaseSync(dbPath, { readOnly: true });
  }
  return openCliDatabase(dbPath);
}

/** sqlite3-CLI-backed minimal DatabaseSync.prepare().all() shim. */
function openCliDatabase(dbPath) {
  const { execFileSync } = require("child_process");
  const whichOptional = require("../which-optional");
  const bin = whichOptional("sqlite3");
  if (!bin) {
    throw new Error(
      "No SQLite backend: need Node >= 22.5 (node:sqlite) or the sqlite3 CLI in PATH"
    );
  }
  const uri = `file:${dbPath}?mode=ro`;
  return {
    prepare(sql) {
      return {
        all(params = []) {
          // Bind params as sqlite3 dot-command literals; no shell involved
          // (execFileSync passes args directly). Empty params omit the
          // .param command entirely (older sqlite3 rejects `[]`).
          const args = [uri, "-readonly", "-json"];
          if (params.length) {
            args.push(".param", "json", JSON.stringify(params));
          }
          args.push(sql);
          const out = execFileSync(bin, args, {
            encoding: "utf8",
            timeout: 30_000,
            maxBuffer: 256 * 1024 * 1024,
          });
          const text = out.trim();
          if (!text) return [];
          try {
            return JSON.parse(text);
          } catch {
            throw new Error(`sqlite3 output parse failed: ${text.slice(0, 200)}`);
          }
        },
        get(params = []) {
          return this.all(params)[0] ?? null;
        },
      };
    },
    close() {},
  };
}

/** Empty record factory so every provider returns the same shape. */
function emptyRecord(tool) {
  return {
    tool,
    time: 0,
    /** Device attribution: local scans are always "local"; only sync.js
     *  synthesizes records for peer devices. Set here so the API layer never
     *  needs to shallow-copy the whole record set on every request. */
    device: "local",
    model: "unknown",
    modelDisplay: "unknown",
    modelResolved: null,
    /** Upstream provider that served the request, when the tool records one
     *  (dsh names its plugin, e.g. "qodercn"). Null everywhere else. */
    modelProvider: null,
    inputOther: 0,
    output: 0,
    inputCacheRead: 0,
    inputCacheCreation: 0,
    costCny: 0,
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
