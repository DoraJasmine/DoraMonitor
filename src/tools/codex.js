"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { n, emptyRecord, expandHome } = require("./base");
const { scanFilesWithBuckets } = require("./file-scan");
const { bucketFromRecords } = require("../buckets");
const { costForUsage } = require("../pricing");
const { loadSettings } = require("../settings");
const { readCachedCodexQuota, codexAccountKey } = require("../codex-quota");

/**
 * Codex tool adapter — recursively scans ~/.codex/sessions and
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
 * Responses are de-duplicated by payload.response_id (stored on the record
 * as _dedupKey): the same thread can appear in both sessions/ and
 * archived_sessions/ after archiving. Dedup and per-file day-bucket folding
 * run inside the shared file-scan skeleton (oldest-mtime first).
 *
 * token_usage_record carries no model field; the model (and cwd) come from
 * the turn's `turn_context` event (payload.turn_id -> model/cwd), falling
 * back to the most recent turn_context seen in the file.
 *
 * Cloud quota rides on the same scan: every `event_msg`/`token_count` line
 * carries a `rate_limits` snapshot (primary = 5-hour rolling window,
 * secondary = weekly). The scan merges that with the actively polled
 * wham/usage snapshot cached by src/codex-quota.js, so quota also refreshes
 * when GPT usage happens outside the Codex CLI (omp, IDEs, …).
 */

/** home -> Map(file path -> { stamp, parsed, bucket, racy }) */
const fileCaches = new Map();

const tool = {
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

  /** Drop all per-file caches (used when pricing settings change). */
  clearCache() {
    fileCaches.clear();
  },

  scan(home, opts = {}) {
    const roots = [
      path.join(home, "sessions"),
      path.join(home, "archived_sessions"),
    ];

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

    // Per-file quota snapshots persist inside each file's day-bucket, so a
    // cold start that reuses stored buckets still sees the newest
    // rate_limits without re-reading any rollout file.
    const quotaByFile = new Map();
    const quotaSamples = [];
    const accountKey = codexAccountKey(home);

    const files = [];
    for (const root of roots) {
      for (const file of listRolloutFiles(root)) files.push(file);
    }

    const out = scanFilesWithBuckets({
      id: tool.id,
      home,
      files,
      cacheMap: cache,
      recordSince: opts.recordSince,
      settings,
      parseFile: (file) => {
        const parsed = parseRolloutFile(file, settings, accountKey);
        if (parsed.fileQuota) quotaByFile.set(path.relative(home, file), parsed.fileQuota);
        quotaSamples.push(...parsed.quotaSamples);
        return {
          records: parsed.entries.map((e) => {
            e.rec._dedupKey = e.key;
            return e.rec;
          }),
          events: [],
          lines: parsed.lines,
          errors: parsed.errors,
        };
      },
      signatureOf: (rec) => rec._dedupKey || "",
      foldBucket: (contributed, parsed, relPath, stamp, sigs) => {
        const bucket = bucketFromRecords(contributed, [], relPath, stamp, sigs);
        bucket.lines = parsed.lines;
        bucket.quota = quotaByFile.get(relPath) || null;
        return bucket;
      },
    });

    let bestQuota = null;
    for (const { bucket } of out.buckets) {
      const q = bucket.quota;
      if (q && q.windows && q.windows.length && (!bestQuota || q.ts >= bestQuota.ts)) {
        bestQuota = q;
      }
    }

    // Newest of rollout-derived quota and the actively polled wham/usage
    // snapshot (src/codex-quota.js) — the latter keeps quota fresh when GPT
    // usage happens in other clients (omp, IDEs) that write no rollouts.
    let quota = quotaPayload(bestQuota);
    const polled = home === tool.defaultHome() ? readCachedCodexQuota() : null;
    if (
      polled &&
      (Date.parse(polled.fetchedAt || "") || 0) > (Date.parse(quota.fetchedAt || "") || 0)
    ) {
      quota = polled;
    }

    return {
      records: out.records,
      events: [],
      buckets: out.buckets,
      meta: {
        ...out.meta,
        linesSeen: out.buckets.reduce((sum, b) => sum + (b.bucket.lines || 0), 0),
        home,
        sessionsRoot: path.join(home, "sessions"),
        errors: out.errors.slice(0, 20),
      },
      quota,
      quotaSamples,
    };
  },

  backfillQuotaSamples(home) {
    const accountKey = codexAccountKey(home);
    const files = [];
    for (const root of [path.join(home, "sessions"), path.join(home, "archived_sessions")]) {
      for (const file of listRolloutFiles(root)) files.push(file);
    }
    const samples = [];
    for (const file of files) samples.push(...parseRolloutFile(file, null, accountKey).quotaSamples);
    return samples;
  },
};

/**
 * Parse one rollout file: costed token records (pre-dedup, paired with
 * their response_id keys), the file's newest quota snapshot, and line count.
 * Files are append-only in practice, so unchanged files are never re-read.
 */
function parseRolloutFile(file, settings, accountKey = "openai:default") {
  const parsed = { entries: [], fileQuota: null, quotaSamples: [], lines: 0, errors: [] };
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

    if (obj.type === "event_msg" && obj.payload && obj.payload.rate_limits) {
      const ts = Date.parse(obj.timestamp) || 0;
      const windows = quotaWindows(obj.payload.rate_limits);
      if (ts > 0) {
        for (const window of windows) {
          parsed.quotaSamples.push({
            version: 1,
            provider: "openai",
            accountKey,
            window: window.kind,
            sampledAt: new Date(ts).toISOString(),
            usedPercent: window.usedPercent,
            resetsAt: window.resetsAt,
            source: "codex-rollout",
          });
        }
      }
      if (!parsed.fileQuota || ts >= parsed.fileQuota.ts) {
        parsed.fileQuota = { ts, windows };
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
    // multi-frame files (same decoder the dsh tool adapter uses).
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

module.exports = tool;
