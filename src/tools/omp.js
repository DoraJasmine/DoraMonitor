"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { n, emptyRecord, expandHome } = require("./base");
const { scanFilesWithBuckets } = require("./file-scan");
const { bucketFromRecords } = require("../buckets");
const { costForUsage } = require("../pricing");
const { loadSettings } = require("../settings");
const { resolveModelIdentity } = require("../model-identity");

/**
 * omp tool adapter — scans Oh My Pi (https://omp.sh, fork of Pi) session JSONL:
 *   ~/.omp/agent/sessions/<encoded-cwd>/<ts>_<uuidv7>.jsonl
 *
 * Layout facts (from @oh-my-pi/pi-coding-agent src/session/*):
 * - Line 1 is a fixed-width 256-byte title slot ({type:"title",...,pad}) —
 *   still valid JSON, just not a header; the session header
 *   ({type:"session",version:3,id,timestamp,cwd}) follows it.
 * - Token usage lives on:
 *     type:"message" + message.role==="assistant" → message.usage
 *     type:"model_usage" (off-transcript calls, e.g. title generation)
 *   with usage {input, output, cacheRead, cacheWrite, totalTokens, cost}.
 *   input EXCLUDES the cached portions, matching costForUsage's inputOther.
 * - Assistant messages also carry provider/model/timestamp(epoch ms).
 * - /fork copies the whole history (same entry ids AND timestamps) into a
 *   new file, so records are de-duplicated globally by id+timestamp
 *   (entry ids are short hex — id alone could collide across sessions).
 * - task toolResults carry aggregated subagent usage in details.usage; we
 *   skip them because subagent sessions are persisted as their own .jsonl
 *   files under the parent's artifact dir (sessions/<bucket>/<file-base>/),
 *   which the recursive walk picks up — counting both would double count.
 *
 * Home resolution: PI_CODING_AGENT_DIR wins; otherwise the first existing
 * of ~/<PI_CONFIG_DIR or ".omp">/agent and ~/.pi/agent (pre-rename installs
 * and upstream Pi). On Linux/macOS, sessions may live under
 * $XDG_DATA_HOME/omp/sessions instead of <agent>/sessions.
 *
 * No quota part — omp exposes no local quota data.
 */

/** home -> Map(file path -> { stamp, parsed, bucket, racy }) */
const fileCaches = new Map();

/** Directory holding the session buckets for a resolved agent home. */
function sessionsRoot(home) {
  const primary = path.join(home, "sessions");
  if (fs.existsSync(primary)) return primary;
  // XDG-migrated installs keep config in <agent> but data under XDG_DATA_HOME.
  const xdg = process.env.XDG_DATA_HOME && process.env.XDG_DATA_HOME.trim();
  if (xdg) {
    const alt = path.join(path.resolve(expandHome(xdg)), "omp", "sessions");
    if (fs.existsSync(alt)) return alt;
  }
  return primary;
}

const tool = {
  id: "omp",
  label: "Oh My Pi",

  defaultHome() {
    if (process.env.PI_CODING_AGENT_DIR && process.env.PI_CODING_AGENT_DIR.trim()) {
      return path.resolve(expandHome(process.env.PI_CODING_AGENT_DIR.trim()));
    }
    const configDir =
      (process.env.PI_CONFIG_DIR && process.env.PI_CONFIG_DIR.trim()) || ".omp";
    const primary = path.join(os.homedir(), configDir, "agent");
    if (fs.existsSync(sessionsRoot(primary))) return primary;
    // Installs from before the .pi -> .omp rename (and upstream Pi itself).
    const legacy = path.join(os.homedir(), ".pi", "agent");
    if (fs.existsSync(sessionsRoot(legacy))) return legacy;
    return primary;
  },

  isAvailable(home) {
    return fs.existsSync(sessionsRoot(home));
  },

  sessionsRoot,

  /** Drop all per-file caches (used when pricing settings change). */
  clearCache() {
    fileCaches.clear();
  },

  scan(home, opts = {}) {
    const root = sessionsRoot(home);

    const settings = (() => {
      try {
        return loadSettings();
      } catch {
        return null;
      }
    })();

    let cache = fileCaches.get(home);
    if (!cache) {
      cache = new Map();
      fileCaches.set(home, cache);
    }

    const out = scanFilesWithBuckets({
      id: tool.id,
      home,
      files: listTranscriptFiles(root),
      cacheMap: cache,
      recordSince: opts.recordSince,
      settings,
      parseFile: (file) => parseSessionFile(file, settings),
      signatureOf: (rec) => rec._dedupKey || "",
      foldBucket: (contributed, parsed, relPath, stamp, sigs) => {
        const bucket = bucketFromRecords(contributed, [], relPath, stamp, sigs);
        bucket.lines = parsed.lines;
        return bucket;
      },
    });

    return {
      records: out.records,
      events: [],
      buckets: out.buckets,
      meta: {
        ...out.meta,
        linesSeen: out.buckets.reduce((sum, b) => sum + (b.bucket.lines || 0), 0),
        home,
        sessionsRoot: root,
        errors: out.errors.slice(0, 20),
      },
    };
  },
};

/**
 * Parse one session JSONL file into costed records (pre-dedup,
 * _dedupKey = entry.id + entry.timestamp). Only files whose header line is
 * {type:"session"} count as sessions — the recursive walk also crosses
 * artifact dirs, which can hold arbitrary .jsonl; those have no such header
 * and yield zero records.
 */
function parseSessionFile(file, settings) {
  const parsed = { records: [], events: [], lines: 0, errors: [] };
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    parsed.errors.push({ file, message: String(err && err.message ? err.message : err) });
    return parsed;
  }

  let sessionId = path.basename(file).replace(/\.jsonl$/i, "");
  let cwd = null;
  let isSession = false;

  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;
    parsed.lines += 1;
    // Fast reject before full parse: only usage-bearing entries and the
    // session header matter. The title slot ({type:"title"}) matches
    // neither token and is skipped here.
    if (!line.includes('"usage"') && !line.includes('"session"')) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type === "session") {
      isSession = true;
      if (obj.id) sessionId = String(obj.id);
      if (typeof obj.cwd === "string" && obj.cwd) cwd = obj.cwd;
      continue;
    }
    if (!isSession) continue; // no header seen yet — not a session file

    let usage = null;
    let rawModel = "unknown";
    let modelProvider = null;
    let time = NaN;

    if (obj.type === "message" && obj.message && obj.message.role === "assistant") {
      usage = obj.message.usage;
      rawModel = String(obj.message.model || "unknown");
      modelProvider = obj.message.provider ? String(obj.message.provider) : null;
      time = n(obj.message.timestamp) || Date.parse(obj.timestamp);
    } else if (obj.type === "model_usage") {
      usage = obj.usage;
      rawModel = String(obj.model || "unknown");
      modelProvider = obj.provider ? String(obj.provider) : null;
      time = Date.parse(obj.timestamp);
    } else {
      // toolResult entries (incl. aggregated task/subagent usage) are
      // skipped: subagents persist their own session files, which the walk
      // picks up directly.
      continue;
    }
    if (!usage || typeof usage !== "object") continue;

    const inputOther = n(usage.input);
    const cacheRead = n(usage.cacheRead);
    const cacheCreate = n(usage.cacheWrite);
    const output = n(usage.output);
    // Skip all-zero placeholders BEFORE dedupe (same bug class as
    // codex/claude-code: a placeholder must not swallow the real entry).
    if (inputOther + cacheRead + cacheCreate + output <= 0) continue;

    const rec = emptyRecord("omp");
    rec.time = Number.isFinite(time) ? time : 0;
    const identity = resolveModelIdentity(rawModel, { provider: modelProvider });
    rec.model = rawModel;
    rec.modelDisplay = identity.modelDisplay;
    rec.modelResolved = identity.pricingKey || rawModel;
    rec.modelProvider = identity.provider;
    rec.inputOther = inputOther;
    rec.output = output;
    rec.inputCacheRead = cacheRead;
    rec.inputCacheCreation = cacheCreate;
    const cost = costForUsage(rec.modelResolved || rec.model, rec, { settings });
    rec.costCny = cost.total;
    rec.costEstimated = cost.estimated;
    rec.priceId = cost.priceId;
    rec.project = cwd;
    rec.session = sessionId;
    rec.sessionHint = { session: rec.session, project: rec.project };
    // fork copies keep BOTH id and timestamp; unrelated sessions could
    // collide on the short-hex id alone, so the pair is the dedup key.
    rec._dedupKey = `${obj.id || ""}|${obj.timestamp || ""}`;
    parsed.records.push(rec);
  }
  return parsed;
}

function listTranscriptFiles(root) {
  const out = [];
  walk(root, out);
  return out;
}

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "node_modules") continue;
      walk(full, out);
    } else if (ent.isFile() && ent.name.endsWith(".jsonl")) {
      out.push(full);
    }
  }
}

module.exports = tool;
