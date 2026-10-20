"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { n, emptyRecord, expandHome } = require("./base");
const { costForUsage } = require("../pricing");
const { loadSettings } = require("../settings");
const { resolveModelIdentity } = require("../model-identity");

/**
 * dsh provider — scans ~/.dsh/sessions for
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
 * Responses are de-duplicated by message.id. Project/cwd come from the
 * session header line (first line of each file).
 *
 * MODEL NAMES: when a dsh plugin proxies another vendor, the plugin records
 * that vendor's own routing code on source.model and names itself on
 * source.provider (e.g. {provider:"qodercn", model:"dfmodel"}). The code alone
 * is meaningless to a human, so resolution goes through model-identity.js —
 * the same table the QoderCN providers use — and the provider id is kept on
 * the record for provenance. Unmapped codes stay visible as their raw id.
 *
 * No quota part by design — dsh's provider-snapshots.json carries no quota.
 */
const provider = {
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

  scan(home) {
    const root = path.join(home, "sessions");
    const records = [];
    const errors = [];
    const seenMessages = new Set();
    let filesScanned = 0;
    let linesSeen = 0;

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

    for (const file of listTranscriptFiles(root)) {
      filesScanned += 1;
      try {
        let text;
        if (file.endsWith(".zstd")) {
          if (!Decompress) {
            errors.push({ file, message: "skipped: fzstd unavailable" });
            continue;
          }
          text = decompressMultiFrame(Decompress, fs.readFileSync(file));
        } else {
          text = fs.readFileSync(file, "utf8");
        }

        // The session header line carries the stable id and the project cwd.
        let sessionId = path.basename(path.dirname(file));
        let cwd = path.basename(path.dirname(path.dirname(file)));

        const lines = text.split(/\r?\n/);
        for (const line of lines) {
          if (!line) continue;
          linesSeen += 1;
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

          // Dedupe on message.id; without an id there is nothing stable to
          // dedupe on, so count the line.
          const messageId = String(message.id || "");
          if (messageId) {
            if (seenMessages.has(messageId)) continue;
            seenMessages.add(messageId);
          }

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
          records.push(rec);
        }
      } catch (err) {
        errors.push({ file, message: String(err && err.message ? err.message : err) });
      }
    }

    // newest first for "recent"
    records.sort((a, b) => b.time - a.time);

    return {
      records,
      meta: {
        filesScanned,
        linesSeen,
        recordCount: records.length,
        home,
        sessionsRoot: root,
        errors: errors.slice(0, 20),
      },
    };
  },
};

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

module.exports = provider;
