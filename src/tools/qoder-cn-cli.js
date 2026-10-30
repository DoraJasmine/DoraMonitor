"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { n, emptyRecord, expandHome } = require("./base");
const { resolveModelIdentity } = require("../model-identity");

/**
 * QoderCN CLI tool adapter — scans ~/.qoder-cn/projects/<encoded-cwd>/<uuid>.jsonl
 * (Claude-style transcripts). Token usage lives on assistant messages:
 * message.usage = { input_tokens, output_tokens, cache_read_input_tokens,
 * cache_creation_input_tokens, credits, ... }
 *
 * `credits` is the actual billed quantity — surfaced as-is (not USD).
 */
function displayName(modelKey) {
  return resolveModelIdentity(modelKey).modelDisplay;
}

function listTranscriptFiles(root) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const projectDir = path.join(root, ent.name);
    let files;
    try {
      files = fs.readdirSync(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (f.isFile() && f.name.endsWith(".jsonl")) {
        out.push(path.join(projectDir, f.name));
      }
    }
  }
  return out;
}

// Encoded dir name "-home-zxt-lyfLearn-3dGS" → "/home/zxt/lyfLearn/3dGS".
// Dashes inside real path segments are ambiguous; this is a display hint only.
function projectFromDirName(dirName) {
  if (!dirName || dirName === "-") return null;
  return dirName.replace(/-/g, "/");
}

function sessionFromFileName(fileName) {
  return fileName.replace(/\.jsonl$/i, "");
}

function toMs(timestamp) {
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
    return timestamp > 0 && timestamp < 100000000000 ? timestamp * 1000 : timestamp;
  }
  const text = String(timestamp || "").trim();
  if (!text) return 0;
  const asNum = Number(text);
  if (Number.isFinite(asNum) && asNum > 0) {
    return asNum < 100000000000 ? asNum * 1000 : asNum;
  }
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function scanFile(file, projectDirName) {
  const records = [];
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  let linesSeen = 0;
  for (const line of lines) {
    if (!line) continue;
    linesSeen += 1;
    // Fast reject before JSON.parse
    if (!line.includes('"usage"')) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type !== "assistant") continue;
    const message = obj.message;
    if (!message || typeof message !== "object") continue;
    const usage = message.usage;
    if (!usage || typeof usage !== "object") continue;

    // Skip all-zero rows (some builds log empty usage placeholders)
    const total =
      n(usage.input_tokens) +
      n(usage.output_tokens) +
      n(usage.cache_read_input_tokens) +
      n(usage.cache_creation_input_tokens);
    if (total <= 0 && n(usage.credits) <= 0) continue;

    const rec = emptyRecord("qoder-cn-cli");
    rec.time = toMs(obj.timestamp);
    rec.model = String(message.model || "unknown");
    const identity = resolveModelIdentity(rec.model);
    rec.modelDisplay = identity.modelDisplay;
    rec.modelResolved = identity.pricingKey || rec.model;
    rec.inputOther = n(usage.input_tokens);
    rec.output = n(usage.output_tokens);
    rec.inputCacheRead = n(usage.cache_read_input_tokens);
    rec.inputCacheCreation = n(usage.cache_creation_input_tokens);
    const credits = Number(usage.credits);
    rec.credits = Number.isFinite(credits) ? credits : null;
    rec.project = projectFromDirName(projectDirName);
    rec.session = sessionFromFileName(path.basename(file));
    rec.sessionHint = { session: rec.session, project: rec.project };
    records.push(rec);
  }
  return { records, linesSeen };
}

const tool = {
  id: "qoder-cn-cli",
  label: "QoderCN CLI",
  // The CLI transcript logs token fields, but every build to date writes
  // zeros — the real billed quantity is `usage.credits`. The UI uses this
  // flag to show a credits-only hint instead of an empty token table.
  creditsOnly: true,

  defaultHome() {
    if (process.env.QODER_CLI_HOME && process.env.QODER_CLI_HOME.trim()) {
      return path.resolve(expandHome(process.env.QODER_CLI_HOME.trim()));
    }
    return path.join(os.homedir(), ".qoder-cn");
  },

  isAvailable(home) {
    return fs.existsSync(path.join(home, "projects"));
  },

  scan(home) {
    const root = path.join(home, "projects");
    const records = [];
    const errors = [];
    let filesScanned = 0;
    let linesSeen = 0;

    for (const file of listTranscriptFiles(root)) {
      filesScanned += 1;
      const projectDirName = path.basename(path.dirname(file));
      try {
        const { records: recs, linesSeen: fileLines } = scanFile(file, projectDirName);
        linesSeen += fileLines;
        records.push(...recs);
      } catch (err) {
        errors.push({ file, message: String(err && err.message ? err.message : err) });
      }
    }

    records.sort((a, b) => b.time - a.time);

    return {
      records,
      meta: {
        filesScanned,
        linesSeen,
        recordCount: records.length,
        home,
        projectsRoot: root,
        errors: errors.slice(0, 20),
      },
    };
  },
};

module.exports = tool;
