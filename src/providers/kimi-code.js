"use strict";

const fs = require("fs");
const path = require("path");
const { expandHome, n, emptyRecord } = require("./base");
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
 * from a legitimate repeat and are left alone.
 */
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

  scan(home, modelMap) {
    const root = path.join(home, "sessions");
    // collect.js always passes a map, but scan() is also reachable directly
    // (tests, scripts). Treat a missing map as "no aliases configured" rather
    // than throwing on modelMap.aliases.
    const map = modelMap && typeof modelMap === "object" ? modelMap : { aliases: {} };
    const records = [];
    const errors = [];
    let filesScanned = 0;
    let linesSeen = 0;

    if (!fs.existsSync(root)) {
      return {
        records,
        meta: {
          filesScanned: 0,
          linesSeen: 0,
          home,
          sessionsRoot: root,
          errors: ["sessions directory not found"],
        },
      };
    }

    const wireFiles = listWireFiles(root);
    const settings = (() => {
      try {
        return loadSettings();
      } catch {
        return null;
      }
    })();
    // Tool-call events (WebSearch / FetchURL / ...) — counted separately
    // from token usage; never contribute to requests or cost.
    const events = [];
    // Forked sessions copy the parent's usage.record lines verbatim, so the
    // value tuple identifies a duplicate even though records carry no id.
    const seenUsage = new Set();
    let duplicatesSkipped = 0;
    for (const file of wireFiles) {
      filesScanned += 1;
      try {
        const text = fs.readFileSync(file, "utf8");
        const lines = text.split(/\r?\n/);
        for (const line of lines) {
          if (!line) continue;
          linesSeen += 1;
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
              // tool.call lines may omit a timestamp; fall back to the file's
              // mtime so the event is still attributable to a range.
              rec.time = n(call.time) || n(ev.time) || fileMtime(file);
              rec.model = "tool-call";
              rec.modelDisplay = ev.name;
              rec.eventName = ev.name;
              rec.kind = "event";
              events.push(rec);
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

          // Drop a copy of an already-counted turn (forked session). A record
          // with no timestamp is not deduped — it cannot be distinguished
          // from a genuine repeat.
          if (time) {
            const signature = [
              modelRaw,
              time,
              inputOther,
              output,
              inputCacheRead,
              inputCacheCreation,
            ].join("\u0000");
            if (seenUsage.has(signature)) {
              duplicatesSkipped += 1;
              continue;
            }
            seenUsage.add(signature);
          }

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
          rec.sessionHint = sessionHintFromPath(file, root);
          rec.session = rec.sessionHint.session;
          rec.project = rec.sessionHint.workspace;
          records.push(rec);
        }
      } catch (err) {
        errors.push({ file, message: String(err && err.message ? err.message : err) });
      }
    }

    // newest first for "recent"
    records.sort((a, b) => b.time - a.time);

    events.sort((a, b) => b.time - a.time);

    return {
      records,
      events,
      meta: {
        filesScanned,
        linesSeen,
        recordCount: records.length,
        duplicatesSkipped,
        home,
        sessionsRoot: root,
        errors: errors.slice(0, 20),
      },
    };
  },
};

function listWireFiles(root) {
  const out = [];
  walk(root, out);
  return out;
}

/** File mtime in ms, or 0 when unreadable — used as an event-time fallback. */
function fileMtime(file) {
  try {
    return fs.statSync(file).mtimeMs || 0;
  } catch {
    return 0;
  }
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
