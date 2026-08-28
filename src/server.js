#!/usr/bin/env node
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const { resolveKimiHome, isKimiHome, defaultCandidates } = require("./paths");
const { loadModelMap } = require("./model-map");
const { scanUsage } = require("./scanner");
const { aggregate, summaryAllRanges, buildHeatmap } = require("./aggregate");
const { listPrices } = require("./pricing");
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

function parseArgs(argv) {
  const opts = { port: 3847, host: "127.0.0.1", home: null, open: true };
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

// In-memory cache keyed by home path
const cache = {
  home: null,
  scannedAt: 0,
  records: null,
  meta: null,
  modelMap: null,
};

function getHome(queryHome, cliHome) {
  if (queryHome) return resolveKimiHome(queryHome);
  if (cliHome) return resolveKimiHome(cliHome);
  return resolveKimiHome(null);
}

function ensureScan(home, force = false) {
  const now = Date.now();
  if (
    !force &&
    cache.home === home &&
    cache.records &&
    now - cache.scannedAt < 15_000
  ) {
    return cache;
  }
  const modelMap = loadModelMap(home);
  const { records, meta } = scanUsage(home, modelMap);
  cache.home = home;
  cache.scannedAt = now;
  cache.records = records;
  cache.meta = meta;
  cache.modelMap = modelMap;
  return cache;
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(data);
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

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".ico": "image/x-icon",
    ".webp": "image/webp",
    ".json": "application/json; charset=utf-8",
  };
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": types[ext] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
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
      env: {
        KIMI_CODE_HOME: process.env.KIMI_CODE_HOME || null,
        KIMI_MODEL_NAME: process.env.KIMI_MODEL_NAME || null,
      },
    });
  }

  if (url.pathname === "/api/prices") {
    return json(res, 200, { prices: listPrices() });
  }

  if (url.pathname === "/api/summary") {
    if (!isKimiHome(home)) {
      return json(res, 400, {
        error: "invalid_home",
        home,
        message: "Directory is not a Kimi Code home (need sessions/ or config.toml)",
      });
    }
    const force = url.searchParams.get("refresh") === "1";
    const c = ensureScan(home, force);
    const range = url.searchParams.get("range") || "30d";
    const stats = aggregate(c.records, range);
    const all = summaryAllRanges(c.records);
    const heatmap = buildHeatmap(c.records);
    // Always expose all-time model roster so UI can explain range filtering
    const allModels = (all.all.models || []).map((m) => ({
      model: m.model,
      modelDisplay: m.modelDisplay,
      requests: m.requests,
      totalTokens: m.totalTokens,
      costUsd: m.costUsd,
      costEstimated: m.costEstimated,
      cacheHitRate: m.cacheHitRate,
    }));
    return json(res, 200, {
      home,
      valid: true,
      scannedAt: c.scannedAt,
      meta: c.meta,
      modelMap: {
        defaultModel: c.modelMap.defaultModel,
        envModel: c.modelMap.envModel,
        aliasCount: Object.keys(c.modelMap.aliases || {}).length,
      },
      range,
      stats,
      heatmap,
      allModels,
      allModelCount: allModels.length,
      rangeTotals: {
        today: all.today.totals,
        "7d": all["7d"].totals,
        "30d": all["30d"].totals,
        all: all.all.totals,
      },
    });
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
      if (cache.home === home) cache.scannedAt = 0;
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
      if (cache.home === home) cache.scannedAt = 0;
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
      if (cache.home === home) cache.scannedAt = 0;
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
      if (cache.home === home) cache.scannedAt = 0;
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

function createServer(cliHome) {
  return http.createServer((req, res) => {
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
        (rel === "/sessions" ||
          rel.startsWith("/sessions/") ||
          rel === "/models" ||
          rel.startsWith("/models/"))
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
      sendFile(res, filePath);
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
  const home = resolveKimiHome(opts.home);
  const server = createServer(opts.home);
  server.listen(opts.port, opts.host, () => {
    const url = `http://${opts.host}:${opts.port}/`;
    console.log(`Kimi Code Dashboard`);
    console.log(`  URL:  ${url}`);
    console.log(`  Home: ${home} (${isKimiHome(home) ? "ok" : "not found"})`);
    console.log(`  Privacy: usage.record only — no prompts, keys, or credentials`);
    if (opts.open) openBrowser(url);
  });
}

if (require.main === module) {
  main();
}

module.exports = { createServer, ensureScan, parseArgs };
