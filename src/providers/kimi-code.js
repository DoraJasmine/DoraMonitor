"use strict";

const fs = require("fs");
const path = require("path");
const { expandHome, n, emptyRecord } = require("./base");
const { scanFilesWithBuckets } = require("./file-scan");
const { bucketFromRecords } = require("../buckets");
const { resolveModel } = require("../model-map");
const { costForUsage } = require("../pricing");
const { loadSettings } = require("../settings");

/**
 * Kimi Code provider — reads the sessions tree's wire.jsonl usage.record
 * events across every agent directory (main and subagents).
 * Only usageScope === "turn" rows are counted (session-level rows are
 * aggregates and would double-count).
 *
 * FORKED SESSIONS: `kimi-code` forks a session by copying the parent's
 * wire.jsonl into a new session directory, so every inherited usage.record
 * appears under two session ids. Measured on a real tree this duplicated
 * ~15% of records / ~26% of tokens. `usage.record` carries no id field, so
 * de-duplication keys on the value tuple
 * (model|time|inputOther|output|cacheRead|cacheCreate) that a copied line
 * reproduces byte-for-byte. Records with no timestamp cannot be told apart
 * from a legitimate repeat and are left alone. The dedup runs inside the
 * shared file-scan skeleton (oldest-mtime first, so the fork copy loses to
 * its parent) and day-buckets fold the DEDUPED contribution per file —
 * see providers/file-scan.js.
 */

/** home -> Map(file path -> { stamp, parsed, bucket, racy }) */
const fileCaches = new Map();

const provider = {
  id: "kimi-code",
  label: "Kimi Code",

  defaultHome() {
    if (process.env.KIMI_CODE_HOME && process.env.KIMI_CODE_HOME.trim()) {
      return path.resolve(expandHome(process.env.KIMI_CODE_HOME.trim()));
    }
    return path.join(require("os").homedir(), ".kimi-code");
  },

  isAvailable(home) {
    return fs.existsSync(path.join(home, "sessions"));
  },

  /** Drop all per-file caches (used when pricing settings change). */
  clearCache() {
    fileCaches.clear();
  },

  scan(home, modelMap, opts = {}) {
    const root = path.join(home, "sessions");
    // collect.js always passes a map, but scan() is also reachable directly
    // (tests, scripts). Treat a missing map as "no aliases configured" rather
    // than throwing on modelMap.aliases.
    const map = modelMap && typeof modelMap === "object" ? modelMap : { aliases: {} };

    if (!fs.existsSync(root)) {
      fileCaches.delete(home);
      return {
        records: [],
        events: [],
        buckets: [],
        meta: {
          filesScanned: 0,
          filesReread: 0,
          linesSeen: 0,
          home,
          sessionsRoot: root,
          errors: ["sessions directory not found"],
        },
      };
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
      id: provider.id,
      home,
      files: listWireFiles(root),
      cacheMap: cache,
      recordSince: opts.recordSince,
      settings,
      parseFile: (file) => parseWireFile(file, root, map, settings),
      signatureOf: (rec) =>
        rec.time
          ? [
              rec.model,
              rec.time,
              rec.inputOther,
              rec.output,
              rec.inputCacheRead,
              rec.inputCacheCreation,
            ].join("\u0000")
          : "",
      foldBucket: (contributed, parsed, relPath, stamp, sigs) => {
        const bucket = bucketFromRecords(contributed, parsed.events, relPath, stamp, sigs);
        bucket.lines = parsed.lines;
        return bucket;
      },
    });

    return {
      records: out.records,
      events: out.events,
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
 * Parse one wire.jsonl: usage records (costed, pre-dedup) plus tool.call
 * events. Per-file output is cached by the scan skeleton.
 */
function parseWireFile(file, sessionsRootPath, map, settings) {
  const parsed = { records: [], events: [], lines: 0, errors: [] };
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    parsed.errors.push({ file, message: String(err && err.message ? err.message : err) });
    return parsed;
  }
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;
    parsed.lines += 1;
    if (line.includes('"tool.call"')) {
      let call;
      try {
        call = JSON.parse(line);
      } catch {
        call = null;
      }
      const ev = call && call.event;
      if (call && call.type === "context.append_loop_event" && ev && ev.type === "tool.call" && ev.name) {
        const rec = emptyRecord("kimi-code");
        // Events without any timestamp are not attributable to a range
        // (time 0 → only the "all" range counts them); attributing them to
        // the file's mtime made old events drift into "today".
        rec.time = n(call.time) || n(ev.time);
        rec.model = "tool-call";
        rec.modelDisplay = ev.name;
        rec.eventName = ev.name;
        rec.kind = "event";
        parsed.events.push(rec);
      }
      continue;
    }
    // Fast reject without full parse
    if (!line.includes('"usage.record"')) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type !== "usage.record") continue;
    // Prefer turn-level to avoid double counting session aggregates
    if (obj.usageScope && obj.usageScope !== "turn") continue;

    const usage = obj.usage || {};
    const modelRaw = obj.model || "unknown";
    const time = n(obj.time);
    const inputOther = n(usage.inputOther);
    const output = n(usage.output);
    const inputCacheRead = n(usage.inputCacheRead);
    const inputCacheCreation = n(usage.inputCacheCreation);

    const resolved = resolveModel(modelRaw, map);
    const pricingModel = resolved.resolved || modelRaw;
    const cost = costForUsage(pricingModel, { ...usage, time }, { settings });

    const rec = emptyRecord("kimi-code");
    rec.time = time;
    rec.model = modelRaw;
    rec.modelDisplay = resolved.display;
    rec.modelResolved = resolved.resolved;
    rec.inputOther = inputOther;
    rec.output = output;
    rec.inputCacheRead = inputCacheRead;
    rec.inputCacheCreation = inputCacheCreation;
    rec.costCny = cost.total;
    rec.costEstimated = cost.estimated;
    rec.priceId = cost.priceId;
    // path only for session grouping — basename chain, no content
    rec.sessionHint = sessionHintFromPath(file, sessionsRootPath);
    rec.session = rec.sessionHint.session;
    rec.project = rec.sessionHint.workspace;
    parsed.records.push(rec);
  }
  return parsed;
}

function listWireFiles(root) {
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
      // skip blobs / task logs noise
      if (ent.name === "blobs" || ent.name === "tasks" || ent.name === "node_modules") continue;
      walk(full, out);
    } else if (ent.isFile() && ent.name === "wire.jsonl") {
      out.push(full);
    }
  }
}

function sessionHintFromPath(file, sessionsRootPath) {
  // sessions/<workspace>/session_<id>/agents/<agent>/wire.jsonl
  const rel = path.relative(sessionsRootPath, file);
  const parts = rel.split(path.sep);
  return {
    workspace: parts[0] || null,
    session: parts[1] || null,
    agent: parts[3] || parts[2] || null,
  };
}

module.exports = provider;
