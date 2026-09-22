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
              rec.time = n(call.time) || n(ev.time) || 0;
              // tool.call lines may omit a timestamp; fall back to file mtime.
              if (!rec.time) rec.time = 0;
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
          const resolved = resolveModel(modelRaw, modelMap);
          const pricingModel = resolved.resolved || modelRaw;
          const cost = costForUsage(pricingModel, { ...usage, time: n(obj.time) }, { settings });

          const rec = emptyRecord("kimi-code");
          rec.time = n(obj.time);
          rec.model = modelRaw;
          rec.modelDisplay = resolved.display;
          rec.modelResolved = resolved.resolved;
          rec.inputOther = n(usage.inputOther);
          rec.output = n(usage.output);
          rec.inputCacheRead = n(usage.inputCacheRead);
          rec.inputCacheCreation = n(usage.inputCacheCreation);
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
