"use strict";

const { listProviders, getProvider, sourceFiles, fileStamp } = require("./providers");
const { loadModelMap } = require("./model-map");
const { bucketFromRecords } = require("./buckets");

/**
 * Incremental, cached collector.
 *
 * - In-memory cache with a short TTL avoids rescanning on every request.
 * - Between TTLs, each provider's source files are probed with stat only;
 *   unchanged file sets reuse cached records instead of re-reading.
 * - force=true bypasses both layers (Refresh button).
 * - Phase 3: the snapshot also carries per-file DAY BUCKETS (day × tool ×
 *   model × rateKey token counts). Raw records are trimmed to a 30-day
 *   window (see RECORD_WINDOW_DAYS) plus a hard cap — everything older is
 *   represented by its buckets only, so resident memory stays bounded.
 */

const COLLECT_TTL_MS = 15_000;
/** Recent-records window: buckets cover all history; raw records (the
 *  "recent requests" table) only keep this many days (+1 day margin). */
const RECORD_WINDOW_DAYS = 30;
/** Hard cap on resident raw records — a single pathological day must not
 *  break the memory bound on its own. */
const RECORD_CAP = 20_000;
/** Heavy providers whose scan() accepts the incremental-bucket opts. */
const BUCKET_PROVIDERS = new Set(["kimi-code", "codex", "dsh"]);

function recordSince(now) {
  return now - (RECORD_WINDOW_DAYS + 1) * 24 * 60 * 60 * 1000;
}

const cache = {
  scannedAt: 0,
  /** tool id -> { records, meta, home, buckets } */
  byTool: new Map(),
  /** tool id -> { files: [{path, mtimeMs, size, exists}] } */
  stamps: new Map(),
  /** snapshot built for the current scannedAt generation (records sorted once) */
  snapshot: null,
};

function stampsEqual(prev, files) {
  if (!prev || prev.length !== files.length) return false;
  for (let i = 0; i < files.length; i++) {
    const a = prev[i];
    const b = files[i];
    if (a.path !== b.path) return false;
    if (b.exists) {
      if (!a.exists || a.mtimeMs !== b.mtimeMs || a.size !== b.size) return false;
    } else if (a.exists) {
      return false;
    }
  }
  return true;
}

function probeStamps(provider, home) {
  // Sorted by path so a readdir-order change cannot read as "something
  // changed" and trigger a pointless full rescan.
  return sourceFiles(provider, home)
    .map((p) => {
      const st = fileStamp(p);
      return st
        ? { path: p, exists: true, mtimeMs: st.mtimeMs, size: st.size }
        : { path: p, exists: false };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function scanProvider(provider, home, since) {
  if (provider.id === "kimi-code") {
    const modelMap = loadModelMap(home);
    const out = provider.scan(home, modelMap, { recordSince: since });
    return { records: out.records, meta: out.meta, events: out.events, quota: out.quota, buckets: out.buckets || [], home };
  }
  if (BUCKET_PROVIDERS.has(provider.id)) {
    const out = provider.scan(home, { recordSince: since });
    return { records: out.records, meta: out.meta, events: out.events, quota: out.quota, buckets: out.buckets || [], home };
  }
  // Light providers: whole-scan each time (cheap); fold their output into
  // a single in-memory bucket so aggregation has ONE code path. Wrapped in
  // the same { relPath, bucket } shape the heavy providers emit.
  const out = provider.scan(home);
  return {
    records: out.records,
    meta: out.meta,
    events: out.events,
    quota: out.quota,
    buckets: [{ relPath: ":memory", bucket: bucketFromRecords(out.records || [], out.events || [], `${provider.id}:memory`, null) }],
    home,
  };
}

/**
 * Collect usage from all providers.
 * Returns { tools, byTool, records, scannedAt, fromCache }.
 */
function collect({ force = false } = {}) {
  const now = Date.now();

  if (
    !force &&
    cache.scannedAt &&
    now - cache.scannedAt < COLLECT_TTL_MS &&
    cache.byTool.size > 0
  ) {
    return { ...cachedSnapshot(), fromCache: true };
  }

  const tools = listProviders();
  const since = recordSince(now);
  let reused = 0;
  let rescanned = 0;

  for (const tool of tools) {
    const provider = getProvider(tool.id);
    if (!tool.available || !provider) {
      cache.byTool.delete(tool.id);
      cache.stamps.delete(tool.id);
      continue;
    }
    const files = probeStamps(provider, tool.home);
    if (!force && stampsEqual(cache.stamps.get(tool.id), files)) {
      // Keep cached records; refresh stamp metadata only.
      cache.stamps.set(tool.id, files);
      reused += 1;
      continue;
    }
    try {
      cache.byTool.set(tool.id, scanProvider(provider, tool.home, since));
      cache.stamps.set(tool.id, files);
      rescanned += 1;
    } catch {
      // A broken provider must not take down the whole dashboard.
      if (!cache.byTool.has(tool.id)) {
        cache.byTool.set(tool.id, {
          records: [],
          meta: { filesScanned: 0, linesSeen: 0, recordCount: 0, home: tool.home, errors: [{ message: "scan failed" }] },
          home: tool.home,
          buckets: [],
        });
      }
    }
  }

  cache.scannedAt = now;
  cache.snapshot = null; // new scan generation → rebuild the sorted snapshot once
  return { ...cachedSnapshot(), fromCache: false, reused, rescanned };
}

function cachedSnapshot() {
  if (!cache.snapshot) {
    const byTool = new Map(cache.byTool);
    const records = [];
    const events = [];
    const bucketsByTool = new Map();
    const tools = [];
    for (const [id, entry] of byTool) {
      for (const r of entry.records) records.push(r);
      if (entry.events) events.push(...entry.events);
      if (entry.buckets) bucketsByTool.set(id, entry.buckets.map((b) => b.bucket));
      tools.push({ id, recordCount: entry.records.length, meta: entry.meta });
    }
    // Newest-first, then the hard memory cap.
    records.sort((a, b) => b.time - a.time);
    if (records.length > RECORD_CAP) records.length = RECORD_CAP;
    events.sort((a, b) => b.time - a.time);
    cache.snapshot = { byTool, records, events, bucketsByTool, tools, scannedAt: cache.scannedAt };
  }
  return cache.snapshot;
}

function snapshot() {
  return { ...cachedSnapshot() };
}

/**
 * Drop all caches: the scan generation, the built snapshot, and every
 * provider's per-file parse cache. Must be called when pricing settings
 * change (cached records carry costCny computed under the old settings) and
 * after session files move or are deleted.
 */
function invalidate() {
  cache.scannedAt = 0;
  cache.snapshot = null;
  for (const tool of listProviders()) {
    const provider = getProvider(tool.id);
    if (provider && typeof provider.clearCache === "function") provider.clearCache();
  }
}

module.exports = { collect, invalidate, COLLECT_TTL_MS, RECORD_WINDOW_DAYS, RECORD_CAP };
