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
 * dsh tool adapter — scans ~/.dsh/sessions for
 * <encoded-cwd>/session-<uuid>/session.v4.jsonl.zstd transcripts
 * (DeepSeek Harness CLI). Plaintext .jsonl siblings are accepted too.
 *
 * The .zstd files are MULTI-FRAME concatenations (dsh appends a frame per
 * write), which node:zlib's one-shot zstdDecompressSync cannot fully decode,
 * so decompression streams through fzstd's Decompress. fzstd is pure JS; if
 * it ever fails to load, isAvailable stays true but scan reports the problem
 * in meta.errors and returns empty records instead of throwing.
 *
 * Token usage lives on assistant/message lines:
 *   data.usage.{inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens}
 * DeepSeek's inputTokens EXCLUDES the cached portions
 * (total = input + output + cacheRead), so inputOther is inputTokens as-is.
 *
 * Responses are de-duplicated by message.id (stored as _dedupKey); dedup and
 * per-file day-bucket folding run inside the shared file-scan skeleton.
 * Project/cwd come from the session header line (first line of each file).
 *
 * MODEL NAMES: when a dsh plugin proxies another vendor, the plugin records
 * that vendor's own routing code on source.model and names itself on
 * source.provider (e.g. {provider:"qodercn", model:"dfmodel"}). The code alone
 * is meaningless to a human, so resolution goes through model-identity.js —
 * the same table the QoderCN tools use — and the upstream provider id is kept on
 * the record for provenance. Unmapped codes stay visible as their raw id.
 *
 * No quota part by design — dsh's provider-snapshots.json carries no quota.
 */

/** home -> Map(file path -> { stamp, parsed, bucket, racy }) */
const fileCaches = new Map();

const tool = {
  id: "dsh",
  label: "dsh",

  defaultHome() {
    if (process.env.DSH_HOME && process.env.DSH_HOME.trim()) {
      return path.resolve(expandHome(process.env.DSH_HOME.trim()));
    }
    return path.join(os.homedir(), ".dsh");
  },

  isAvailable(home) {
    return fs.existsSync(path.join(home, "sessions"));
  },

  /** Drop all per-file caches (used when pricing settings change). */
  clearCache() {
    fileCaches.clear();
  },

  scan(home, opts = {}) {
    const root = path.join(home, "sessions");
    const errors = [];

    let Decompress = null;
    try {
      ({ Decompress } = require("fzstd"));
    } catch (err) {
      errors.push({
        file: null,
        message: `fzstd unavailable, .zstd sessions skipped: ${
          err && err.message ? err.message : err
        }`,
      });
    }

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
      parseFile: (file) => parseTranscriptFile(file, Decompress, settings),
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
        errors: [...errors, ...out.errors].slice(0, 20),
      },
    };
  },
};

/**
 * Parse one transcript file: costed records (pre-dedup, _dedupKey =
 * message.id). Per-file output is cached by the scan skeleton — the fzstd
 * multi-frame decompression of a 1-2 MB .zstd costs hundreds of ms in pure
 * JS, so unchanged files must never be re-read.
 */
function parseTranscriptFile(file, Decompress, settings) {
  const parsed = { records: [], events: [], lines: 0, errors: [] };
  let text;
  if (file.endsWith(".zstd")) {
    if (!Decompress) {
      parsed.errors.push({ file, message: "skipped: fzstd unavailable" });
      return parsed;
    }
    try {
      text = decompressMultiFrame(Decompress, fs.readFileSync(file));
    } catch (err) {
      parsed.errors.push({ file, message: String(err && err.message ? err.message : err) });
      return parsed;
    }
  } else {
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (err) {
      parsed.errors.push({ file, message: String(err && err.message ? err.message : err) });
      return parsed;
    }
  }

  // The session header line carries the stable id and the project cwd.
  let sessionId = path.basename(path.dirname(file));
  let cwd = path.basename(path.dirname(path.dirname(file)));

  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;
    parsed.lines += 1;
    // Fast reject before full parse — only assistant/message lines
    // carry usage, and the session header is picked up via "type".
    // Match the quoted type token, not `"type":"session"`: a writer
    // that pretty-prints (space after the colon) would otherwise lose
    // the session id and cwd silently.
    if (!line.includes('"usage"') && !line.includes('"session"')) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type === "session") {
      if (obj.id) sessionId = String(obj.id);
      if (typeof obj.cwd === "string" && obj.cwd) cwd = obj.cwd;
      continue;
    }
    if (obj.type !== "assistant/message") continue;
    const data = obj.data;
    if (!data || typeof data !== "object") continue;
    const message = data.message;
    if (!message || typeof message !== "object") continue;
    const usage = data.usage;
    if (!usage || typeof usage !== "object") continue;

    const inputOther = n(usage.inputTokens);
    const cacheRead = n(usage.cacheReadTokens);
    const cacheCreate = n(usage.cacheWriteTokens);
    const output = n(usage.outputTokens);
    // Skip all-zero placeholders BEFORE dedupe. Registering the id first
    // would let a zero-usage placeholder swallow the real message that
    // shares its id (same bug class as codex/claude-code).
    if (inputOther + cacheRead + cacheCreate + output <= 0) continue;

    const messageId = String(message.id || "");

    const rec = emptyRecord("dsh");
    rec.time = n(obj.time);
    const source = message.source && typeof message.source === "object" ? message.source : {};
    const rawModel = String(source.model || "unknown");
    // dsh names the plugin that actually served the request; the model
    // id inside a proxied response is usually that vendor's routing code.
    const identity = resolveModelIdentity(rawModel, {
      provider: source.provider ? String(source.provider) : null,
    });
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
    rec._dedupKey = messageId;
    parsed.records.push(rec);
  }
  return parsed;
}

/** Decode a (possibly multi-frame) zstd buffer to utf8 text via fzstd. */
function decompressMultiFrame(Decompress, buf) {
  const chunks = [];
  const d = new Decompress((chunk) => chunks.push(chunk));
  d.push(buf, true);
  return Buffer.concat(
    chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))
  ).toString("utf8");
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
    } else if (ent.isFile() && (ent.name.endsWith(".jsonl.zstd") || ent.name.endsWith(".jsonl"))) {
      out.push(full);
    }
  }
}

module.exports = tool;
