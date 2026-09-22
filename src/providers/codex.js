"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { n, emptyRecord, expandHome } = require("./base");
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

  scan(home) {
    const roots = [
      path.join(home, "sessions"),
      path.join(home, "archived_sessions"),
    ];
    const records = [];
    const errors = [];
    const seenResponses = new Set();
    let filesScanned = 0;
    let linesSeen = 0;
    // Newest rate_limits snapshot across all scanned files, { ts, windows }.
    let bestQuota = null;

    const settings = (() => {
      try {
        return loadSettings();
      } catch {
        return null;
      }
    })();

    for (const root of roots) {
      for (const file of listRolloutFiles(root)) {
        filesScanned += 1;
        try {
          const text = fs.readFileSync(file, "utf8");
          const lines = text.split(/\r?\n/);

          // turn_id -> { model, cwd } from turn_context events; also the
          // most recent values as a fallback for records whose turn has no
          // context line in this file.
          const turnInfo = new Map();
          let lastModel = null;
          let lastCwd = null;
          // Newest rate_limits within THIS file (each file is read whole).
          let fileQuota = null;

          for (const line of lines) {
            if (!line) continue;
            linesSeen += 1;
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
              if (!fileQuota || ts >= fileQuota.ts) {
                fileQuota = { ts, windows: quotaWindows(obj.payload.rate_limits) };
              }
              continue;
            }

            if (obj.type !== "token_usage_record") continue;
            const payload = obj.payload || {};
            const responseId = String(payload.response_id || "");
            if (responseId) {
              if (seenResponses.has(responseId)) continue;
              seenResponses.add(responseId);
            }
            const usage = payload.usage;
            if (!usage || typeof usage !== "object") continue;

            const cached = n(usage.cached_input_tokens);
            const inputTotal = n(usage.input_tokens);
            const inputOther = Math.max(0, inputTotal - cached);
            const output = n(usage.output_tokens);
            const cacheCreate = n(usage.cache_write_input_tokens);
            if (inputOther + cached + cacheCreate + output <= 0) continue;

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
            rec.session = String(payload.session_id || payload.thread_id || path.basename(file, ".jsonl"));
            rec.sessionHint = { session: rec.session, project: rec.project };
            records.push(rec);
          }
          // A full file read always ends at its newest line, so the last
          // fileQuota seen is the freshest; keep the newest across files.
          if (fileQuota && fileQuota.windows.length && (!bestQuota || fileQuota.ts >= bestQuota.ts)) {
            bestQuota = fileQuota;
          }
        } catch (err) {
          errors.push({ file, message: String(err && err.message ? err.message : err) });
        }
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
        sessionsRoot: path.join(home, "sessions"),
        errors: errors.slice(0, 20),
      },
      quota: quotaPayload(bestQuota),
    };
  },
};

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
    const used = n(w.used_percent);
    if (used === null) continue;
    const resetsAt = Number(w.resets_at);
    windows.push({
      kind,
      label,
      usedPercent: used,
      resetsAt: Number.isFinite(resetsAt) && resetsAt > 0 ? new Date(resetsAt * 1000).toISOString() : null,
    });
  }
  return windows;
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

module.exports = provider;
