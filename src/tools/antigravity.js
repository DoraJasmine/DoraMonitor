"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { n, emptyRecord, expandHome, openReadOnly } = require("./base");
const { costForUsage } = require("../pricing");
const { loadSettings } = require("../settings");
const { protoFields, varintField, dataField, timestampMs } = require("./protobuf-lite");

/**
 * Google Antigravity tool adapter — ONE tool that aggregates every local
 * Antigravity data root:
 *
 *   ~/.gemini/antigravity/conversations        (Windows App / IDE / hub)
 *   ~/.gemini/antigravity-cli/conversations    (Windows CLI, `agy`)
 *   \\wsl.localhost\<distro>\<home>\.gemini\antigravity(-cli)\conversations
 *                                              (every WSL distribution, root
 *                                              and each /home user)
 *
 * Each conversation is one SQLite database; reading the databases directly
 * covers CLI conversations, works while the app is closed, and does not
 * depend on which conversations the running app has loaded. Field numbers
 * come from the protobuf descriptors embedded in the language server
 * (approach first documented by MoFeng2223/BrimDeck's AntigravityUsage):
 *
 *   steps.metadata        CortexStepMetadata: 1 created_at (Timestamp),
 *                         9 model_usage (ModelUsageStats)
 *   gen_metadata.data     1 ChatModelMetadata: 4 usage, 19 response_model,
 *                         21 model_display_name (the model-menu label)
 *   ModelUsageStats       1 model (enum), 2 input, 3 output (thinking
 *                         included), 4 cache write, 5 cache read, 7 message id
 *
 * - Input EXCLUDES cache reads (a cache read can exceed the input of the same
 *   request), so inputOther = field 2 as-is and inputCacheRead = field 5.
 * - The model name is authoritative here: response_model is the bare id
 *   ("gemini-4-hydrogen") and model_display_name is the menu label
 *   ("Gemini 4 Hydrogen (High)") — unlike the rolling transcript.jsonl,
 *   every conversation is covered, including pre-2026-11 ones. Thinking
 *   effort / role suffixes such as "(XHigh)" / "(High)" / "(Thinking)" /
 *   "(Orchestrator)" are stripped so all efforts roll up under the same base
 *   model name. A step without a generation record of its own (a condensing
 *   checkpoint) is named by the model enum its usage carries, resolved against
 *   that model's generations in the same conversation (same rule as BrimDeck).
 * - Orchestrated generations name only their role as the response model
 *   ("gemini-pro-orchestrator", "gemini-flash-worker-agy"); the display name
 *   says which model actually ran and prices it ("Gemini 4 Hydrogen
 *   (Orchestrator)" → model "Gemini 4 Hydrogen", priceKey "gemini-4-hydrogen").
 * - Dedup is by message id: Antigravity writes one ModelUsageStats per
 *   generation and checkpoints never repeat an id, so the id is the stable
 *   dedup key across scans AND across data roots (a conversation can appear
 *   under both the App and the CLI root when it was resumed on the other
 *   surface — the same message id must not double count).
 * - Live databases: a conversation that is still running holds a write lock,
 *   so a direct open fails with "database is locked" (seen on every WSL
 *   conversation, whose agy keeps running). Like the Cursor adapter, we then
 *   copy db + -wal + -shm into a temp directory and open the COPY read-only
 *   — the live file is never written to.
 * - Workspaces come from conversation_summaries.db (one level up from
 *   conversations/); the first file URI is decoded and becomes the project
 *   label.
 *
 * Only metadata is ever read — never step payloads, prompts, code or
 * thinking. No quota windows: Antigravity plan quota is account-side and
 * not visible in local files.
 */

const FLAVORS = ["antigravity", "antigravity-cli"];

// --- data roots -----------------------------------------------------------

function geminiRoot() {
  if (process.env.GEMINI_CLI_HOME && process.env.GEMINI_CLI_HOME.trim()) {
    return path.resolve(expandHome(process.env.GEMINI_CLI_HOME.trim()));
  }
  return path.join(os.homedir(), ".gemini");
}

/**
 * Every readable Antigravity home. The two env overrides pin ONE explicit
 * home each (ANTIGRAVITY_HOME / ANTIGRAVITY_CLI_HOME); without them the
 * adapter scans the Windows defaults AND every WSL distribution (matching
 * BrimDeck's WslLocations.Discover, which reads distributions from the
 * registry and never starts them).
 *
 * The `home` argument is the aggregate root collect.js passes in (the
 * value defaultHome() returned, normally ~/.gemini). Both FLAVORS live
 * directly under it; WSL homes carry .gemini themselves, so they are
 * resolved independently of `home`.
 */
/**
 * Check if a WSL home already syncs Antigravity via its own DoraMonitor peer.
 * When true, scanning \\wsl.localhost from Windows would double-count every
 * WSL record in the merged view and pollute local Windows statistics.
 */
function wslHomeCoveredByPeer(wslHome, opts = {}) {
  if (process.platform !== "win32" && !opts.forcePlatformCheck) return false;
  if (process.env.ANTIGRAVITY_INCLUDE_WSL === "1") return false;
  let winSettings = opts.settings;
  if (winSettings === undefined) {
    try {
      winSettings = loadSettings();
    } catch {
      return false;
    }
  }
  if (!winSettings || !winSettings.sync || !winSettings.sync.enabled) return false;

  const doraDir = path.join(wslHome, ".doramonitor");
  let deviceName = null;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(doraDir, "config.json"), "utf8"));
    if (!cfg || !cfg.sync || !cfg.sync.enabled) return false;
    deviceName = cfg.sync.deviceName ? String(cfg.sync.deviceName).trim() : null;
  } catch {
    return false;
  }
  if (!deviceName) {
    try {
      const st = JSON.parse(fs.readFileSync(path.join(doraDir, "sync.state"), "utf8"));
      if (st && st.device) deviceName = String(st.device).trim();
    } catch {
      /* ignore */
    }
  }
  if (!deviceName) return false;

  const safeName = deviceName.replace(/[^a-zA-Z0-9_-]/g, "_") + ".json";
  const cacheDir = opts.remoteCacheDir || path.join(os.homedir(), ".doramonitor", "remote-cache");
  const peerFile = path.join(cacheDir, safeName);
  try {
    const peer = JSON.parse(fs.readFileSync(peerFile, "utf8"));
    return Boolean(
      peer &&
      peer.days &&
      Object.values(peer.days).some((day) => day && Object.prototype.hasOwnProperty.call(day, "antigravity"))
    );
  } catch {
    return false;
  }
}

function allHomesWithStatus(aggregateHome) {
  const homes = [];
  const appOverride = process.env.ANTIGRAVITY_HOME && process.env.ANTIGRAVITY_HOME.trim();
  const cliOverride = process.env.ANTIGRAVITY_CLI_HOME && process.env.ANTIGRAVITY_CLI_HOME.trim();

  if (appOverride || cliOverride) {
    if (appOverride) homes.push({ home: path.resolve(expandHome(appOverride)), origin: "local" });
    if (cliOverride) homes.push({ home: path.resolve(expandHome(cliOverride)), origin: "local" });
    return { homes, coveredWslHomes: 0 };
  }

  const root = aggregateHome || geminiRoot();
  for (const flavor of FLAVORS) {
    homes.push({ home: path.join(root, flavor), origin: "local" });
  }
  let coveredWslHomes = 0;
  for (const wslHome of wslHomes()) {
    if (wslHomeCoveredByPeer(wslHome)) {
      coveredWslHomes += 1;
      continue;
    }
    for (const flavor of FLAVORS) {
      homes.push({ home: path.join(wslHome, ".gemini", flavor), origin: "wsl" });
    }
  }
  return { homes, coveredWslHomes };
}

function allHomes(aggregateHome) {
  return allHomesWithStatus(aggregateHome).homes;
}

/** Installed WSL distributions, read from the registry (Windows only). */
function wslDistributions() {
  if (process.platform !== "win32") return [];
  try {
    const { execFileSync } = require("child_process");
    // reg.exe lists the subkey names; each holds a DistributionName value.
    const out = execFileSync(
      "reg.exe",
      ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss", "/s", "/v", "DistributionName"],
      { encoding: "utf8", timeout: 10_000, windowsHide: true }
    );
    const names = [];
    for (const m of out.matchAll(/DistributionName\s+REG_SZ\s+(.+)\r?$/gim)) {
      const name = m[1].trim();
      if (name && !/^docker-desktop/i.test(name) && !/^rancher-desktop/i.test(name)) names.push(name);
    }
    return names;
  } catch {
    return [];
  }
}

/** \\wsl.localhost\<distro>\<home> candidates: root plus every /home user. */
function wslHomes() {
  const homes = [];
  for (const distro of wslDistributions()) {
    const distroRoot = `\\\\wsl.localhost\\${distro}`;
    const candidates = [path.join(distroRoot, "root")];
    try {
      const usersDir = path.join(distroRoot, "home");
      for (const ent of fs.readdirSync(usersDir, { withFileTypes: true })) {
        if (ent.isDirectory()) candidates.push(path.join(usersDir, ent.name));
      }
    } catch {
      // A stopped or inaccessible distribution must not break local scanning.
    }
    for (const candidate of candidates) homes.push(candidate);
  }
  return homes;
}

// --- live-database fallback: copy db + -wal + -shm into temp, open the copy ---

const COPIED_DBS = new Map(); // original path -> copied path

function copyForRead(file) {
  let tmp;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "doramonitor-agy-"));
  } catch {
    return null;
  }
  const dst = path.join(tmp, "conversation.db");
  try {
    fs.copyFileSync(file, dst);
    for (const ext of ["-wal", "-shm"]) {
      try {
        fs.copyFileSync(file + ext, dst + ext);
      } catch {
        // No sidecar is fine (checkpointed or closed db).
      }
    }
    COPIED_DBS.set(file, dst);
    return dst;
  } catch {
    return null;
  }
}

/** Open a SQLite db read-only, copying it first when it is locked. */
function openConversation(file) {
  try {
    const db = openReadOnly(file);
    db.prepare("SELECT name FROM sqlite_master LIMIT 1").all();
    return db;
  } catch {
    // fall through to the copy
  }
  const copied = copyForRead(file);
  if (!copied) return null;
  try {
    const db = openReadOnly(copied);
    db.prepare("SELECT name FROM sqlite_master LIMIT 1").all();
    return db;
  } catch {
    return null;
  }
}

function clearCopiedDbs() {
  for (const p of COPIED_DBS.values()) {
    try {
      fs.rmSync(path.dirname(p), { recursive: true, force: true });
    } catch {}
  }
  COPIED_DBS.clear();
}

// --- conversation_summaries.db: conversation_id → first workspace path ---

function readSummaries(dbPath) {
  const out = new Map();
  if (!fs.existsSync(dbPath)) return out;
  // The summaries db of a RUNNING surface (WSL agy) is write-locked too, so
  // it goes through the same copy-then-read fallback as conversation dbs.
  const db = openConversation(dbPath);
  if (!db) return out;
  try {
    const rows = db
      .prepare("SELECT conversation_id, workspace_uris FROM conversation_summaries")
      .all();
    for (const row of rows) {
      const id = String(row.conversation_id || "");
      if (!id) continue;
      out.set(id, { project: firstWorkspacePath(row.workspace_uris) });
    }
  } catch {
    // Schema drift must never break the other tools.
  } finally {
    try {
      db.close();
    } catch {}
  }
  return out;
}

function firstWorkspacePath(workspaceUris) {
  if (!workspaceUris) return null;
  let arr;
  try {
    arr = JSON.parse(String(workspaceUris));
  } catch {
    return null;
  }
  if (!Array.isArray(arr) || !arr.length) return null;
  const uri = String(arr[0] || "");
  const m = /^file:\/\/(?:localhost)?(\/.*)$/i.exec(uri);
  if (!m) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(m[1]);
  } catch {
    decoded = m[1];
  }
  // Windows file URIs arrive as /d%3A/... → /d:/... — strip the leading slash
  // before a drive letter so the project label is a real path.
  return decoded.replace(/^\/([a-zA-Z]:)/, "$1");
}

// --- model naming (ported from BrimDeck's AntigravityUsage.Name) ---

function slug(name) {
  return String(name).trim().toLowerCase().replace(/\s+/g, "-");
}

/**
 * Normalize an Antigravity model to its base display name and pricing key,
 * stripping thinking-level and role suffixes ("(XHigh)", "(High)", "(Medium)",
 * "(Low)", "(Thinking)", "(Orchestrator)") so usage rolls up by base model
 * like every other tool in DoraMonitor.
 *
 * An orchestrated generation names only its role as the response model
 * ("gemini-pro-orchestrator", "gemini-flash-worker-agy"); its display name
 * identifies which model ran and prices it:
 *   "Gemini 4 Hydrogen (High)" → { model: "Gemini 4 Hydrogen", priceKey: "gemini-4-hydrogen" }
 *   "Gemini 4 Carbon (Orchestrator)" → { model: "Gemini 4 Carbon", priceKey: "gemini-4-carbon" }
 *   "Orchestrator (Carbon)" → { model: "Carbon", priceKey: "carbon" }
 */
const KNOWN_DISPLAY_MODEL_RE = /^(?:gemini|claude|gpt|o[134]|deepseek|qwen|kimi|glm|minimax|hy[34])\b/i;
const EFFORT_OR_ROLE_SUFFIX_RE = /\s*\((?:xhigh|high|medium|low|minimal|thinking|orchestrator|worker)\)\s*$/i;
const ORCHESTRATOR_WRAP_RE = /^(?:orchestrator|worker)\s*\(([^()]+)\)$/i;
const RESPONSE_TIER_SUFFIX_RE = /[-_](?:xhigh|high|medium|low|minimal|thinking)$/i;

function stripAntigravityDisplayTier(display) {
  let clean = String(display || "").trim();
  clean = clean.replace(EFFORT_OR_ROLE_SUFFIX_RE, "").trim();
  const wrapped = ORCHESTRATOR_WRAP_RE.exec(clean);
  if (wrapped) clean = wrapped[1].trim();
  return clean;
}

function stripResponseTier(response) {
  return String(response || "")
    .trim()
    .replace(EFFORT_OR_ROLE_SUFFIX_RE, "")
    .replace(RESPONSE_TIER_SUFFIX_RE, "")
    .trim();
}

function resolveModelName(response, display) {
  const rawDisplay = String(display || "").trim();
  const rawResponse = String(response || "").trim();
  const cleanResponse = stripResponseTier(rawResponse);
  if (!rawDisplay) {
    return cleanResponse ? { model: cleanResponse, priceKey: null } : null;
  }
  const cleanDisplay = stripAntigravityDisplayTier(rawDisplay) || cleanResponse || rawDisplay;
  let price = cleanResponse && cleanResponse !== cleanDisplay && cleanResponse !== rawDisplay
    ? cleanResponse
    : null;
  const named = /^(?<outer>[^()]+?)\s*\((?<inner>[^()]+)\)$/.exec(rawDisplay);
  if (named) {
    const outer = named.groups.outer.trim();
    const inner = named.groups.inner.trim();
    if (KNOWN_DISPLAY_MODEL_RE.test(outer)) price = slug(outer);
    else if (KNOWN_DISPLAY_MODEL_RE.test(inner)) price = slug(inner);
    else if (!/\d/.test(outer) && /^[A-Za-z]+$/.test(inner)) price = inner.toLowerCase();
  }
  if (!price && KNOWN_DISPLAY_MODEL_RE.test(cleanDisplay)) {
    price = slug(cleanDisplay);
  }
  return { model: cleanDisplay, priceKey: price };
}

// --- one conversation database ---

function parseConversationDb({ file, conversationId, summary, settings, seen, counters }) {
  const records = [];
  const db = openConversation(file);
  if (!db) {
    counters.errors.push({ file, message: "database is locked or unreadable" });
    return records;
  }
  try {
    // Pass 1: model names from gen_metadata — message-id → name and
    // model-enum → name. A step whose id is absent (condensing checkpoint)
    // is priced by its enum against this conversation's generations.
    const models = new Map(); // message id → { model, priceKey }
    const byEnum = new Map(); // model enum → { model, priceKey }
    let genRows;
    try {
      // CAST forces node:sqlite to return BLOB columns as bytes (Buffer)
      // instead of a lossy text decode that can never be turned back into
      // the original protobuf bytes.
      genRows = db.prepare("SELECT CAST(data AS BLOB) AS data FROM gen_metadata WHERE data IS NOT NULL").all();
    } catch {
      genRows = [];
    }
    for (const row of genRows) {
      const chat = dataField(row.data, 1);
      if (!chat) continue;
      const usage = dataField(chat, 4);
      const idBuf = usage ? dataField(usage, 7) : null;
      const response = textOf(dataField(chat, 19));
      const display = textOf(dataField(chat, 21));
      const name = resolveModelName(response, display);
      if (!name) continue;
      if (idBuf && idBuf.length) models.set(textOf(idBuf), name);
      if (usage) {
        const enumVal = varintField(usage, 1);
        if (enumVal != null && !byEnum.has(Number(enumVal))) byEnum.set(Number(enumVal), name);
      }
    }

    // Pass 2: per-step usage.
    let stepRows;
    try {
      stepRows = db.prepare("SELECT CAST(metadata AS BLOB) AS metadata FROM steps WHERE metadata IS NOT NULL").all();
    } catch {
      stepRows = [];
    }
    for (const row of stepRows) {
      counters.lines += 1;
      const metadata = row.metadata;
      if (!metadata || !metadata.length) continue;
      const usageBuf = dataField(metadata, 9);
      if (!usageBuf) continue;
      const idBuf = dataField(usageBuf, 7);
      if (!idBuf || !idBuf.length) continue;
      const messageId = textOf(idBuf);
      const createdAtBuf = dataField(metadata, 1);
      const time = createdAtBuf ? timestampMs(createdAtBuf) : 0;

      const modelEnum = varintField(usageBuf, 1);
      const name =
        models.get(messageId) ||
        (modelEnum != null ? byEnum.get(Number(modelEnum)) : null) ||
        null;

      const inputOther = count(usageBuf, 2);
      const output = count(usageBuf, 3);
      const cacheWrite = count(usageBuf, 4);
      const cacheRead = count(usageBuf, 5);
      // All-zero steps are non-billing checkpoints — drop before dedup so a
      // zero placeholder can never swallow a real duplicate below.
      if (inputOther + output + cacheWrite + cacheRead <= 0) continue;

      const dedupKey = messageId;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      const rec = emptyRecord("antigravity");
      rec.time = time;
      // Both display name and priceKey strip thinking-level/role suffixes so
      // usage aggregates under the base model cleanly across all efforts.
      rec.model = name ? name.model : "unknown";
      rec.modelDisplay = name ? name.model : "unknown";
      rec.modelResolved = name && name.priceKey ? name.priceKey : rec.model;
      rec.inputOther = inputOther;
      rec.output = output;
      rec.inputCacheRead = cacheRead;
      rec.inputCacheCreation = cacheWrite;
      const cost = costForUsage(rec.modelResolved || rec.model, rec, { settings });
      rec.costCny = cost.total;
      rec.costEstimated = cost.estimated;
      rec.priceId = cost.priceId;
      rec.project = summary ? summary.project : null;
      rec.session = conversationId;
      rec.sessionHint = { session: conversationId, project: rec.project };
      records.push(rec);
    }
  } catch (err) {
    counters.errors.push({ file, message: String(err && err.message ? err.message : err) });
  } finally {
    try {
      db.close();
    } catch {}
  }
  return records;
}

function textOf(buf) {
  // node:sqlite returns Uint8Array (not Buffer); its toString() would give
  // "104,101,108,..." instead of the decoded text, so decode explicitly.
  if (!buf || !buf.length) return "";
  return Buffer.from(buf.buffer || buf, buf.byteOffset || 0, buf.length).toString("utf8");
}

function count(buf, field) {
  const v = varintField(buf, field);
  if (v == null) return 0;
  const num = Number(v);
  return Number.isFinite(num) && num > 0 ? num : 0;
}

function conversationFiles(home) {
  const dir = path.join(home, "conversations");
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const ent of entries) {
    if (ent.isFile() && ent.name.endsWith(".db")) {
      out.push({ conversationId: ent.name.slice(0, -3), file: path.join(dir, ent.name) });
    }
  }
  return out;
}

const tool = {
  id: "antigravity",
  label: "Antigravity",

  defaultHome() {
    return geminiRoot();
  },

  isAvailable(home) {
    return allHomes(home).some(({ home: h }) => fs.existsSync(path.join(h, "conversations")));
  },

  isPeerCovered(home) {
    return allHomesWithStatus(home).coveredWslHomes > 0;
  },

  /** stat probes for incremental collection across EVERY data root (incl. active WALs & summaries). */
  sourceFiles(home) {
    const out = [];
    for (const { home: h } of allHomes(home)) {
      for (const item of conversationFiles(h)) {
        out.push(item.file);
        if (fs.existsSync(item.file + "-wal")) out.push(item.file + "-wal");
      }
      const sumDb = path.join(h, "conversation_summaries.db");
      if (fs.existsSync(sumDb)) out.push(sumDb);
      if (fs.existsSync(sumDb + "-wal")) out.push(sumDb + "-wal");
    }
    return out;
  },

  clearCache() {
    clearCopiedDbs();
  },

  scan(home) {
    const records = [];
    const counters = { lines: 0, errors: [] };
    const seen = new Set();
    const settings = (() => {
      try {
        return loadSettings();
      } catch {
        return null;
      }
    })();

    let filesScanned = 0;
    const { homes, coveredWslHomes } = allHomesWithStatus(home);
    const roots = homes.filter(({ home: h }) => fs.existsSync(path.join(h, "conversations")));
    try {
      for (const { home: h } of roots) {
        const summaries = readSummaries(path.join(h, "conversation_summaries.db"));
        for (const item of conversationFiles(h)) {
          filesScanned += 1;
          const summary = summaries.get(item.conversationId) || null;
          records.push(
            ...parseConversationDb({
              ...item,
              summary,
              settings,
              seen,
              counters,
            })
          );
        }
      }
    } finally {
      clearCopiedDbs();
    }
    records.sort((a, b) => b.time - a.time);
    return {
      records,
      meta: {
        filesScanned,
        filesReread: filesScanned,
        linesSeen: counters.lines,
        recordCount: records.length,
        roots: roots.map((r) => r.home),
        peerCoveredWsl: coveredWslHomes > 0,
        errors: counters.errors.slice(0, 20),
      },
    };
  },
};

module.exports = tool;
module.exports.wslHomeCoveredByPeer = wslHomeCoveredByPeer;
module.exports.resolveModelName = resolveModelName;
