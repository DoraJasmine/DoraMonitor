"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { n, emptyRecord, expandHome, fileStamp } = require("./base");
const { costForUsage } = require("../pricing");
const { loadSettings } = require("../settings");

/**
 * Codex provider — recursively scans ~/.codex/sessions and
 * ~/.codex/archived_sessions for rollout-*.jsonl files
 * (Codex CLI / desktop app rollouts).
 *
 * Per-response token usage lives on `token_usage_record` events:
 *   payload.usage.{input_tokens, cached_input_tokens,
 *                  cache_write_input_tokens, output_tokens}
 * Codex's input_tokens INCLUDES the cached portion, so uncached input is
 * input_tokens - cached_input_tokens. turn_token_usage / thread_token_usage
 * on the same event are cumulative running totals — never counted.
 *
 * Responses are de-duplicated by payload.response_id: the same thread can
 * appear in both sessions/ and archived_sessions/ after archiving.
 *
 * token_usage_record carries no model field; the model (and cwd) come from
 * the turn's `turn_context` event (payload.turn_id -> model/cwd), falling
 * back to the most recent turn_context seen in the file.
 *
 * Cloud quota rides on the same scan: every `event_msg`/`token_count` line
 * carries a `rate_limits` snapshot (primary = 5-hour rolling window,
 * secondary = weekly). The newest event wins, so quota refreshes whenever
 * token usage does.
 *
 * INCREMENTAL CACHE: rollout files are append-only in practice, so parsed
 * records are cached per file keyed on (mtimeMs, size) — a rescan re-reads
 * only files that changed (577 MB of history stays untouched otherwise).
 * The cross-file response_id dedup and the global newest-quota selection
 * still run over the full set on every scan (cheap pass over parsed
 * records). collect.invalidate() → clearCache() drops the caches when
 * pricing settings change.
 */
const provider = {
  id: "codex",
  label: "Codex",

  defaultHome() {
    if (process.env.CODEX_HOME && process.env.CODEX_HOME.trim()) {
      return path.resolve(expandHome(process.env.CODEX_HOME.trim()));
    }
    return path.join(os.homedir(), ".codex");
  },

  isAvailable(home) {
    return fs.existsSync(path.join(home, "sessions"));
  },

  /** Drop all per-file parse caches (used when pricing settings change). */
  clearCache() {
    fileCaches.clear();
  },

  scan(home) {
    const roots = [
      path.join(home, "sessions"),
      path.join(home, "archived_sessions"),
    ];
    const errors = [];

    const settings = (() => {
      try {
        return loadSettings();
      } catch {
        return null;
      }
    })();

    // Roots keep their order (sessions/ wins the response_id dedup against
    // archived copies, as before); files are sorted inside each root for a
    // deterministic first-wins order.
    const orderedFiles = [];
    for (const root of roots) {
      for (const file of listRolloutFiles(root).sort()) orderedFiles.push(file);
    }

    let cache = fileCaches.get(home);
    if (!cache) {
      cache = new Map();
      fileCaches.set(home, cache);
    }

    // Per-file parse (cached), then a cheap post-pass for cross-file state:
    // response_id dedup, global newest quota, sort.
    const parsedFiles = [];
    let filesReread = 0;
    for (const file of orderedFiles) {
      const st = fileStamp(file);
      const stamp = st ? { mtimeMs: st.mtimeMs, size: st.size } : null;
      const cached = cache.get(file);
      if (cached && sameStamp(cached.stamp, stamp)) {
        parsedFiles.push(cached.parsed);
        continue;
      }
      const parsed = parseRolloutFile(file, settings);
      cache.set(file, { stamp, parsed });
      parsedFiles.push(parsed);
      filesReread += 1;
      for (const err of parsed.errors) errors.push(err);
    }
    // Prune cache entries for files that disappeared.
    if (cache.size > orderedFiles.length) {
      const present = new Set(orderedFiles);
      for (const key of [...cache.keys()]) {
        if (!present.has(key)) cache.delete(key);
      }
    }

    const records = [];
    const seenResponses = new Set();
    let bestQuota = null;
    let duplicatesSkipped = 0;
    let linesSeen = 0;
    for (const parsed of parsedFiles) {
      linesSeen += parsed.lines;
      // A full file read always ends at its newest line, so the last
      // fileQuota seen is the freshest; keep the newest across files.
      if (parsed.fileQuota && parsed.fileQuota.windows.length && (!bestQuota || parsed.fileQuota.ts >= bestQuota.ts)) {
        bestQuota = parsed.fileQuota;
      }
      for (const entry of parsed.entries) {
        // The same thread can appear in both sessions/ and archived_sessions/
        // after archiving — dedupe by response_id across files.
        if (entry.key) {
          if (seenResponses.has(entry.key)) {
            duplicatesSkipped += 1;
            continue;
          }
          seenResponses.add(entry.key);
        }
        records.push(entry.rec);
      }
    }
    // newest first for "recent"
    records.sort((a, b) => b.time - a.time);

    return {
      records,
      meta: {
        filesScanned: orderedFiles.length,
        filesReread,
        linesSeen,
        recordCount: records.length,
        duplicatesSkipped,
        home,
        sessionsRoot: path.join(home, "sessions"),
        errors: errors.slice(0, 20),
      },
      quota: quotaPayload(bestQuota),
    };
  },
};

/** home -> Map(file path -> { stamp, parsed }) */
const fileCaches = new Map();

function sameStamp(a, b) {
  if (!a || !b) return false;
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

/**
 * Parse one rollout file: costed token records (pre-dedup, paired with their
 * response_id keys), the file's newest quota snapshot, and line count.
 * Files are append-only in practice, so unchanged files are never re-read.
 */
function parseRolloutFile(file, settings) {
  const parsed = { entries: [], fileQuota: null, lines: 0, errors: [] };
  let text;
  try {
    text = readRolloutText(file);
  } catch (err) {
    parsed.errors.push({ file, message: String(err && err.message ? err.message : err) });
    return parsed;
  }
  const lines = text.split(/\r?\n/);

  // turn_id -> { model, cwd } from turn_context events; also the
  // most recent values as a fallback for records whose turn has no
  // context line in this file.
  const turnInfo = new Map();
  let lastModel = null;
  let lastCwd = null;

  for (const line of lines) {
    if (!line) continue;
    parsed.lines += 1;
    // Fast reject before full parse
    if (
      !line.includes('"token_usage_record"') &&
      !line.includes('"turn_context"') &&
      !line.includes('"rate_limits"')
    ) {
      continue;
    }
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    if (obj.type === "turn_context") {
      const p = obj.payload || {};
      if (p.model) lastModel = String(p.model);
      if (p.cwd) lastCwd = String(p.cwd);
      if (p.turn_id) {
        turnInfo.set(String(p.turn_id), { model: lastModel, cwd: lastCwd });
      }
      continue;
    }

    // Cloud quota snapshot: keep the newest rate_limits in the file.
    if (obj.type === "event_msg" && obj.payload && obj.payload.rate_limits) {
      const ts = Date.parse(obj.timestamp) || 0;
      if (!parsed.fileQuota || ts >= parsed.fileQuota.ts) {
        parsed.fileQuota = { ts, windows: quotaWindows(obj.payload.rate_limits) };
      }
      continue;
    }

    if (obj.type !== "token_usage_record") continue;
    const payload = obj.payload || {};
    const usage = payload.usage;
    if (!usage || typeof usage !== "object") continue;

    const cached = n(usage.cached_input_tokens);
    const inputTotal = n(usage.input_tokens);
    const inputOther = Math.max(0, inputTotal - cached);
    const output = n(usage.output_tokens);
    const cacheCreate = n(usage.cache_write_input_tokens);
    // Skip all-zero placeholders BEFORE dedupe: registering the id first
    // would let a zero-usage placeholder swallow the real record that
    // carries the same response_id.
    if (inputOther + cached + cacheCreate + output <= 0) continue;

    const responseId = String(payload.response_id || "");

    const ti = payload.turn_id ? turnInfo.get(String(payload.turn_id)) : null;
    const model = (ti && ti.model) || lastModel || "unknown";
    const project = (ti && ti.cwd) || lastCwd || null;

    const rec = emptyRecord("codex");
    rec.time = Date.parse(obj.timestamp) || 0;
    rec.model = model;
    rec.modelDisplay = model;
    rec.modelResolved = model;
    rec.inputOther = inputOther;
    rec.output = output;
    rec.inputCacheRead = cached;
    rec.inputCacheCreation = cacheCreate;
    const cost = costForUsage(rec.modelResolved || rec.model, rec, { settings });
    rec.costCny = cost.total;
    rec.costEstimated = cost.estimated;
    rec.priceId = cost.priceId;
    rec.project = project;
    rec.session = String(payload.session_id || payload.thread_id || rolloutBasename(file));
    rec.sessionHint = { session: rec.session, project: rec.project };
    parsed.entries.push({ rec, key: responseId });
  }
  return parsed;
}

/** Map a rate_limits snapshot to the same window shape the Kimi quota emits. */
function quotaWindows(rl) {
  if (!rl || typeof rl !== "object") return [];
  const windows = [];
  const defs = [
    ["primary", "session", "5-hour"],
    ["secondary", "weekly", "Weekly"],
  ];
  for (const [key, kind, label] of defs) {
    const w = rl[key];
    if (!w || typeof w !== "object") continue;
    // n() maps anything non-finite to 0, so it can never signal "absent" —
    // check for a usable number first, otherwise a window that omits
    // used_percent renders as a fabricated 0% bar.
    const rawUsed = Number(w.used_percent);
    if (!Number.isFinite(rawUsed)) continue;
    const used = Math.min(100, Math.max(0, rawUsed));
    const resetsAt = Number(w.resets_at);
    windows.push({
      kind,
      label,
      usedPercent: used,
      resetsAt: Number.isFinite(resetsAt) && resetsAt > 0 ? epochSecondsToIso(resetsAt) : null,
    });
  }
  return windows;
}

/**
 * `resets_at` is documented as epoch SECONDS. Guard against a millisecond
 * value (~1.8e12) which would otherwise render as year +058681.
 */
function epochSecondsToIso(value) {
  const asSeconds = value > 100000000000 ? value / 1000 : value;
  const date = new Date(asSeconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function quotaPayload(best) {
  if (!best || !best.windows.length) {
    return { available: false, reason: "no_data", windows: [], fetchedAt: null };
  }
  return {
    available: true,
    reason: null,
    windows: best.windows,
    fetchedAt: new Date(best.ts).toISOString(),
  };
}

function listRolloutFiles(root) {
  const out = [];
  walk(root, out);
  return out;
}

/**
 * Codex writes rollouts as plain `.jsonl` for recent sessions and compresses
 * older / archived ones to `.jsonl.zst` (zstd) — `archived_sessions/` is
 * entirely compressed in practice, so filtering on ".jsonl" alone silently
 * dropped them. Returns the decompressed text for compressed rollouts and the
 * raw text otherwise; throws so the caller records a per-file error.
 */
function readRolloutText(file) {
  if (file.endsWith(".zst") || file.endsWith(".zstd")) {
    const zlib = require("zlib");
    const buf = fs.readFileSync(file);
    // Each rollout is written as a single zstd frame; fall back to fzstd for
    // multi-frame files (same decoder the dsh provider uses).
    try {
      return zlib.zstdDecompressSync(buf).toString("utf8");
    } catch {
      const { Decompress } = require("fzstd");
      const chunks = [];
      const d = new Decompress((chunk) => chunks.push(chunk));
      d.push(buf, true);
      return Buffer.concat(
        chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))
      ).toString("utf8");
    }
  }
  return fs.readFileSync(file, "utf8");
}

const ROLLOUT_SUFFIXES = [".jsonl.zst", ".jsonl.zstd", ".jsonl"];

function isRolloutFile(name) {
  return ROLLOUT_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/** Strip any rollout suffix to get the session-ish basename. */
function rolloutBasename(file) {
  let name = path.basename(file);
  for (const suffix of ROLLOUT_SUFFIXES) {
    if (name.endsWith(suffix)) return name.slice(0, -suffix.length);
  }
  return name;
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
    } else if (ent.isFile() && isRolloutFile(ent.name)) {
      out.push(full);
    }
  }
}

module.exports = provider;
