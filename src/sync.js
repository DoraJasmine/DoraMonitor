"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

/**
 * Cross-device usage sync.
 *
 * Each device maintains ONE small daily-summary file and uploads it to a
 * shared backend (SSH/SCP or WebDAV):
 *
 *   {version, device, generatedAt, updatedRange, days: {
 *     "YYYY-MM-DD": { "<tool>": { "<model>": {i,o,cr,cc,req,credits} } }
 *   }}
 *
 * Daily granularity lets the dashboard aggregate any range (today / 7d /
 * 30d / all) from peers, not just the billing month. Peers' files are
 * cached under ~/.doramonitor/remote-cache/ so the dashboard keeps
 * working offline; a failed sync degrades to cached data with a status note.
 */

const SUMMARY_VERSION = 1;
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

/** Build the device summary from local usage records. */
function buildSummary(deviceName, records) {
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
    bucket.req += 1;
    bucket.credits += r.credits || 0;
  }
  return {
    version: SUMMARY_VERSION,
    device: deviceName,
    generatedAt: new Date().toISOString(),
    updatedRange: earliest ? { start: earliest, end: latest } : null,
    days,
  };
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
        if (data && typeof data === "object" && data.days) peers.push(data);
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
      if (data && data.days) peers.push(data);
    } catch {
      // skip broken peer file
    }
  }
  return { ok: true, peers };
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
        if (data && data.days) peers.push(data);
      } catch {
        // skip broken cache file
      }
    }
  } catch {
    // no cache yet
  }
  return peers;
}

/**
 * Run a full sync: upload local summary, download peers, refresh cache.
 * records: local usage records (from collect).
 * Returns { enabled, uploaded, downloaded, peers, fromCache, error }.
 */
async function runSync(records, settings) {
  const cfg = settings.sync || {};
  if (!cfg.enabled) {
    return { enabled: false, peers: [], fromCache: false };
  }
  const deviceName = cfg.deviceName || os.hostname().replace(/[^a-zA-Z0-9_-]/g, "_");
  const summary = buildSummary(deviceName, records);

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
    } else {
      uploadError = `unknown backend: ${cfg.backend}`;
    }
  } catch (err) {
    uploadError = String((err && err.message) || err).slice(0, 200);
  }

  const fromCache = !fetched.ok;
  const peers = fetched.ok ? fetched.peers : loadCachedPeers();
  if (fetched.ok) savePeersToCache(peers);

  return {
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

function syncEnabled(settings) {
  const cfg = (settings && settings.sync) || {};
  return !!cfg.enabled;
}

module.exports = {
  buildSummary,
  summaryToRecords,
  runSync,
  peerRecordsCached,
  syncEnabled,
  savePeersToCache,
  loadCachedPeers,
  dayKey,
};
