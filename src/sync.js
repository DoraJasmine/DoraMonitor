"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const crypto = require("crypto");
const { randomUUID } = require("crypto");
const { normalizeQuotaRecord } = require("./quota-schema");
const { normalizeWorkspace } = require("./workspaces");

/**
 * Cross-device usage sync.
 *
 * Each device maintains ONE summary file and uploads it to a shared backend
 * (SSH/SCP, WebDAV or a local shared directory). Daily buckets power the dashboard; minute Token bins
 * and quota milestones power capacity estimation:
 *
 *   {version, device, generatedAt, updatedRange, codexQuota, quotaUsage,
 *    quotaSamples, usageWaterMark, days: {
 *     "YYYY-MM-DD": { "<tool>": { "<model>": {i,o,cr,cc,cs?,cl?,req,credits} } }
 *   }}
 *
 * Daily granularity lets the dashboard aggregate any range (today / 7d /
 * 30d / all) from peers, not just the billing month. Peers' files are
 * cached under ~/.doramonitor/remote-cache/ so the dashboard keeps
 * working offline; a failed sync degrades to cached data with a status note.
 */

const SUMMARY_VERSION = 4; // v4: wsDaily gains a tool level (day → tool → hashed ws → cell)
const REMOTE_DIR = "ai-usage-monitor"; // keep: remote sync dir shared with other devices
const CACHE_DIR = path.join(".doramonitor", "remote-cache");

// ---------------------------------------------------------------------------
// Summary build / merge
// ---------------------------------------------------------------------------

function dayKey(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function buildQuotaUsage(records) {
  const bins = new Map();
  for (const r of records || []) {
    if (!r || !r.time || r.kind === "event") continue;
    const start = Math.floor(r.time / 60_000) * 60_000;
    const tool = r.tool || "unknown";
    const model = r.model || "unknown";
    const modelResolved = r.modelResolved || model;
    const modelProvider = r.modelProvider || null;
    const key = [start, tool, model, modelResolved, modelProvider].join("\0");
    if (!bins.has(key)) {
      bins.set(key, { start: new Date(start).toISOString(), tool, model, modelResolved, modelProvider, i: 0, o: 0, cr: 0, cc: 0, c: 0, req: 0 });
    }
    const bucket = bins.get(key);
    bucket.i += r.inputOther || 0;
    bucket.o += r.output || 0;
    bucket.cr += r.inputCacheRead || 0;
    bucket.cc += r.inputCacheCreation || 0;
    if (r.inputCacheCreationShort != null || r.inputCacheCreationLong != null) {
      bucket.cs = (bucket.cs || 0) + (r.inputCacheCreationShort || 0);
      bucket.cl = (bucket.cl || 0) + (r.inputCacheCreationLong || 0);
    }
    bucket.c += Number(r.costCny) || 0;
    bucket.req += 1;
  }
  return [...bins.values()];
}

function quotaSamplesForSync(samples, now = Date.now()) {
  const cutoff = now - 35 * 86_400_000;
  const previous = new Map();
  return (samples || []).map((sample) => normalizeQuotaRecord(sample, { includeLegacy: true })).filter((sample) => {
    const time = Date.parse(sample.sampledAt || "");
    if (!Number.isFinite(time) || time < cutoff) return false;
    if (sample.source === "manual-calibration") return true;
    const key = [sample.provider, sample.accountKey, sample.window].join("\0");
    const before = previous.get(key);
    previous.set(key, sample);
    return !before || before.usedPercent !== sample.usedPercent || before.resetsAt !== sample.resetsAt;
  });
}

// ---------------------------------------------------------------------------
// Workspace dimension (FP-06): workspace keys are hashed with a shared salt
// before leaving the device — real paths/names never enter the sync channel.
// Reserved keys (__unknown__/__legacy__) travel as literal slots so the
// receiving side can label them. The salt rides inside every summary; a
// device that sees a peer salt adopts it, so all devices converge on one
// salt within a sync cycle.
// ---------------------------------------------------------------------------

const WS_SALT_FILE = path.join(os.homedir(), ".doramonitor", "ws-salt");

function readWsSalt() {
  try {
    const salt = fs.readFileSync(WS_SALT_FILE, "utf8").trim();
    return /^[0-9a-f]{32}$/.test(salt) ? salt : null;
  } catch {
    return null;
  }
}

function writeWsSalt(salt) {
  try {
    fs.mkdirSync(path.dirname(WS_SALT_FILE), { recursive: true });
    const tmp = `${WS_SALT_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, salt, "utf8");
    fs.renameSync(tmp, WS_SALT_FILE);
  } catch {
    /* best effort — next sync retries */
  }
}

function wsHash(workspaceKey, salt) {
  // Reserved slots travel as clean literals so the receiving side can label them.
  if (workspaceKey === "__unknown__") return "unknown";
  if (workspaceKey === "__legacy__") return "legacy";
  if (workspaceKey.startsWith("__")) return workspaceKey.slice(2);
  return crypto.createHmac("sha256", salt).update(workspaceKey).digest("hex").slice(0, 16);
}

/** Daily per-workspace token totals, workspace keys hashed with the salt. */
function buildWsDaily(records, salt) {
  if (!salt) return null;
  const homes = new Map();
  try {
    for (const t of require("./tools").listTools()) homes.set(t.id, t.home);
  } catch {
    /* homeless tools normalize without wd_* mapping */
  }
  const wsDaily = {};
  const wsNames = {};
  for (const r of records || []) {
    if (!r || !r.time || r.kind === "event") continue;
    const ws = normalizeWorkspace(r.tool, r, homes.get(r.tool) || null);
    const slot = wsHash(ws.workspaceKey, salt);
    if (ws.workspaceKey && !ws.workspaceKey.startsWith("__")) wsNames[slot] = ws.workspaceKey;
    const day = dayKey(r.time);
    if (!wsDaily[day]) wsDaily[day] = {};
    if (!wsDaily[day][r.tool]) wsDaily[day][r.tool] = {};
    const cell = wsDaily[day][r.tool][slot] || (wsDaily[day][r.tool][slot] = { i: 0, o: 0, cr: 0, cc: 0, req: 0, credits: 0 });
    cell.i += r.inputOther || 0;
    cell.o += r.output || 0;
    cell.cr += r.inputCacheRead || 0;
    cell.cc += r.inputCacheCreation || 0;
    cell.req += Number.isFinite(Number(r.requests)) && Number(r.requests) >= 0 ? Number(r.requests) : 1;
    cell.credits += r.credits || 0;
  }
  return { wsDaily, wsNames };
}

/** Build the device summary from local usage records. */
function buildSummary(deviceName, records, codexQuota = null, quotaSamples = [], deviceId = null, wsSalt = null) {
  const days = {};
  let earliest = null;
  let latest = null;
  for (const r of records) {
    if (!r || !r.time) continue;
    if (r.kind === "event") continue;
    const key = dayKey(r.time);
    if (earliest === null || key < earliest) earliest = key;
    if (latest === null || key > latest) latest = key;
    const tool = r.tool || "unknown";
    const model = r.model || "unknown";
    if (!days[key]) days[key] = {};
    if (!days[key][tool]) days[key][tool] = {};
    const bucket = days[key][tool][model] || (days[key][tool][model] = { i: 0, o: 0, cr: 0, cc: 0, req: 0, credits: 0 });
    bucket.i += r.inputOther || 0;
    bucket.o += r.output || 0;
    bucket.cr += r.inputCacheRead || 0;
    bucket.cc += r.inputCacheCreation || 0;
    if (r.inputCacheCreationShort != null || r.inputCacheCreationLong != null) {
      bucket.cs = (bucket.cs || 0) + (r.inputCacheCreationShort || 0);
      bucket.cl = (bucket.cl || 0) + (r.inputCacheCreationLong || 0);
    }
    bucket.req += 1;
    bucket.credits += r.credits || 0;
  }
  const summary = {
    version: SUMMARY_VERSION,
    device: deviceName,
    generatedAt: new Date().toISOString(),
    usageWaterMark: new Date().toISOString(),
    updatedRange: earliest ? { start: earliest, end: latest } : null,
    days,
    quotaUsage: buildQuotaUsage(records),
    quotaSamples: Array.isArray(quotaSamples) ? quotaSamples : [],
  };
  const wsDaily = buildWsDaily(records, wsSalt);
  if (wsDaily) {
    summary.wsDaily = wsDaily.wsDaily;
    summary.wsNames = wsDaily.wsNames;
    summary.wsSalt = wsSalt;
  }
  if (codexQuota && codexQuota.available) summary.codexQuota = codexQuota;
  if (deviceId) summary.deviceId = deviceId;
  return summary;
}

function normalizePeerSummary(summary) {
  if (!summary || !Array.isArray(summary.quotaSamples)) return summary;
  const quotaSamples = [];
  for (const sample of summary.quotaSamples) {
    try {
      quotaSamples.push(normalizeQuotaRecord(sample, { includeLegacy: true, strict: true }));
    } catch {
      // A conflicting sample is isolated without rejecting the whole peer summary.
    }
  }
  return { ...summary, quotaSamples };
}

function quotaUsageRecords(summary) {
  const device = String(summary && summary.device || "peer");
  return (Array.isArray(summary && summary.quotaUsage) ? summary.quotaUsage : []).map((b) => ({
    tool: b.tool,
    time: Date.parse(b.start) || 0,
    model: b.model,
    modelResolved: b.modelResolved || b.model,
    modelProvider: b.modelProvider || null,
    inputOther: b.i || 0,
    output: b.o || 0,
    inputCacheRead: b.cr || 0,
    inputCacheCreation: b.cc || 0,
    inputCacheCreationShort: b.cs ?? null,
    inputCacheCreationLong: b.cl ?? null,
    costCny: Number(b.c) || 0,
    device,
    peer: true,
  }));
}

/**
 * Merge peer summaries into synthetic records (device-attributed, day
 * precision). Costs are computed here with the local pricing settings so
 * peer tokens carry real cost figures like local records do.
 */
function summaryToRecords(summary) {
  const records = [];
  let settings = null;
  try {
    settings = require("./settings").loadSettings();
  } catch {
    settings = null;
  }
  const { costForUsage } = require("./pricing");
  const device = String(summary.device || "peer");
  const days = summary.days || {};
  for (const day of Object.keys(days)) {
    // Noon of that day (local) — day granularity is the sync resolution.
    const [y, m, d] = day.split("-").map(Number);
    const time = new Date(y, m - 1, d, 12, 0, 0).getTime();
    const dayEntry = days[day] || {};
    for (const tool of Object.keys(dayEntry)) {
      const models = dayEntry[tool] || {};
      for (const model of Object.keys(models)) {
        const b = models[model] || {};
        const cost = costForUsage(model, {
          inputOther: b.i || 0,
          output: b.o || 0,
          inputCacheRead: b.cr || 0,
          inputCacheCreation: b.cc || 0,
          inputCacheCreationShort: b.cs ?? null,
          inputCacheCreationLong: b.cl ?? null,
        }, { settings });
        records.push({
          tool,
          time,
          model,
          modelDisplay: model,
          modelResolved: model,
          inputOther: b.i || 0,
          output: b.o || 0,
          inputCacheRead: b.cr || 0,
          inputCacheCreation: b.cc || 0,
          inputCacheCreationShort: b.cs ?? null,
          inputCacheCreationLong: b.cl ?? null,
          // A peer summary collapses a day/model into one synthetic record;
          // retain its source request count so aggregate statistics do not
          // misleadingly display it as a single request.
          requests: Number.isFinite(Number(b.req)) && Number(b.req) >= 0 ? Number(b.req) : 1,
          costCny: b.credits > 0 ? 0 : cost.total,
          costEstimated: cost.estimated,
          priceId: cost.priceId,
          credits: b.credits || 0,
          project: null,
          session: null,
          sessionHint: null,
          device,
          peer: true,
        });
      }
    }
  }
  return records;
}

// ---------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------

function whichOptional(bin) {
  try {
    if (process.platform === "win32") {
      // `where` replaces `which` on Windows; fall back to the bundled
      // System32\OpenSSH client location.
      try {
        const out = execFileSync("where", [bin], { encoding: "utf8", timeout: 5000 });
        const first = out.trim().split(/\r?\n/)[0].trim();
        if (first) return first;
      } catch {
        // fall through to static location
      }
      const bundled = `C:\\Windows\\System32\\OpenSSH\\${bin}.exe`;
      return fs.existsSync(bundled) ? bundled : null;
    }
    const out = execFileSync("which", [bin], { encoding: "utf8", timeout: 5000 });
    const p = out.trim().split("\n")[0];
    return p || null;
  } catch {
    return null;
  }
}

function sshBaseArgs(sshCfg) {
  const args = [];
  const port = Number(sshCfg.port) || 22;
  if (port !== 22) args.push("-p", String(port));
  const identity = sshCfg.identityFile;
  if (identity) args.push("-i", String(identity).replace(/^~/, os.homedir()));
  args.push(
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "StrictHostKeyChecking=accept-new"
  );
  return args;
}

function sshRemote(sshCfg) {
  const host = String(sshCfg.host || "");
  const user = sshCfg.user ? `${sshCfg.user}@` : "";
  return `${user}${host}`;
}

/**
 * Resolve the remote base dir for scp/ssh paths.
 *
 * A leading "~" MUST be expanded against the REMOTE host's home, never the
 * local one — on Windows os.homedir() returns C:\Users\<user>, and shipping
 * that into a Linux scp target fails with "No such file or directory".
 * We query $HOME over the (already key-authenticated) ssh connection.
 */
function resolveRemoteBase(sshCfg, host) {
  const rp = String(sshCfg.remotePath || `~/${REMOTE_DIR}`);
  if (!rp.startsWith("~")) return rp;
  const ssh = whichOptional("ssh");
  if (!ssh) return rp;
  try {
    const out = execFileSync(
      ssh,
      [...sshBaseArgs(sshCfg), host, "printf %s $HOME"],
      { encoding: "utf8", timeout: 15000 }
    );
    const home = out.trim();
    if (home) return home + rp.slice(1);
  } catch {
    // fall back to the raw ~ path (POSIX remote shells expand it)
  }
  return rp;
}

function syncViaSsh(summary, cfg) {
  const sshCfg = cfg.ssh || {};
  const host = sshRemote(sshCfg);
  if (!host) return { ok: false, reason: "ssh host not configured" };
  const scp = whichOptional("scp");
  const ssh = whichOptional("ssh");
  if (!scp || !ssh) return { ok: false, reason: "ssh/scp not installed" };

  const base = resolveRemoteBase(sshCfg, host);
  const remoteDir = `${base}/${REMOTE_DIR}`;
  const remoteFile = `${remoteDir}/${summary.device}.json`;

  try {
    execFileSync(ssh, [...sshBaseArgs(sshCfg), host, `mkdir -p ${remoteDir}`], { timeout: 30000 });
    const tmp = path.join(os.tmpdir(), `dora-sync-${process.pid}.json`);
    fs.writeFileSync(tmp, JSON.stringify(summary, null, 1), "utf8");
    try {
      execFileSync(scp, [...sshBaseArgs(sshCfg), tmp, `${host}:${remoteFile}`], { timeout: 60000 });
    } finally {
      fs.unlinkSync(tmp);
    }
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err).slice(0, 200) };
  }
  return { ok: true, remoteFile };
}

function listPeerSummariesViaSsh(cfg) {
  const sshCfg = cfg.ssh || {};
  const host = sshRemote(sshCfg);
  if (!host) return { ok: false, reason: "ssh host not configured", peers: [] };
  const ssh = whichOptional("ssh");
  const scp = whichOptional("scp");
  if (!ssh || !scp) return { ok: false, reason: "ssh/scp not installed", peers: [] };

  const base = resolveRemoteBase(sshCfg, host);
  const remoteDir = `${base}/${REMOTE_DIR}`;
  let device = cfg.deviceName || os.hostname().replace(/[^a-zA-Z0-9_-]/g, "_");

  let listing;
  try {
    listing = execFileSync(
      ssh,
      [...sshBaseArgs(sshCfg), host, `ls -1 ${remoteDir}/*.json 2>/dev/null`],
      { encoding: "utf8", timeout: 30000 }
    );
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err).slice(0, 200), peers: [] };
  }

  const files = listing.split("\n").map((s) => s.trim()).filter(Boolean);
  const peers = [];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dora-peers-"));
  try {
    for (const remotePath of files) {
      const name = path.basename(remotePath);
      const peerDevice = name.replace(/\.json$/, "");
      if (peerDevice === device) continue;
      const localPath = path.join(tmpDir, name);
      try {
        execFileSync(scp, [...sshBaseArgs(sshCfg), `${host}:${remotePath}`, localPath], { timeout: 60000 });
        const data = JSON.parse(fs.readFileSync(localPath, "utf8"));
        if (data && typeof data === "object" && data.days) peers.push(normalizePeerSummary(data));
      } catch {
        // one broken peer file must not break the rest
      }
    }
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // temp cleanup best-effort
    }
  }
  return { ok: true, peers };
}

function webdavRequest(cfg, method, relPath, body) {
  const w = cfg.webdav || {};
  const base = String(w.url || "").replace(/\/+$/, "");
  if (!base) return { status: 0 };
  const url = `${base}/${relPath.replace(/^\/+/, "")}`;
  const headers = {};
  if (w.username) {
    headers.Authorization = `Basic ${Buffer.from(`${w.username}:${w.password || ""}`).toString("base64")}`;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  return fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : body,
    signal: controller.signal,
  })
    .then((r) => r.text().then((text) => ({ status: r.status, text })))
    .catch((err) => ({ status: 0, error: String((err && err.message) || err) }))
    .finally(() => clearTimeout(timer));
}

async function syncViaWebdav(summary, cfg) {
  const mk = await webdavRequest(cfg, "MKCOL", REMOTE_DIR);
  if (mk.status && ![201, 204, 405].includes(mk.status)) {
    return { ok: false, reason: `webdav mkcol ${mk.status}` };
  }
  const put = await webdavRequest(cfg, "PUT", `${REMOTE_DIR}/${summary.device}.json`, JSON.stringify(summary, null, 1));
  if (!put.status || ![200, 201, 204].includes(put.status)) {
    return { ok: false, reason: `webdav put ${put.status || put.error}` };
  }
  return { ok: true };
}

async function listPeerSummariesViaWebdav(cfg) {
  const device = cfg.deviceName || os.hostname().replace(/[^a-zA-Z0-9_-]/g, "_");
  const propfind = await webdavRequest(cfg, "PROPFIND", REMOTE_DIR, '<?xml version="1.0"?><propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>');
  if (!propfind.status || ![200, 207].includes(propfind.status)) {
    return { ok: false, reason: `webdav propfind ${propfind.status || propfind.error}`, peers: [] };
  }
  const names = [...String(propfind.text || "").matchAll(/<D?:?href[^>]*>([^<]+)<\/D?:?href>/gi)]
    .map((m) => decodeURIComponent(m[1] || ""))
    .map((href) => href.split("/").filter(Boolean).pop())
    .filter((n) => n && n.endsWith(".json"));
  const peers = [];
  for (const name of names) {
    if (name === `${device}.json`) continue;
    const get = await webdavRequest(cfg, "GET", `${REMOTE_DIR}/${name}`);
    if (get.status !== 200) continue;
    try {
      const data = JSON.parse(get.text);
      if (data && data.days) peers.push(normalizePeerSummary(data));
    } catch {
      // skip broken peer file
    }
  }
  return { ok: true, peers };
}

function localDirectory(cfg) {
  const configured = String(cfg.local && cfg.local.path || "").trim();
  if (!configured) return { error: "local path not configured" };
  const expanded = configured === "~"
    ? os.homedir()
    : configured.replace(/^~[\\/]/, `${os.homedir()}${path.sep}`);
  if (!path.isAbsolute(expanded)) return { error: "local path must be absolute" };
  return { dir: path.join(path.resolve(expanded), REMOTE_DIR) };
}

function localDeviceId() {
  const dir = path.join(os.homedir(), ".doramonitor");
  const file = path.join(dir, "device-id");
  try {
    const id = fs.readFileSync(file, "utf8").trim();
    if (id) return id;
  } catch {
    // Create this installation's identity below.
  }
  fs.mkdirSync(dir, { recursive: true });
  const id = randomUUID();
  try {
    fs.writeFileSync(file, id + "\n", { encoding: "utf8", flag: "wx" });
    return id;
  } catch (err) {
    if (!err || err.code !== "EEXIST") throw err;
    return fs.readFileSync(file, "utf8").trim();
  }
}

function localDeviceFile(device) {
  return String(device).replace(/[^a-zA-Z0-9_-]/g, "_") + ".json";
}

function hasDuplicateLocalDevice(dir, summary) {
  const ownPath = path.join(dir, localDeviceFile(summary.device));
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      if (file === ownPath) return true;
      continue;
    }
    if (!data || data.device !== summary.device) continue;
    if (data.deviceId && summary.deviceId && data.deviceId === summary.deviceId) continue;
    return true;
  }
  return false;
}

function acquireLocalLock(file) {
  try {
    return fs.openSync(file, "wx");
  } catch (err) {
    if (!err || err.code !== "EEXIST") throw err;
    const age = Date.now() - fs.statSync(file).mtimeMs;
    if (age < 60_000) return null;
    fs.rmSync(file, { force: true });
    return fs.openSync(file, "wx");
  }
}

function syncViaLocal(summary, cfg) {
  const target = localDirectory(cfg);
  if (target.error) return { ok: false, reason: target.error };
  if (!summary.deviceId) return { ok: false, reason: "device identity unavailable" };
  const tmp = path.join(target.dir, `.${summary.deviceId}.${process.pid}.${randomUUID()}.tmp`);
  const lock = path.join(target.dir, `.${localDeviceFile(summary.device)}.lock`);
  let lockHandle;
  try {
    fs.mkdirSync(target.dir, { recursive: true });
    lockHandle = acquireLocalLock(lock);
    if (lockHandle === null) return { ok: false, reason: "device_sync_in_progress" };
    if (hasDuplicateLocalDevice(target.dir, summary)) return { ok: false, reason: "duplicate_device_name" };
    fs.writeFileSync(tmp, JSON.stringify(summary, null, 1), "utf8");
    fs.renameSync(tmp, path.join(target.dir, localDeviceFile(summary.device)));
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err).slice(0, 200) };
  } finally {
    if (lockHandle !== undefined && lockHandle !== null) {
      try {
        fs.closeSync(lockHandle);
        fs.rmSync(lock, { force: true });
      } catch {
        // lock cleanup best-effort; stale locks expire after one minute
      }
    }
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // temp cleanup best-effort
    }
  }
}

function listPeerSummariesViaLocal(cfg, deviceId) {
  const target = localDirectory(cfg);
  if (target.error) return { ok: false, reason: target.error, peers: [] };
  const device = cfg.deviceName || os.hostname().replace(/[^a-zA-Z0-9_-]/g, "_");
  try {
    if (hasDuplicateLocalDevice(target.dir, { device, deviceId })) {
      return { ok: false, reason: "duplicate_device_name", peers: [] };
    }
    const peers = [];
    for (const name of fs.readdirSync(target.dir)) {
      if (!name.endsWith(".json") || name === localDeviceFile(device)) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(target.dir, name), "utf8"));
        if (data && data.device === device) continue;
        if (data && typeof data === "object" && data.days) peers.push(normalizePeerSummary(data));
      } catch {
        // one broken peer file must not break the rest
      }
    }
    return { ok: true, peers };
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err).slice(0, 200), peers: [] };
  }
}

// ---------------------------------------------------------------------------
// Cache + orchestration
// ---------------------------------------------------------------------------

function cacheDir() {
  return path.join(os.homedir(), CACHE_DIR);
}

function savePeersToCache(peers) {
  try {
    fs.mkdirSync(cacheDir(), { recursive: true });
    for (const p of peers) {
      if (!p || !p.device) continue;
      const safe = String(p.device).replace(/[^a-zA-Z0-9_-]/g, "_");
      fs.writeFileSync(path.join(cacheDir(), `${safe}.json`), JSON.stringify(p, null, 1), "utf8");
    }
  } catch {
    // cache write failure is non-fatal
  }
}

function loadCachedPeers() {
  const peers = [];
  try {
    for (const name of fs.readdirSync(cacheDir())) {
      if (!name.endsWith(".json")) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(cacheDir(), name), "utf8"));
        if (data && data.days) peers.push(normalizePeerSummary(data));
      } catch {
        // skip broken cache file
      }
    }
  } catch {
    // no cache yet
  }
  return peers;
}

function syncStatePath() {
  return path.join(os.homedir(), ".doramonitor", "sync.state");
}

function readSyncState(file = syncStatePath()) {
  try {
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    return state && typeof state === "object" && !Array.isArray(state) ? state : null;
  } catch {
    return null;
  }
}

function recordSyncState(result, file = syncStatePath(), now = new Date()) {
  try {
    const previous = readSyncState(file) || {};
    const attemptedAt = now.toISOString();
    const state = {
      lastAttemptAt: attemptedAt,
      lastSync: result.uploaded ? attemptedAt : previous.lastSync || null,
      uploaded: result.uploaded === true,
      downloaded: result.downloaded === true,
      uploadError: result.uploadError || null,
      error: result.error || null,
      fromCache: result.fromCache === true,
      peers: (result.peers || []).length,
      peerNames: (result.peers || []).map((peer) => peer.device).filter(Boolean),
      device: result.device || null,
      backend: result.backend || null,
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(state)}\n`, "utf8");
    fs.renameSync(temporary, file);
  } catch {
    // Status persistence must never turn a completed sync into a failure.
  }
}

function syncConfigured(settings) {
  const cfg = settings?.sync || {};
  if (!cfg.enabled) return false;
  if (cfg.backend === "local") return Boolean(cfg.local?.path?.trim());
  if (cfg.backend === "ssh") return Boolean(cfg.ssh?.host?.trim());
  if (cfg.backend === "webdav") return Boolean(cfg.webdav?.url?.trim());
  return false;
}

/**
 * Run a full sync: upload local summary, download peers, refresh cache.
 * records: local usage records (from collect).
 * Returns { enabled, uploaded, downloaded, peers, fromCache, error }.
 */
async function runSync(records, settings, codexQuota = null) {
  const cfg = settings.sync || {};
  if (!cfg.enabled) {
    return { enabled: false, peers: [], fromCache: false };
  }
  const deviceName = cfg.deviceName || os.hostname().replace(/[^a-zA-Z0-9_-]/g, "_");
  let deviceId = null;
  try {
    deviceId = localDeviceId();
  } catch {
    // Local sync reports the missing identity; existing backends stay compatible.
  }
  const { readSamples } = require("./quota-estimator-store");
  // Salt bootstrap: local → cached peer salt → generate. A differing peer
  // salt (fetched below) is adopted after the run; the next cycle re-uploads
  // with it, so all devices converge on one salt.
  let wsSalt = readWsSalt();
  if (!wsSalt) {
    for (const peer of loadCachedPeers()) {
      if (peer.wsSalt && /^[0-9a-f]{32}$/.test(peer.wsSalt)) {
        wsSalt = peer.wsSalt;
        break;
      }
    }
  }
  if (!wsSalt) {
    wsSalt = crypto.randomBytes(16).toString("hex");
  }
  writeWsSalt(wsSalt);
  const summary = buildSummary(deviceName, records, codexQuota, quotaSamplesForSync(readSamples()), deviceId, wsSalt);

  let uploaded = false;
  let uploadError = null;
  let fetched = { ok: false, peers: [], reason: "unknown" };

  try {
    if (cfg.backend === "ssh") {
      [uploaded, fetched] = await Promise.all([
        Promise.resolve(syncViaSsh(summary, cfg)),
        Promise.resolve(listPeerSummariesViaSsh(cfg)),
      ]);
      uploadError = uploaded.ok ? null : uploaded.reason;
    } else if (cfg.backend === "webdav") {
      const [up, list] = await Promise.all([syncViaWebdav(summary, cfg), listPeerSummariesViaWebdav(cfg)]);
      uploaded = up;
      fetched = list;
      uploadError = up.ok ? null : up.reason;
    } else if (cfg.backend === "local") {
      uploaded = syncViaLocal(summary, cfg);
      uploadError = uploaded.ok ? null : uploaded.reason;
      fetched = uploadError === "duplicate_device_name"
        ? { ok: false, peers: [], reason: uploadError }
        : listPeerSummariesViaLocal(cfg, deviceId);
    } else {
      uploadError = `unknown backend: ${cfg.backend}`;
    }
  } catch (err) {
    uploadError = String((err && err.message) || err).slice(0, 200);
  }

  const fromCache = !fetched.ok;
  const peers = fetched.ok ? fetched.peers : loadCachedPeers();
  if (fetched.ok) savePeersToCache(peers);
  // Converge on one workspace salt across devices.
  for (const peer of peers) {
    if (peer.wsSalt && /^[0-9a-f]{32}$/.test(peer.wsSalt) && peer.wsSalt !== wsSalt) {
      wsSalt = peer.wsSalt;
      writeWsSalt(wsSalt);
      break;
    }
  }

  const result = {
    enabled: true,
    device: deviceName,
    backend: cfg.backend,
    uploaded: uploaded.ok === true,
    uploadError,
    downloaded: fetched.ok,
    peers,
    fromCache,
    error: fetched.ok ? null : fetched.reason,
  };
  recordSyncState(result);
  return result;
}

/**
 * Peer records for the dashboard: fresh cache when present, so requests
 * never block on the network. Use runSync() to refresh the cache.
 */
function peerRecordsCached() {
  const records = [];
  for (const peer of loadCachedPeers()) {
    records.push(...summaryToRecords(peer));
  }
  return records;
}

/**
 * Per-workspace daily totals from cached peer summaries (FP-06). Keys are
 * "peer:<hash>" slots (reserved keys surface as "peer:unknown" etc.).
 * device: "all" (every peer combined) or one peer device name.
 */
function peerWorkspaceSummaries(device = "all") {
  const map = new Map();
  for (const peer of loadCachedPeers()) {
    if (!peer || !peer.wsDaily) continue;
    if (device !== "all" && String(peer.device || "") !== String(device)) continue;
    const peerDevice = String(peer.device || "peer");
    const nested = Number(peer.version) >= 4; // v4: day → tool → slot;v3: day → slot
    for (const [day, buckets] of Object.entries(peer.wsDaily || {})) {
      for (const [toolOrSlot, level] of Object.entries(buckets || {})) {
        const entries = nested
          ? Object.entries(level || {}).map(([slot, cell]) => [slot, toolOrSlot, cell])
          : [["__peer__", toolOrSlot, level]];
        for (const [slot, tool, cell] of entries) {
          const key = `peer:${slot}`;
          if (!map.has(key)) {
            map.set(key, { key, workspaceKey: key, devices: new Set(), daily: {}, tools: new Map(), totalTokens: 0, requests: 0, credits: 0 });
          }
          const row = map.get(key);
          row.devices.add(peerDevice);
          if (!row.wsName && peer.wsNames && peer.wsNames[slot]) row.wsName = peer.wsNames[slot];
          const d = row.daily[day] || (row.daily[day] = { i: 0, o: 0, cr: 0, cc: 0, req: 0, credits: 0 });
          d.i += cell.i || 0;
          d.o += cell.o || 0;
          d.cr += cell.cr || 0;
          d.cc += cell.cc || 0;
          d.req += cell.req || 0;
          d.credits += cell.credits || 0;
          const tk = (cell.i || 0) + (cell.o || 0) + (cell.cr || 0) + (cell.cc || 0);
          const t = row.tools.get(tool) || { tool, totalTokens: 0, requests: 0 };
          t.totalTokens += tk;
          t.requests += cell.req || 0;
          row.tools.set(tool, t);
          row.totalTokens += tk;
          row.requests += cell.req || 0;
          row.credits += cell.credits || 0;
        }
      }
    }
  }
  return [...map.values()].map((row) => ({
    key: row.key,
    workspaceKey: row.workspaceKey,
    workspaceName: row.wsName || null,
    devices: [...row.devices],
    daily: row.daily,
    tools: [...row.tools.values()].sort((a, b) => b.totalTokens - a.totalTokens),
    totalTokens: row.totalTokens,
    requests: row.requests,
    credits: row.credits,
  })).sort((a, b) => b.totalTokens - a.totalTokens);
}

function peerQuotaUsageCached() {
  const records = [];
  for (const peer of loadCachedPeers()) records.push(...quotaUsageRecords(peer));
  return records;
}

function newestCodexQuota(localQuota, peers, extraQuota) {
  let best = localQuota && localQuota.available ? localQuota : null;
  const quotas = (peers || []).map((peer) => peer && peer.codexQuota);
  if (extraQuota) quotas.push(extraQuota);
  for (const quota of quotas) {
    if (!quota || !quota.available) continue;
    if (!best || (Date.parse(quota.fetchedAt || "") || 0) > (Date.parse(best.fetchedAt || "") || 0)) {
      best = quota;
    }
  }
  return best || localQuota || null;
}

function syncEnabled(settings) {
  const cfg = (settings && settings.sync) || {};
  return !!cfg.enabled;
}

module.exports = {
  buildSummary,
  normalizePeerSummary,
  summaryToRecords,
  quotaUsageRecords,
  quotaSamplesForSync,
  runSync,
  peerRecordsCached,
  peerQuotaUsageCached,
  newestCodexQuota,
  syncEnabled,
  syncConfigured,
  readSyncState,
  recordSyncState,
  savePeersToCache,
  loadCachedPeers,
  peerWorkspaceSummaries,
  readWsSalt,
  dayKey,
};
