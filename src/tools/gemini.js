"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { n, emptyRecord, expandHome } = require("./base");
const { costForUsage } = require("../pricing");
const { loadSettings } = require("../settings");

/**
 * Gemini CLI tool adapter — parses the OpenTelemetry file export that Gemini
 * CLI writes when telemetry is enabled in ~/.gemini/settings.json:
 *
 *   { "telemetry": { "enabled": true, "target": "local",
 *                    "outfile": "C:/…/gemini-otel.jsonl" } }
 *
 * The outfile is NDJSON; each line is one OTLP ExportMetricsServiceRequest
 * (protobuf-JSON). We consume the two counters that carry usage:
 *
 *   gemini_cli.token.usage  — attributes {model, type}; type ∈ input /
 *                             output / thought / cache / tool. Sum points
 *                             are CUMULATIVE per CLI process, so this
 *                             tool adapter diffs consecutive points per
 *                             (model, type) and treats a decreasing value
 *                             as a fresh session starting at the new total.
 *   gemini_cli.tool.call.count — attributes {function_name, success};
 *                             folded into tool-call events (WebSearch-style
 *                             KPI cards show google_web_search etc.).
 *
 * KNOWN LIMITS (inherent to the source, not the parser):
 *   - No session/project dimension — Gemini CLI does not attach them, so
 *     records carry no project and a single synthetic session id.
 *   - A point's timestamp is the export time; short sessions land on their
 *     last export tick.
 *   - The outfile grows without rotation; parsing caps at MAX_FILE_BYTES.
 */

const MAX_FILE_BYTES = 32 * 1024 * 1024;
const SYNTH_SESSION = "gemini-cli";

const TOKEN_TYPES = {
  input: "inputOther",
  output: "output",
  thought: "output",
  cache: "inputCacheRead",
  tool: "inputOther",
};

/** Cumulative counters per (model, type), diffed across reads. */
const lastCumulative = new Map(); // home -> Map("model\0type" -> {value, time})

function defaultHome() {
  if (process.env.GEMINI_CLI_HOME && process.env.GEMINI_CLI_HOME.trim()) {
    return path.resolve(expandHome(process.env.GEMINI_CLI_HOME.trim()));
  }
  return path.join(os.homedir(), ".gemini");
}

/** The telemetry outfile path from settings.json, or a conventional name. */
function telemetryOutfile(home) {
  const settingsPath = path.join(home, "settings.json");
  try {
    const cfg = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const tel = cfg.telemetry || {};
    if (tel.enabled === false) return null;
    if (typeof tel.outfile === "string" && tel.outfile.trim()) {
      return expandHome(tel.outfile.trim());
    }
    // Enabled but no outfile: OTLP goes to a collector, not a file we read.
    return null;
  } catch {
    return null;
  }
}

function isAvailable(home) {
  return fs.existsSync(home) && telemetryOutfile(home) !== null;
}

function attrValue(attrs, key) {
  const a = (attrs || []).find((x) => x && x.key === key);
  if (!a || !a.value) return null;
  const v = a.value;
  return v.stringValue ?? (v.intValue !== undefined ? String(v.intValue) : v.doubleValue ?? null);
}

function pointValue(dp) {
  const v = dp || {};
  const raw = v.asInt !== undefined ? Number(v.asInt) : v.asDouble;
  return Number.isFinite(Number(raw)) ? Number(raw) : null;
}

function nanoToMs(nano) {
  const num = Number(nano);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.floor(num / 1e6);
}

/**
 * Parse the NDJSON metric stream and diff the cumulative token counters.
 * Returns records + tool-call events.
 */
function parseOtelFile(file, settings, state) {
  const records = [];
  const events = [];
  let lines = 0;
  let stat = null;
  try {
    stat = fs.statSync(file);
  } catch {
    return { records, events, lines, errors: [] };
  }
  let text;
  try {
    const fd = fs.openSync(file, "r");
    try {
      const len = Math.min(stat.size, MAX_FILE_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, 0);
      text = buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    return { records, events, lines, errors: [{ file, message: String(err) }] };
  }

  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    lines += 1;
    if (!line.includes("gemini_cli.token.usage") && !line.includes("gemini_cli.tool.call.count")) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    for (const rm of obj.resourceMetrics || []) {
      for (const sm of rm.scopeMetrics || []) {
        for (const metric of sm.metrics || []) {
          const points = metric.sum && metric.sum.dataPoints;
          if (!Array.isArray(points)) continue;
          if (metric.name === "gemini_cli.token.usage") {
            for (const dp of points) {
              const model = String(attrValue(dp.attributes, "model") || "unknown");
              const type = String(attrValue(dp.attributes, "type") || "input");
              const value = pointValue(dp);
              if (value === null) continue;
              const time = nanoToMs(dp.timeUnixNano);
              const key = `${model}\u0000${type}`;
              const prev = state.get(key);
              // Cumulative → delta; a decrease means a new CLI process.
              const delta = prev && value >= prev.value ? value - prev.value : value;
              state.set(key, { value, time });
              if (delta <= 0) continue;
              records.push(makeRecord(model, type, delta, time, settings));
            }
          } else if (metric.name === "gemini_cli.tool.call.count") {
            for (const dp of points) {
              const fn = String(attrValue(dp.attributes, "function_name") || "unknown");
              const value = pointValue(dp);
              if (value === null) continue;
              const time = nanoToMs(dp.timeUnixNano);
              const key = `tool\u0000${fn}`;
              const prev = state.get(key);
              const delta = prev && value >= prev.value ? value - prev.value : value;
              state.set(key, { value, time });
              if (delta <= 0) continue;
              const ev = emptyRecord("gemini");
              ev.time = time;
              ev.model = "tool-call";
              ev.modelDisplay = fn;
              ev.eventName = fn;
              ev.kind = "event";
              events.push(ev);
            }
          }
        }
      }
    }
  }
  return { records, events, lines, errors: [] };
}

function makeRecord(model, type, delta, time, settings) {
  const rec = emptyRecord("gemini");
  rec.time = time;
  rec.model = model;
  rec.modelDisplay = model;
  rec.modelResolved = model;
  const field = TOKEN_TYPES[type] || "inputOther";
  rec[field] = (rec[field] || 0) + delta;
  if (type === "cache") {
    // "cache" tokens are cached-input reads.
    rec.inputOther = 0;
  }
  const cost = costForUsage(rec.modelResolved || rec.model, rec, { settings });
  rec.costCny = cost.total;
  rec.costEstimated = cost.estimated;
  rec.priceId = cost.priceId;
  rec.session = SYNTH_SESSION;
  rec.sessionHint = { session: SYNTH_SESSION, project: null };
  return rec;
}

const tool = {
  id: "gemini",
  label: "Gemini CLI",

  defaultHome() {
    return defaultHome();
  },

  isAvailable(home) {
    return isAvailable(home);
  },

  sourceFiles(home) {
    const outfile = telemetryOutfile(home);
    return outfile ? [outfile] : [];
  },

  /** No per-file caches: the OTel stream is a single append-only file that
   *  is fully re-parsed (counter-diffed) on every scan. */
  clearCache() {
    lastCumulative.clear();
  },

  scan(home) {
    const outfile = telemetryOutfile(home);
    if (!outfile) {
      return {
        records: [],
        meta: {
          filesScanned: 0,
          filesReread: 0,
          linesSeen: 0,
          recordCount: 0,
          home,
          errors: [
            fs.existsSync(home)
              ? {
                  file: path.join(home, "settings.json"),
                  message:
                    "Gemini CLI telemetry not enabled for file export — set telemetry {enabled, outfile} in ~/.gemini/settings.json",
                }
              : { file: home, message: "Gemini CLI data directory not found" },
          ],
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

    let state = lastCumulative.get(home);
    if (!state) {
      state = new Map();
      lastCumulative.set(home, state);
    }

    const out = parseOtelFile(outfile, settings, state);
    out.records.sort((a, b) => b.time - a.time);
    out.events.sort((a, b) => b.time - a.time);

    return {
      records: out.records,
      events: out.events,
      meta: {
        filesScanned: 1,
        filesReread: 1,
        linesSeen: out.lines,
        recordCount: out.records.length,
        home,
        outfile,
        errors: out.errors.slice(0, 20),
      },
    };
  },
};

module.exports = tool;
