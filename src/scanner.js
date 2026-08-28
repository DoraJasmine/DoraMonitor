"use strict";

const fs = require("fs");
const path = require("path");
const { sessionsRoot } = require("./paths");
const { costForUsage } = require("./pricing");
const { resolveModel } = require("./model-map");

/**
 * Walk sessions wire.jsonl files and extract only usage.record fields:
 * model, time, token counts. Never keep prompt/content/keys.
 *
 * Only usageScope === "turn" is counted (session-level rows are aggregates).
 */
function scanUsage(home, modelMap, options = {}) {
  const root = sessionsRoot(home);
  const records = [];
  const errors = [];
  let filesScanned = 0;
  let linesSeen = 0;

  if (!fs.existsSync(root)) {
    return {
      records,
      meta: { filesScanned: 0, linesSeen: 0, home, sessionsRoot: root, errors: ["sessions directory not found"] },
    };
  }

  const wireFiles = listWireFiles(root);
  for (const file of wireFiles) {
    filesScanned += 1;
    try {
      const text = fs.readFileSync(file, "utf8");
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        if (!line) continue;
        linesSeen += 1;
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
        const cost = costForUsage(pricingModel, usage);

        records.push({
          time: Number(obj.time) || 0,
          model: modelRaw,
          modelResolved: resolved.resolved,
          modelDisplay: resolved.display,
          provider: resolved.provider || null,
          fromEnv: !!resolved.fromEnv,
          inputOther: n(usage.inputOther),
          output: n(usage.output),
          inputCacheRead: n(usage.inputCacheRead),
          inputCacheCreation: n(usage.inputCacheCreation),
          costUsd: cost.total,
          costEstimated: cost.estimated,
          priceId: cost.priceId,
          // path only for session grouping — basename chain, no content
          sessionHint: sessionHintFromPath(file, root),
        });
      }
    } catch (err) {
      errors.push({ file, message: String(err && err.message ? err.message : err) });
    }
  }

  // newest first for "recent"
  records.sort((a, b) => b.time - a.time);

  if (options.limit && options.limit > 0 && records.length > options.limit) {
    // keep all for aggregation; limit only applied by aggregator for recent list
  }

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

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

module.exports = {
  scanUsage,
  listWireFiles,
};
