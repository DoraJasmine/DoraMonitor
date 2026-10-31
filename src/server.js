#!/usr/bin/env node
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const { resolveKimiHome, isKimiHome, defaultCandidates } = require("./paths");
const { collect, invalidate: invalidateCollect } = require("./collect");
const { listTools } = require("./tools");
const {
  aggregate,
  summaryAllRanges,
  aggregateByTool,
  aggregateToolEvents,
  buildHeatmap,
  aggregateFromBuckets,
  buildHeatmapFromDaily,
  toolEventsFromBuckets,
  byToolFromBuckets,
  recentFromRecords,
} = require("./aggregate");
const { mergeBuckets, newBucket, foldRecordInto } = require("./buckets");
const { listPrices } = require("./pricing");
const { startQuotaSampler } = require("./quota-sampler");
const { resolveQuotaTool } = require("./quota-tool");
const { getToolQuota, getToolCapacityHistory, getToolSampleHistory, runToolCalibration, listToolQuotaAccounts } = require("./tool-quota-service");
const { loadSettings, saveSettings, toDisplay } = require("./settings");
const { runSync, peerRecordsCached, syncEnabled } = require("./sync");
const { toolMeta } = require("./tools/base");
const { detectLocale, messages } = require("./i18n");
const {
  listSessions,
  archiveSession,
  unarchiveSession,
  deleteSession,
  deleteWorkspace,
  getSessionPreview,
} = require("./sessions");
const {
  getConfigView,
  saveProvider,
  deleteProvider,
  saveModel,
  deleteModel,
  setDefaultModel,
  setSecondaryModel,
} = require("./config-store");
const {
  fetchCatalogOrBuiltIn,
  catalogProviderModels,
  importCatalogProvider,
} = require("./catalog");

// Prefer Vite build output; fall back to legacy public/ for plain static.
const DIST = path.join(__dirname, "..", "dist");
const PUBLIC = fs.existsSync(DIST) ? DIST : path.join(__dirname, "..", "public");
if (!fs.existsSync(path.join(PUBLIC, "index.html"))) {
  console.warn("[doramonitor] Web UI build not found; the dashboard will return 404. Run `npm run build` first (the npm package ships prebuilt).");
}

const DEFAULT_HOST = "127.0.0.1";

function requestAllowed(req, bindHost = DEFAULT_HOST) {
  const host = String(req.headers.host || "").toLowerCase();
  if (["127.0.0.1", "localhost", "::1"].includes(bindHost) && host) {
    const hostname = host.startsWith("[")
      ? host.slice(1, host.indexOf("]"))
      : host.split(":")[0];
    if (!["127.0.0.1", "localhost", "::1"].includes(hostname)) return false;
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.headers.origin) {
    try {
      if (new URL(req.headers.origin).host.toLowerCase() !== host) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function parseArgs(argv) {
  const opts = { port: 3847, host: DEFAULT_HOST, home: null, open: true };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port" || a === "-p") opts.port = Number(argv[++i]) || opts.port;
    else if (a === "--host") opts.host = argv[++i] || opts.host;
    else if (a === "--home" || a === "--dir") opts.home = argv[++i];
    else if (a === "--no-open") opts.open = false;
    else if (a === "--help" || a === "-h") opts.help = true;
  }
  return opts;
}

/** A host string that is safe to paste into a URL (bracket IPv6 literals). */
function urlHost(host) {
  if (!host) return "127.0.0.1";
  if (host === "::" || host === "0.0.0.0") return "127.0.0.1";
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function printHelp() {
  console.log(`kimicode-dashboard — local Kimi Code usage stats

Usage:
  node src/server.js [options]
  npm start -- [options]

Options:
  --home, --dir <path>   Kimi Code data directory (default: auto)
  --port, -p <n>         Port (default: 3847)
  --host <host>          Bind host (default: 127.0.0.1)
  --no-open              Do not open browser
  -h, --help             Show help

Privacy: only model name, time, and token counts from usage.record are read.
Prompts, replies, code, API keys, and provider credentials are never shown.
`);
}

// Aggregation cache — keyed by scan generation | device set | tool filter.
// Reused while the collected records are unchanged, so repeat requests cost
// no recomputation even with peer/device filtering in play.
const aggCache = new Map();

/** Phase-3 bucket path toggle: set to 1 to fall back to the raw-records
 *  aggregation (both paths produce equivalent numbers; the bucket path is
 *  O(days) instead of O(records) and survives cold starts). */
const BUCKETS_DISABLED = process.env.DORAMONITOR_DISABLE_BUCKETS === "1";

function getHome(queryHome, cliHome) {
  if (queryHome) return resolveKimiHome(queryHome);
  if (cliHome) return resolveKimiHome(cliHome);
  return resolveKimiHome(null);
}

/**
 * Aggregated dashboard data for all ranges + heatmap, cached per scan
 * generation. Bucket path (default): aggregates from day-buckets with
 * query-time pricing; recent rows are injected from the raw-record window.
 * Fallback path (DORAMONITOR_DISABLE_BUCKETS=1): the original per-record
 * aggregation over the full record list.
 */
function ensureAggregates(collected, key, records, tool, buckets, settings) {
  const cacheKey = `${collected.scannedAt}|${key}|${tool}`;
  const hit = aggCache.get(cacheKey);
  if (hit) return hit;
  let data;
  if (BUCKETS_DISABLED || !Array.isArray(buckets) || buckets.length === 0) {
    data = {
      perRange: summaryAllRanges(records, Date.now(), tool),
      heatmap: buildHeatmap(records, Date.now(), 53, tool),
      toolEvents: null,
    };
    for (const r of Object.values(data.perRange)) {
      Object.assign(r, recentFromRecords(records, r.range, Date.now(), tool));
    }
  } else {
    const now = Date.now();
    const perRange = {};
    for (const range of ["today", "7d", "30d", "all"]) {
      const agg = aggregateFromBuckets(buckets, {
        range,
        nowMs: now,
        tool,
        fxRate: settings?.fxRate,
        customPrices: settings?.customPrices,
      });
      Object.assign(agg, recentFromRecords(records, range, now, tool));
      perRange[range] = agg;
    }
    // Heatmap spans all history: reuse the "all" aggregation's daily rows.
    const allDayMap = new Map(perRange.all.daily.map((d) => [d.date, d]));
    const mergedEvents = mergeBuckets(buckets).eventDays;
    data = {
      perRange,
      heatmap: buildHeatmapFromDaily(allDayMap, now, 53),
      toolEvents: mergedEvents,
    };
  }
  // Bounded: a handful of device/tool combinations at most.
  if (aggCache.size > 32) aggCache.clear();
  aggCache.set(cacheKey, data);
  return data;
}

/** Range filter keys allowed on /api/summary. */
const TOOL_IDS = () => listTools().map((t) => t.id);

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(data);
}

function settingsView(settings) {
  const webdav = settings.sync?.webdav || {};
  return {
    ...settings,
    sync: {
      ...settings.sync,
      webdav: { ...webdav, password: undefined, hasPassword: Boolean(webdav.password) },
    },
  };
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error("body too large"), { code: "body_too_large" }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(Object.assign(new Error("invalid json"), { code: "invalid_json" }));
      }
    });
    req.on("error", reject);
  });
}

function mapSessionError(err) {
  const code = err && err.code;
  if (code === "not_found") return 404;
  if (code === "invalid_workspace" || code === "invalid_session" || code === "path_escape") {
    return 400;
  }
  if (code === "exists") return 409;
  return 500;
}

/** Map a ConfigError/catalog error code to an HTTP status. */
function mapConfigError(err) {
  const code = err && err.code;
  if (code === "not_found") return 404;
  if (code === "no_models") return 422;
  if (code === "invalid_toml" || code === "read_failed" || code === "write_failed" || code === "catalog_missing") {
    return 500;
  }
  if (code && code.startsWith("invalid_")) return 400;
  return 500;
}

/** Run a config mutation, serializing success/error uniformly. */
async function runConfig(res, fn) {
  try {
    const body = await fn();
    return json(res, 200, body);
  } catch (err) {
    return json(res, mapConfigError(err), {
      error: err.code || "error",
      message: String(err.message || err),
    });
  }
}

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
};

// Vite emits content-hashed asset names, so they can be cached forever.
const IMMUTABLE_RE = /-[A-Za-z0-9_-]{8,}\.(js|css|woff2|png|svg|webp|jpg|jpeg)$/;

// Gzip results cached per (path, mtime) — re-compressing the ~300 KB JS
// bundle on every request is pure CPU waste, and the inputs only change on
// rebuild. Bounded: clear the whole cache past ~40 MB of retained buffers.
const gzipCache = new Map();
const GZIP_CACHE_MAX_BYTES = 40 * 1024 * 1024;
let gzipCacheBytes = 0;

function cachedGzip(filePath, mtimeMs, buf) {
  const key = `${filePath}|${mtimeMs}`;
  const hit = gzipCache.get(key);
  if (hit) return hit;
  const { gzipSync } = require("zlib");
  const gz = gzipSync(buf);
  if (gzipCacheBytes + gz.length > GZIP_CACHE_MAX_BYTES) {
    gzipCache.clear();
    gzipCacheBytes = 0;
  }
  gzipCache.set(key, gz);
  gzipCacheBytes += gz.length;
  return gz;
}

function sendFile(res, filePath, reqHeaders) {
  const ext = path.extname(filePath).toLowerCase();
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const headers = {
      "Content-Type": CONTENT_TYPES[ext] || "application/octet-stream",
      "Cache-Control": IMMUTABLE_RE.test(path.basename(filePath))
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    };
    // gzip text assets — the JS bundle dominates page weight on slow links.
    const accept = String((reqHeaders && reqHeaders["accept-encoding"]) || "");
    if (accept.includes("gzip") && /\.(js|css|html|svg|json)$/i.test(ext) && buf.length > 1024) {
      try {
        const mtime = fs.statSync(filePath).mtimeMs;
        buf = cachedGzip(filePath, mtime, buf);
        headers["Content-Encoding"] = "gzip";
      } catch {
        // fall through uncompressed
      }
    }
    headers["Content-Length"] = buf.length;
    res.writeHead(200, headers);
    res.end(buf);
  });
}

async function handleApi(req, res, url, cliHome) {
  const home = getHome(url.searchParams.get("home"), cliHome);

  if (url.pathname === "/api/health") {
    return json(res, 200, { ok: true });
  }

  if (url.pathname === "/api/locale") {
    const al = req.headers["accept-language"] || "";
    return json(res, 200, {
      detected: detectLocale(al.split(",")[0] || ""),
      messages,
    });
  }

  if (url.pathname === "/api/paths") {
    const candidates = defaultCandidates().map((p) => ({
      path: p,
      valid: isKimiHome(p),
    }));
    return json(res, 200, {
      current: home,
      valid: isKimiHome(home),
      candidates,
      tools: listTools(),
      env: {
        KIMI_CODE_HOME: process.env.KIMI_CODE_HOME || null,
        KIMI_MODEL_NAME: process.env.KIMI_MODEL_NAME || null,
      },
    });
  }

  if (url.pathname === "/api/summary") {
    const force = url.searchParams.get("refresh") === "1";
    const collected = collect({ force });
    if (!collected.tools.length) {
      return json(res, 200, {
        valid: false,
        home,
        tools: [],
        message: "No AI tool data directories found",
      });
    }
    const range = url.searchParams.get("range") || "30d";
    const toolParam = url.searchParams.get("tool") || "all";
    const tool = TOOL_IDS().includes(toolParam) ? toolParam : "all";

    // Device dimension: local records carry device:"local" from the scan;
    // peers come from the sync cache so requests never block on the network.
    const localRecords = collected.records;
    const settingsNow = loadSettings();
    const syncOn = syncEnabled(settingsNow);
    const peerRecords = syncOn ? peerRecordsCached() : [];
    const deviceParam = url.searchParams.get("device") || "all";
    const peerDevices = [...new Set(peerRecords.map((r) => r.device))];
    const aggRecords =
      deviceParam === "local" ? localRecords
      : deviceParam !== "all" && peerDevices.includes(deviceParam)
        ? peerRecords.filter((r) => r.device === deviceParam)
        : [...localRecords, ...peerRecords];

    // Day-buckets per device: local buckets come from the scan snapshot;
    // peer summaries are folded on the fly (a few hundred cells, µs).
    const localBuckets = BUCKETS_DISABLED
      ? []
      : [...(collected.bucketsByTool?.values() || [])].flat();
    const peerBucketsByDevice = new Map();
    if (!BUCKETS_DISABLED) {
      for (const rec of peerRecords) {
        if (!peerBucketsByDevice.has(rec.device)) {
          peerBucketsByDevice.set(rec.device, newBucket(`${rec.device}:peer`, null));
        }
        foldRecordInto(peerBucketsByDevice.get(rec.device), rec);
      }
    }
    const selectedBuckets =
      deviceParam === "local" ? localBuckets
      : peerBucketsByDevice.has(deviceParam) ? [peerBucketsByDevice.get(deviceParam)]
      : [...localBuckets, ...peerBucketsByDevice.values()];

    const deviceKey = deviceParam === "all" && !peerRecords.length ? "local" : `dev:${deviceParam}:${peerRecords.length}`;
    const cached = ensureAggregates(collected, deviceKey, aggRecords, tool, selectedBuckets, settingsNow);
    const perRange = cached.perRange;
    const rangeAgg = perRange[range] || aggregate(aggRecords, range, Date.now(), tool);
    const heatmap = cached.heatmap;
    const allForTool = perRange.all;
    const rangeTotals = {
      today: perRange.today.totals,
      "7d": perRange["7d"].totals,
      "30d": perRange["30d"].totals,
      all: perRange.all.totals,
    };

    // All-time model roster so UI can explain range filtering
    const allModels = (allForTool.models || []).map((m) => ({
      model: m.model,
      modelDisplay: m.modelDisplay,
      tool: m.tool,
      requests: m.requests,
      totalTokens: m.totalTokens,
      cost: toDisplay(m.costCny, settingsNow),
      credits: m.credits,
      costEstimated: m.costEstimated,
      cacheHitRate: m.cacheHitRate,
    }));

    const toolList = listTools();
    // Aggregates intentionally retain CNY internally so one exchange-rate
    // conversion is applied here, at the API/display boundary.  This keeps
    // the price table, model statistics, charts and recent rows in the same
    // selected currency without mutating cached accounting values.
    const displayAggregate = displayCosts(rangeAgg, settingsNow);
    const displayHeatmap = {
      ...heatmap,
      cells: (heatmap.cells || []).map((cell) => displayCost(cell, settingsNow)),
    };
    const byToolRange = (cached.toolEvents
      ? byToolFromBuckets(selectedBuckets, range, toolMeta, Date.now(), {
          fxRate: settingsNow.fxRate,
          customPrices: settingsNow.customPrices,
        })
      : aggregateByTool(aggRecords, range, toolMeta)
    ).map((row) => displayCost(row, settingsNow));
    const displayRangeTotals = Object.fromEntries(
      Object.entries(rangeTotals).map(([key, totals]) => [key, displayCost(totals, settingsNow)])
    );

    return json(res, 200, {
      valid: true,
      home,
      scannedAt: collected.scannedAt,
      fromCache: collected.fromCache,
      meta: Object.fromEntries(collected.tools.map((t) => [t.id, t.meta])),
      range,
      tool,
      tools: toolList,
      byTool: byToolRange,
      stats: displayAggregate,
      toolEvents: cached.toolEvents
        ? toolEventsFromBuckets(cached.toolEvents, range, Date.now(), tool)
        : aggregateToolEvents(collected.events, range, Date.now(), tool),
      device: deviceParam,
      devices: [
        { id: "local", label: "本机", available: true },
        ...peerDevices.map((d) => ({ id: d, label: d, available: true, peer: true })),
      ],
      sync: { enabled: syncOn, peers: peerDevices.length },
      heatmap: displayHeatmap,
      allModels,
      allModelCount: allModels.length,
      rangeTotals: displayRangeTotals,
    });
  }

  if (url.pathname === "/api/settings" && req.method === "GET") {
    return json(res, 200, settingsView(loadSettings()));
  }

  if (url.pathname === "/api/settings" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const current = loadSettings();
      const merged = {
        ...current,
        ...body,
        quotaEstimation: { ...current.quotaEstimation, ...body.quotaEstimation },
        sync: body.sync
          ? {
              ...current.sync,
              ...body.sync,
              ssh: { ...current.sync?.ssh, ...body.sync.ssh },
              webdav: { ...current.sync?.webdav, ...body.sync.webdav },
            }
          : current.sync,
      };
      const saved = saveSettings(merged);
      // Costs are computed during scans — force a full rescan so saved
      // custom prices take effect immediately.
      invalidateCollect();
      collect({ force: true });
      return json(res, 200, settingsView(saved));
    } catch (err) {
      return json(res, 400, {
        error: "invalid_settings",
        message: String((err && err.message) || err),
      });
    }
  }

  if (url.pathname === "/api/prices") {
    const settings = loadSettings();
    const prices = listPrices({ fxRate: settings.fxRate }).map((p) => ({
      ...p,
      // `p.*` is normalized to internal CNY; `display` is the
      // user-selected currency and is what the web price table renders.
      display: {
        currency: settings.currency,
        symbol: settings.currencySymbol,
        cacheHit: toDisplay(p.cacheHit, settings),
        cacheWrite: p.cacheWrite == null ? null : toDisplay(p.cacheWrite, settings),
        cacheWriteLong: p.cacheWriteLong == null ? null : toDisplay(p.cacheWriteLong, settings),
        input: toDisplay(p.input, settings),
        output: toDisplay(p.output, settings),
      },
    }));
    return json(res, 200, {
      prices,
      currency: settings.currency,
      currencySymbol: settings.currencySymbol,
      fxRate: settings.fxRate,
      customPrices: settings.customPrices,
    });
  }

  if (url.pathname === "/api/quota/accounts") {
    let tool;
    try {
      tool = resolveQuotaTool({ tool: url.searchParams.get("tool"), provider: url.searchParams.get("provider") });
    } catch (error) {
      return json(res, error.status, { error: error.code, message: error.message });
    }
    const accounts = listToolQuotaAccounts({ tool, cliHome }).map(({ accountKey, label }) => ({ accountKey, label }));
    return json(res, 200, { tool, accounts });
  }

  if (url.pathname === "/api/quota/capacity/calibration" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const tool = resolveQuotaTool({ tool: body.tool, provider: body.provider });
      const result = await runToolCalibration({ tool, body, cliHome });
      return json(res, 200, result);
    } catch (error) {
      return json(res, error.status || 500, { error: error.code || "calibration_failed", message: error.message, ...(error.details || {}) });
    }
  }

  if (url.pathname === "/api/quota/capacity/history") {
    let tool;
    try {
      tool = resolveQuotaTool({ tool: url.searchParams.get("tool"), provider: url.searchParams.get("provider") });
    } catch (error) {
      return json(res, error.status, { error: error.code, message: error.message });
    }
    const cache = url.searchParams.get("cacheHitRate");
    const minConfidenceScore = url.searchParams.get("minConfidenceScore");
    const page = getToolCapacityHistory({
      tool,
      accountKey: url.searchParams.get("accountKey"),
      scope: url.searchParams.get("scope"),
      window: url.searchParams.get("window"),
      cacheHitRate: cache === null ? undefined : Number(cache),
      estimateKind: url.searchParams.get("estimateKind"),
      minConfidenceScore: minConfidenceScore === null ? undefined : Number(minConfidenceScore),
      limit: url.searchParams.get("limit"),
      offset: url.searchParams.get("offset"),
    });
    return json(res, 200, { ...page, tool });
  }

  if (url.pathname === "/api/quota/samples") {
    let tool;
    try {
      tool = resolveQuotaTool({ tool: url.searchParams.get("tool"), provider: url.searchParams.get("provider") });
    } catch (error) {
      return json(res, error.status, { error: error.code, message: error.message });
    }
    const page = getToolSampleHistory({
      tool,
      accountKey: url.searchParams.get("accountKey"),
      window: url.searchParams.get("window"),
      changesOnly: url.searchParams.get("changesOnly") === "1",
      limit: url.searchParams.get("limit"),
      offset: url.searchParams.get("offset"),
    });
    return json(res, 200, { ...page, tool });
  }

  if (url.pathname === "/api/quota") {
    let tool;
    try {
      tool = resolveQuotaTool({ tool: url.searchParams.get("tool"), provider: url.searchParams.get("provider") });
    } catch (error) {
      return json(res, error.status, { error: error.code, message: error.message });
    }
    const result = await getToolQuota({
      tool,
      cliHome,
      force: url.searchParams.get("refresh") === "1",
      scope: url.searchParams.get("scope"),
      accountKey: url.searchParams.get("accountKey"),
    });
    return json(res, 200, result);
  }

  if (url.pathname === "/api/tools") {
    return json(res, 200, { tools: listTools() });
  }

  if (url.pathname === "/api/sync" && req.method === "POST") {
    const settings = loadSettings();
    if (!syncEnabled(settings)) {
      return json(res, 400, { ok: false, error: "sync_disabled" });
    }
    try {
      const collected = collect({ force: true });
      const result = await runSync(
        collected.records,
        settings,
        collected.byTool.get("codex")?.quota
      );
      return json(res, 200, {
        ok: result.uploaded || result.downloaded,
        uploaded: result.uploaded,
        uploadError: result.uploadError || null,
        downloaded: result.downloaded,
        fromCache: result.fromCache,
        peers: (result.peers || []).map((p) => p.device),
        error: result.error || null,
      });
    } catch (err) {
      return json(res, 500, { ok: false, error: String((err && err.message) || err) });
    }
  }

  // --- Session management (workspace-isolated) ---
  if (url.pathname === "/api/sessions" && req.method === "GET") {
    if (!isKimiHome(home)) {
      return json(res, 400, { error: "invalid_home", home });
    }
    const status = url.searchParams.get("status") || "active";
    const workspace = url.searchParams.get("workspace") || null;
    const result = listSessions(home, { status, workspace });
    if (result.error) return json(res, 400, result);
    return json(res, 200, result);
  }

  if (url.pathname === "/api/sessions/archive" && req.method === "POST") {
    if (!isKimiHome(home)) return json(res, 400, { error: "invalid_home", home });
    try {
      const body = await readBody(req);
      const out = archiveSession(home, body.workspaceId, body.sessionId);
      // Invalidate usage cache — files moved
      invalidateCollect();
      return json(res, 200, out);
    } catch (err) {
      return json(res, mapSessionError(err), {
        error: err.code || "error",
        message: String(err.message || err),
      });
    }
  }

  if (url.pathname === "/api/sessions/unarchive" && req.method === "POST") {
    if (!isKimiHome(home)) return json(res, 400, { error: "invalid_home", home });
    try {
      const body = await readBody(req);
      const out = unarchiveSession(home, body.workspaceId, body.sessionId);
      invalidateCollect();
      return json(res, 200, out);
    } catch (err) {
      return json(res, mapSessionError(err), {
        error: err.code || "error",
        message: String(err.message || err),
      });
    }
  }

  if (url.pathname === "/api/sessions/delete" && req.method === "POST") {
    if (!isKimiHome(home)) return json(res, 400, { error: "invalid_home", home });
    try {
      const body = await readBody(req);
      if (body.confirm !== true) {
        return json(res, 400, {
          error: "confirm_required",
          message: "Pass confirm:true to permanently delete a session",
        });
      }
      const out = deleteSession(
        home,
        body.workspaceId,
        body.sessionId,
        body.status || null
      );
      invalidateCollect();
      return json(res, 200, out);
    } catch (err) {
      return json(res, mapSessionError(err), {
        error: err.code || "error",
        message: String(err.message || err),
      });
    }
  }

  if (url.pathname === "/api/sessions/preview" && req.method === "GET") {
    if (!isKimiHome(home)) return json(res, 400, { error: "invalid_home", home });
    try {
      const workspaceId = url.searchParams.get("workspaceId");
      const sessionId = url.searchParams.get("sessionId");
      const status = url.searchParams.get("status") || null;
      const out = getSessionPreview(home, workspaceId, sessionId, status);
      return json(res, 200, out);
    } catch (err) {
      return json(res, mapSessionError(err), {
        error: err.code || "error",
        message: String(err.message || err),
      });
    }
  }

  if (url.pathname === "/api/workspaces/delete" && req.method === "POST") {
    if (!isKimiHome(home)) return json(res, 400, { error: "invalid_home", home });
    try {
      const body = await readBody(req);
      if (body.confirm !== true) {
        return json(res, 400, {
          error: "confirm_required",
          message: "Pass confirm:true to delete an empty workspace",
        });
      }
      const out = deleteWorkspace(home, body.workspaceId, {
        force: body.force === true,
      });
      invalidateCollect();
      return json(res, 200, out);
    } catch (err) {
      const status = err.code === "not_empty" ? 409 : mapSessionError(err);
      return json(res, status, {
        error: err.code || "error",
        message: String(err.message || err),
        activeCount: err.activeCount,
        archivedCount: err.archivedCount,
      });
    }
  }

  // --- Model configuration (config.toml read/write) ---
  if (url.pathname === "/api/config" && req.method === "GET") {
    return json(res, 200, getConfigView(home));
  }

  if (url.pathname === "/api/config/providers" && req.method === "POST") {
    return runConfig(res, async () => {
      const body = await readBody(req);
      return saveProvider(home, body);
    });
  }

  const providerDelete = url.pathname.match(/^\/api\/config\/providers\/([^/]+)$/);
  if (providerDelete && req.method === "DELETE") {
    return runConfig(res, () => deleteProvider(home, decodeURIComponent(providerDelete[1])));
  }

  const providerModels = url.pathname.match(/^\/api\/config\/providers\/([^/]+)\/models$/);
  if (providerModels && req.method === "POST") {
    return runConfig(res, async () => {
      const body = await readBody(req);
      const providerId = decodeURIComponent(providerModels[1]);
      return saveModel(home, { ...body, providerId });
    });
  }

  const modelDelete = url.pathname.match(/^\/api\/config\/models\/(.+)$/);
  if (modelDelete && req.method === "DELETE") {
    return runConfig(res, () => deleteModel(home, decodeURIComponent(modelDelete[1])));
  }

  if (url.pathname === "/api/config/default-model" && req.method === "POST") {
    return runConfig(res, async () => {
      const body = await readBody(req);
      return setDefaultModel(home, body.alias);
    });
  }

  if (url.pathname === "/api/config/secondary-model" && req.method === "POST") {
    return runConfig(res, async () => {
      const body = await readBody(req);
      return setSecondaryModel(home, body);
    });
  }

  // --- Provider catalog (models.dev, with builtin fallback) ---
  // --- Price directory: per-entry USD/1M costs from the models.dev catalog
  // (the "online update" source of the price page). Costs live on the raw
  // catalog models; the stripped view keeps them via the KEEP_MODEL whitelist.
  if (url.pathname === "/api/catalog/prices" && req.method === "GET") {
    const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
    try {
      const force = url.searchParams.get("refresh") === "1";
      const catalog = await fetchCatalogOrBuiltIn({ force });
      const rows = [];
      for (const p of catalog.providers || []) {
        for (const m of catalogProviderModels(p) || []) {
          const cost = m.cost && typeof m.cost === "object" ? m.cost : null;
          if (!cost || !Number.isFinite(Number(cost.input))) continue;
          const needle = `${p.id} ${p.name || ""} ${m.id} ${m.name || ""}`.toLowerCase();
          if (q && !needle.includes(q)) continue;
          rows.push({
            modelId: m.id,
            providerId: p.id,
            providerName: p.name || p.id,
            name: m.name || m.id,
            // models.dev costs are USD per 1M tokens already.
            input: Number(cost.input),
            output: Number(cost.output),
            cacheRead: Number(cost.cache_read ?? cost.input),
            cacheWrite: Number(cost.cache_write ?? cost.input),
          });
          if (rows.length >= 200) break;
        }
        if (rows.length >= 200) break;
      }
      return json(res, 200, {
        source: catalog.source,
        fetchedAt: catalog.fetchedAt,
        prices: rows,
      });
    } catch (err) {
      return json(res, 500, { error: "catalog_unavailable", message: String(err && err.message ? err.message : err) });
    }
  }

  if (url.pathname === "/api/catalog" && req.method === "GET") {
    return runConfig(res, async () => {
      const force = url.searchParams.get("refresh") === "1";
      const data = await fetchCatalogOrBuiltIn({ force });
      return {
        source: data.source,
        fetchedAt: data.fetchedAt,
        providers: data.providers.map((p) => ({ ...p, models: catalogProviderModels(p) })),
      };
    });
  }

  if (url.pathname === "/api/catalog/import" && req.method === "POST") {
    return runConfig(res, async () => {
      const body = await readBody(req);
      return importCatalogProvider(home, body);
    });
  }

  json(res, 404, { error: "not_found" });
}

/** Return a display-only copy; never mutate cached internal CNY aggregates. */
function displayCost(row, settings) {
  const { costCny = 0, ...rest } = row || {};
  return { ...rest, cost: toDisplay(costCny, settings) };
}

function displayCosts(aggregateResult, settings) {
  return {
    ...aggregateResult,
    totals: displayCost(aggregateResult.totals, settings),
    daily: (aggregateResult.daily || []).map((row) => displayCost(row, settings)),
    models: (aggregateResult.models || []).map((row) => displayCost(row, settings)),
    recent: (aggregateResult.recent || []).map((row) => displayCost(row, settings)),
    dailyByModel: {
      ...aggregateResult.dailyByModel,
      totals: (aggregateResult.dailyByModel?.totals || []).map((row) => displayCost(row, settings)),
    },
  };
}

function createServer(cliHome, bindHost = DEFAULT_HOST) {
  return http.createServer((req, res) => {
    if (!requestAllowed(req, bindHost)) {
      return json(res, 403, { error: "forbidden_origin" });
    }
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      Promise.resolve(handleApi(req, res, url, cliHome)).catch((err) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err.message || err) }));
      });
      return;
    }
    try {
      let rel = url.pathname === "/" ? "/index.html" : url.pathname;
      // SPA fallback for client routes
      if (
        !rel.includes(".") &&
        (rel === "/quota" ||
          rel === "/sessions" ||
          rel.startsWith("/sessions/") ||
          rel === "/models" ||
          rel.startsWith("/models/") ||
          rel === "/prices")
      ) {
        rel = "/index.html";
      }
      // prevent path traversal
      rel = path.normalize(rel).replace(/^(\.\.[/\\])+/, "");
      const filePath = path.join(PUBLIC, rel);
      if (!filePath.startsWith(PUBLIC)) {
        res.writeHead(403);
        return res.end("Forbidden");
      }
      sendFile(res, filePath, req.headers);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err.message || err) }));
    }
  });
}

function openBrowser(url) {
  const { exec } = require("child_process");
  const platform = process.platform;
  let cmd;
  if (platform === "win32") cmd = `start "" "${url}"`;
  else if (platform === "darwin") cmd = `open "${url}"`;
  else cmd = `xdg-open "${url}"`;
  exec(cmd, () => {});
}

function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    printHelp();
    process.exit(0);
  }
  const server = createServer(opts.home, opts.host);
  startQuotaSampler(opts.home);
  server.listen(opts.port, opts.host, () => {
    // Show an address the user can actually click; the wildcard binds are
    // not valid literals in a URL.
    const url = `http://${urlHost(opts.host)}:${opts.port}/`;
    console.log(`DoraMonitor`);
    console.log(`  URL:  ${url}`);
    const tools = listTools()
      .map((t) => `${t.label}${t.available ? "" : " (not found)"}`)
      .join(", ");
    console.log(`  Tools: ${tools}`);
    console.log(`  Privacy: usage metadata only — no prompts, keys, or credentials`);
    if (opts.open) openBrowser(url);
  });
}

if (require.main === module) {
  main();
}

module.exports = { createServer, parseArgs, urlHost, requestAllowed, settingsView, DEFAULT_HOST };
