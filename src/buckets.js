"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { dayKey } = require("./aggregate");
const { rateKeyFor } = require("./pricing");

/**
 * Day-bucket layer (phase 3) — see docs/plan-phase3-day-bucket.md.
 *
 * A bucket is the day-granular aggregation of ONE source file's records:
 *   usageDays: day → tool → model → rateKey → {i,o,cr,cc,req,estReq,credits}
 *   eventDays: day → eventName → count
 * Buckets store INTEGER TOKEN COUNTS ONLY — costs are always computed at
 * query time from the current price table (priceForCell), so a price-table
 * update retroactively applies to all history with zero invalidation.
 *
 * Invariants guarded by test/bucket-equivalence.test.js:
 *   folding records into buckets and aggregating from buckets reproduces
 *   aggregate()'s totals/daily/models (float tolerance) — cost equivalence
 *   is guarded separately by test/bucket-pricing.test.js.
 *
 * Disk layout: ~/.doramonitor/buckets/<toolId>/<sha1(relPath)>.json
 * (atomic write; corrupt files are silently dropped and re-folded).
 * Validity = { version, stamp(mtimeMs,size), tzOffset } — a stored bucket
 * survives restarts; it is re-folded only when the source file changed,
 * the local timezone changed, or the fold logic version bumped.
 */

const BUCKET_VERSION = 2;
const BUCKETS_DIR = path.join(os.homedir(), ".doramonitor", "buckets");
/** git-index style guard: a file whose mtime is this fresh may have been
 *  written within the same timestamp granularity as our own scan — never
 *  persist a bucket for it, and force a re-read on the next scan. */
const RACY_WINDOW_MS = 2000;

function localTzOffset() {
  return new Date().getTimezoneOffset();
}

function newBucket(source, stamp) {
  return {
    version: BUCKET_VERSION,
    tzOffset: localTzOffset(),
    source: String(source || ""),
    stamp: { mtimeMs: stamp ? stamp.mtimeMs : 0, size: stamp ? stamp.size : 0 },
    usageDays: {},
    eventDays: {},
  };
}

/** Does a stored bucket still match this file under the current timezone? */
function bucketValid(bucket, stamp) {
  if (!bucket || typeof bucket !== "object") return false;
  if (bucket.version !== BUCKET_VERSION) return false;
  if (bucket.tzOffset !== localTzOffset()) return false;
  if (!bucket.stamp || typeof bucket.stamp !== "object") return false;
  if (!stamp) return false;
  return bucket.stamp.mtimeMs === stamp.mtimeMs && bucket.stamp.size === stamp.size;
}

/** True when the file was modified within the racy window of `nowMs`. */
function isRacyStamp(stamp, nowMs) {
  return !!stamp && nowMs - stamp.mtimeMs < RACY_WINDOW_MS;
}

/**
 * Fold ONE usage record into a bucket. Must run BEFORE any record-window
 * trimming so the bucket always holds the complete history.
 *
 * `rec.requests` (peer day-summaries) is preserved; local records count 1.
 * `estReq` counts requests whose per-record cost was flagged estimated, so
 * the model row can reproduce aggregate()'s OR-of-records costEstimated.
 */
function foldRecordInto(bucket, rec) {
  if (!rec || rec.kind === "event") return;
  const day = dayKey(rec.time || 0);
  const tools = (bucket.usageDays[day] ||= {});
  const models = (tools[rec.tool] ||= {});
  const modelKey = rec.model || "unknown";
  const entry = (models[modelKey] ||= {
    display: rec.modelDisplay || modelKey,
    // Pricing identity (e.g. qfmodel → qwen3.8-flash). Query-time pricing
    // MUST key on this — the raw routing code has no price row and would
    // silently fall back to the Kimi K2.6 estimate.
    pricingKey: rec.modelResolved || rec.model,
  });
  if (!entry.pricingKey) entry.pricingKey = rec.modelResolved || rec.model;
  const rate = rateKeyFor(rec.modelResolved || rec.model, rec, rec.time);
  const cell = (entry[rate.key] ||= { i: 0, o: 0, cr: 0, cc: 0, req: 0, estReq: 0, credits: 0 });
  const reqs = Number.isFinite(rec.requests) && rec.requests >= 0 ? rec.requests : 1;
  cell.i += rec.inputOther || 0;
  cell.o += rec.output || 0;
  cell.cr += rec.inputCacheRead || 0;
  cell.cc += rec.inputCacheCreation || 0;
  cell.req += reqs;
  cell.credits += rec.credits || 0;
  // Only TIME-derived estimated-ness folds here (no-timestamp DeepSeek);
  // table-row estimated-ness (fallback pricing) is derived at query time by
  // priceForCell, so adding a price row retroactively clears the flag
  // without re-folding. v2: folding rec.costEstimated baked stale table
  // state into buckets.
  if (rate.estimated) cell.estReq += reqs;
  if (!entry.display || entry.display === modelKey) {
    const d = rec.modelDisplay || modelKey;
    if (d && d !== modelKey) entry.display = d;
  }
}

/** Fold tool.call events (tool + name + optional timestamp → day counter).
 *  The tool dimension keeps the "all tools vs one tool" event filter working
 *  once events live in buckets instead of a request-scoped array. */
function foldEventInto(bucket, ev) {
  if (!ev || !ev.eventName) return;
  const day = dayKey(ev.time || 0);
  const tool = ev.tool || "?";
  bucket.eventDays[day] ||= {};
  const names = (bucket.eventDays[day][tool] ||= {});
  names[ev.eventName] = (names[ev.eventName] || 0) + 1;
}

/**
 * Build a fresh bucket from one file's deduped contribution.
 * `signatures` (array of dedup keys this bucket contributed) is persisted
 * with the bucket so a cold start can rebuild the global signature set
 * without re-parsing unchanged files.
 */
function bucketFromRecords(records, events, source, stamp, signatures) {
  const bucket = newBucket(source, stamp);
  if (Array.isArray(signatures)) bucket.signatures = signatures;
  else bucket.signatures = [];
  if (Array.isArray(records)) {
    for (const rec of records) foldRecordInto(bucket, rec);
  }
  if (Array.isArray(events)) {
    for (const ev of events) foldEventInto(bucket, ev);
  }
  return bucket;
}

/**
 * Merge many buckets into one aggregation view ({usageDays, eventDays} with
 * additive counters). Buckets are commutative — merge order is irrelevant.
 */
function mergeBuckets(buckets) {
  const out = newBucket("(merged)", null);
  for (const bucket of buckets) {
    if (!bucket || typeof bucket !== "object") continue;
    for (const [day, tools] of Object.entries(bucket.usageDays || {})) {
      const outTools = (out.usageDays[day] ||= {});
      for (const [tool, models] of Object.entries(tools || {})) {
        const outModels = (outTools[tool] ||= {});
        for (const [model, entry] of Object.entries(models || {})) {
          const outEntry = (outModels[model] ||= {
            display: entry.display || model,
            pricingKey: entry.pricingKey || model,
          });
          if (entry.display && entry.display !== model && (!outEntry.display || outEntry.display === model)) {
            outEntry.display = entry.display;
          }
          if (entry.pricingKey && (!outEntry.pricingKey || outEntry.pricingKey === model)) {
            outEntry.pricingKey = entry.pricingKey;
          }
          for (const key of ["std", "peak", "off", "long"]) {
            const cell = entry[key];
            if (!cell) continue;
            const outCell = (outEntry[key] ||= { i: 0, o: 0, cr: 0, cc: 0, req: 0, estReq: 0, credits: 0 });
            outCell.i += cell.i || 0;
            outCell.o += cell.o || 0;
            outCell.cr += cell.cr || 0;
            outCell.cc += cell.cc || 0;
            outCell.req += cell.req || 0;
            outCell.estReq += cell.estReq || 0;
            outCell.credits += cell.credits || 0;
          }
        }
      }
    }
    for (const [day, tools] of Object.entries(bucket.eventDays || {})) {
      out.eventDays[day] ||= {};
      for (const [tool, names] of Object.entries(tools || {})) {
        const outNames = (out.eventDays[day][tool] ||= {});
        for (const [name, count] of Object.entries(names || {})) {
          outNames[name] = (outNames[name] || 0) + (count || 0);
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Disk persistence
// ---------------------------------------------------------------------------

function bucketFile(toolId, relPath) {
  const hash = crypto
    .createHash("sha1")
    .update(String(relPath || "").replace(/\\/g, "/"))
    .digest("hex");
  return path.join(BUCKETS_DIR, sanitizeToolId(toolId), `${hash}.json`);
}

function sanitizeToolId(toolId) {
  return String(toolId || "x").replace(/[^A-Za-z0-9_-]/g, "_");
}

/** Read and validate a stored bucket; any problem → null (caller re-folds). */
function readStoredBucket(toolId, relPath, stamp) {
  const file = bucketFile(toolId, relPath);
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let bucket;
  try {
    bucket = JSON.parse(raw);
  } catch {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* best effort */
    }
    return null;
  }
  if (!bucketValid(bucket, stamp)) return null;
  return bucket;
}

/** Atomically persist a bucket; racy stamps are never persisted. */
function writeStoredBucket(toolId, relPath, bucket, nowMs = Date.now()) {
  if (!bucket) return false;
  if (isRacyStamp(bucket.stamp, nowMs)) return false;
  const file = bucketFile(toolId, relPath);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(bucket), "utf8");
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  BUCKET_VERSION,
  BUCKETS_DIR,
  RACY_WINDOW_MS,
  localTzOffset,
  newBucket,
  bucketValid,
  isRacyStamp,
  foldRecordInto,
  foldEventInto,
  bucketFromRecords,
  mergeBuckets,
  readStoredBucket,
  writeStoredBucket,
};
