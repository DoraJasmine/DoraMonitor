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
 * Kimi Code tool adapter — reads the sessions tree's wire.jsonl usage.record
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
 * see tools/file-scan.js.
 */

/** home -> Map(file path -> { stamp, parsed, bucket, racy }) */
const fileCaches = new Map();

const tool = {
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
      id: tool.id,
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
 *
 * REQUEST TIMING: usage.record rows are emitted through a port of CC Switch's
 * `kimi_session.rs` RequestIndex (via ccs-ssh-sync). A usage.record between
 * step.begin and step.end is deferred until step.end closes the turn, then
 * stamped with that turn's latency/TTFT (native llmFirstTokenLatencyMs +
 * llmStreamDurationMs when present, otherwise the llm.request→response
 * window excluding tool-execution pauses). Records whose step never closes
 * flush unchanged at the next boundary — token totals are IDENTICAL to the
 * pre-timing parser; only latencyMs/firstTokenMs get filled in.
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

  // --- RequestIndex timing state (per file) ---
  let activeStep = null; // { uuid, requestMs, responseMs, hasTools }
  const msgIndex = new Map(); // messageId -> { latencyMs, firstTokenMs }
  const pendingUsage = []; // { rec } awaiting this step's step.end
  const flushPending = () => {
    for (const item of pendingUsage) parsed.records.push(item.rec);
    pendingUsage.length = 0;
  };

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
      if (call && call.type === "context.append_loop_event" && ev && ev.type === "tool.call") {
        if (activeStep && ev.stepUuid === activeStep.uuid) activeStep.hasTools = true;
        if (ev.name) {
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
      }
      continue;
    }
    // Fast reject without full parse — usage records plus the RequestIndex
    // state-machine event types.
    if (
      !line.includes('"usage.record"') &&
      !line.includes('"step.begin"') &&
      !line.includes('"step.end"') &&
      !line.includes('"content.part"') &&
      !line.includes('"llm.request"') &&
      !line.includes('"agent.switched"') &&
      !line.includes('"agent.turn.started"')
    ) {
      continue;
    }
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") continue;
    const lineTsMs = n(obj.time) || null;

    // --- RequestIndex state machine ---
    if (obj.type === "agent.switched" || obj.type === "agent.turn.started") {
      flushPending();
      activeStep = null;
    } else if (obj.type === "llm.request") {
      if ((!obj.kind || obj.kind === "loop") && activeStep) {
        const expected = activeStep.turnStep;
        const actual = typeof obj.turnStep === "string" ? obj.turnStep : null;
        if (!expected || !actual || expected === actual) {
          activeStep.requestMs = lineTsMs;
          activeStep.responseMs = null;
          activeStep.hasTools = false;
        }
      }
    } else if (obj.type === "context.append_loop_event") {
      const ev = obj.event || {};
      if (ev.type === "step.begin") {
        flushPending();
        activeStep = ev.uuid
          ? {
              uuid: String(ev.uuid),
              turnStep:
                typeof ev.turnId === "string" && ev.step != null
                  ? `${ev.turnId}.${ev.step}`
                  : null,
              requestMs: null,
              responseMs: null,
              hasTools: false,
            }
          : null;
      } else if (activeStep && ev.stepUuid === activeStep.uuid && ev.type === "content.part") {
        if (lineTsMs != null && (activeStep.responseMs == null || lineTsMs > activeStep.responseMs)) {
          activeStep.responseMs = lineTsMs;
        }
      } else if (ev.type === "step.end" && (!activeStep || ev.uuid === activeStep.uuid)) {
        const finished = activeStep || {};
        activeStep = null;
        const msgId = typeof ev.messageId === "string" && ev.messageId ? ev.messageId : null;
        if (msgId) {
          const ftMs = kimiDurationMs(ev.llmFirstTokenLatencyMs);
          const streamMs = kimiDurationMs(ev.llmStreamDurationMs);
          const native = ftMs != null && streamMs != null ? ftMs + streamMs : null;
          const endMs =
            finished.responseMs ?? (!finished.hasTools ? lineTsMs : null);
          const latencyMs = native ?? estLatencyMs(finished.requestMs, endMs) ?? 0;
          const prev = msgIndex.get(msgId) || { latencyMs: 0, firstTokenMs: null };
          if (latencyMs > 0) {
            prev.latencyMs = latencyMs;
            const ft = ftMs != null && ftMs <= latencyMs ? ftMs : null;
            if (ft != null) prev.firstTokenMs = ft;
            else if (prev.firstTokenMs != null && prev.firstTokenMs > latencyMs) prev.firstTokenMs = null;
          }
          msgIndex.set(msgId, prev);
        }
        // Deferred usage records of this step now get their timing.
        const info = msgId ? msgIndex.get(msgId) : null;
        const stepPending = pendingUsage.splice(0, pendingUsage.length);
        for (const item of stepPending) {
          if (info && info.latencyMs > 0) {
            item.rec.latencyMs = info.latencyMs;
            if (info.firstTokenMs != null && info.firstTokenMs <= info.latencyMs) {
              item.rec.firstTokenMs = info.firstTokenMs;
            }
          }
          // Paired usage rows inherit the turn's message id as their stable
          // request identity (usage.record carries no id of its own).
          if (msgId) item.rec.nativeId = msgId;
          parsed.records.push(item.rec);
        }
      }
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
    // Inside an open step: defer so step.end can stamp timing (or flush
    // unchanged at the next boundary). Outside steps: emit directly.
    if (activeStep) pendingUsage.push({ rec });
    else parsed.records.push(rec);
  }
  flushPending();
  return parsed;
}

const MAX_PLAUSIBLE_LATENCY_MS = 3_600_000;

function kimiDurationMs(val) {
  const x = Number(val);
  if (!Number.isFinite(x) || x < 0 || x > MAX_PLAUSIBLE_LATENCY_MS) return null;
  return Math.round(x);
}

function estLatencyMs(startMs, endMs) {
  if (startMs == null || endMs == null) return null;
  const diff = endMs - startMs;
  if (diff < 100 || diff > MAX_PLAUSIBLE_LATENCY_MS) return null;
  return Math.round(diff);
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

module.exports = tool;
