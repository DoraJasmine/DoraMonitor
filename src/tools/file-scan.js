"use strict";

const path = require("path");
const { fileStamp } = require("./base");
const {
  isRacyStamp,
  readStoredBucket,
  writeStoredBucket,
} = require("../buckets");
const { rateKeyFor, priceForCell } = require("../pricing");

/**
 * Shared per-file incremental scan skeleton for the heavy tools
 * (kimi-code / codex / dsh) — phase 3 day-bucket integration.
 *
 * Ordering: files are processed oldest-mtime first. Cross-file dedup is
 * first-wins over that order, so a forked copy (newer mtime) of a parent
 * file (older mtime) is deduped against the parent — and, crucially, the
 * set of files whose dedup contribution can possibly change after an edit
 * starts at the edited file's mtime. Files older than `recordSince` (the
 * 30-day recent window + margin) keep their day-buckets but drop their
 * parsed records, so memory stays bounded while cold starts read no old
 * files.
 *
 * Buckets fold the DEDUPED contribution of each file; each bucket persists
 * the signatures it contributed (`bucket.signatures`) so a cold start can
 * rebuild the global signature set without re-parsing unchanged files —
 * otherwise a new fork copying an old file's lines would double-count in
 * the buckets.
 *
 * Records without a signature (see signatureOf) never dedup and fold
 * unconditionally — same as the in-memory behavior today.
 *
 * Scan paths per file, in order:
 *   1. cache hit (stamp match, not racy, not in the propagation window)
 *      → reuse parsed + bucket as-is.
 *   2. memory miss, outside the window, persisted bucket matches
 *      → zero-file-read bucket reuse (the cold-start fast path).
 *   3. otherwise re-parse (or reuse still-fresh cached parse) and re-fold
 *      the bucket from the deduped contribution.
 */

/**
 * @param {object} cfg
 *   id:          tool id (bucket dir)
 *   home:        data home (relPath base)
 *   files:       absolute file paths (unsorted ok)
 *   parseFile:   (file) => { records, events?, lines, errors? } — records
 *                are PRE-dedup parsed records of this file.
 *   signatureOf: (record) => string | "" — stable cross-file dedup key;
 *                "" means "never dedup".
 *   foldBucket:  (contributed, events, relPath, stamp, signatures)
 *                => bucket (see buckets.js).
 *   cacheMap:    per-home Map for { stamp, parsed, bucket, racy } entries.
 *   recordSince: ms epoch — records newer than this are returned; older
 *                files keep buckets only. 0 keeps everything (tests).
 * @returns { records, events, buckets, errors, meta }
 */
/**
 * Re-price persisted records with the CURRENT price table. Stored records
 * carry the costCny of their original parse; after a price-table update
 * (code change + restart) those amounts would disagree with the bucket
 * aggregates, which price at query time. Credits-only rows keep zero cost.
 */
function recostRecords(records, settings) {
  for (const rec of records) {
    if (!rec || rec.kind === "event") continue;
    const rate = rateKeyFor(rec.modelResolved || rec.model, rec, rec.time);
    let priceEstimated = false;
    if (rec.credits > 0) {
      rec.costCny = 0;
    } else {
      const p = priceForCell(rec.modelResolved || rec.model, rate.key, settings || {});
      priceEstimated = !!p.estimated;
      rec.costCny =
        ((rec.inputOther || 0) / 1e6) * p.input +
        ((rec.inputCacheRead || 0) / 1e6) * p.cacheHit +
        ((rec.inputCacheCreation || 0) / 1e6) * (p.cacheWrite ?? p.input) +
        ((rec.output || 0) / 1e6) * p.output;
      rec.priceId = p.id;
    }
    rec.costEstimated = rate.estimated || priceEstimated;
  }
}

function scanFilesWithBuckets(cfg) {
  const { id, home, files, parseFile, signatureOf, foldBucket, cacheMap } = cfg;
  const recordSince = Number.isFinite(cfg.recordSince) ? cfg.recordSince : 0;
  const nowMs = Date.now();

  // Probe stamps once; order by (mtime, path) — oldest first.
  const stamped = [];
  for (const file of files) {
    const st = fileStamp(file);
    stamped.push({
      file,
      relPath: path.relative(home, file),
      stamp: st ? { mtimeMs: st.mtimeMs, size: st.size } : null,
    });
  }
  stamped.sort((a, b) => {
    const am = a.stamp ? a.stamp.mtimeMs : 0;
    const bm = b.stamp ? b.stamp.mtimeMs : 0;
    if (am !== bm) return am - bm;
    return a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
  });

  const signatures = new Set(); // global dedup set, rebuilt per scan
  const buckets = [];
  const errors = [];
  const outRecords = [];
  const outEvents = [];
  let filesReread = 0;
  let propagationRebuilds = 0;
  let bucketDiskHits = 0;
  let bucketWrites = 0;
  let duplicatesSkipped = 0;
  /** mtime of the first file re-parsed this scan; see the header comment. */
  let changedFromMtime = Infinity;

  for (const { file, relPath, stamp } of stamped) {
    const racy = isRacyStamp(stamp, nowMs);
    const needRecords = !stamp || !recordSince || stamp.mtimeMs >= recordSince;
    const propagation = !!stamp && stamp.mtimeMs >= changedFromMtime;
    const stampMatch = (c) =>
      !!(c && c.stamp && stamp &&
        c.stamp.mtimeMs === stamp.mtimeMs && c.stamp.size === stamp.size);

    let cached = cacheMap.get(file);
    let parsed = null;
    let bucket = null;
    /** The file's DEDUPED contribution — what output records come from. */
    let contributed = null;

    if (cached && !cached.racy && !racy && stampMatch(cached) && !propagation) {
      // (1) plain cache hit — reuse the persisted deduped contribution.
      parsed = cached.parsed;
      bucket = cached.bucket;
      contributed = cached.contributed || parsed.records;
      if (!needRecords && contributed.length) {
        parsed = { ...parsed, records: [], events: [] };
        cached = {
          ...cached,
          parsed,
          contributed: [],
          // Drop the in-memory records payload too — the bucket object
          // otherwise keeps the whole array alive.
          bucket: cached.bucket ? { ...cached.bucket, records: [], events: [] } : cached.bucket,
        };
        cacheMap.set(file, cached);
      }
    } else {
      let diskBucket = null;
      // A stored bucket serves both needs: its day cells always, and its
      // `records` payload (see fold below) for the recent-requests window —
      // so a cold start parses NOTHING when every bucket is intact.
      if (stamp && !racy && !propagation) {
        diskBucket = readStoredBucket(id, relPath, stamp);
        if (diskBucket && needRecords && !Array.isArray(diskBucket.records)) {
          // Windowed file whose bucket predates record persistence → fold
          // once more, then the payload exists.
          diskBucket = null;
        }
      }
      if (diskBucket) {
        // (2) cold-start fast path: persisted bucket, no file read.
        // Records ride along for windowed files; re-priced under the
        // current table so recent rows agree with query-time aggregates.
        const storedRecords = Array.isArray(diskBucket.records) ? diskBucket.records : [];
        recostRecords(storedRecords, cfg.settings);
        parsed = {
          records: storedRecords,
          events: Array.isArray(diskBucket.events) ? diskBucket.events : [],
          lines: diskBucket.lines || 0,
          errors: [],
        };
        bucket = diskBucket;
        contributed = storedRecords;
        bucketDiskHits += 1;
        cacheMap.set(file, { stamp, parsed, bucket, contributed: storedRecords, racy: false });
      } else {
        // (3) re-parse, or reuse a still-fresh cached parse when only the
        // propagation window forced us off the cache-hit path.
        const cachedFresh =
          cached && !cached.racy && stampMatch(cached) &&
          cached.parsed && cached.parsed.records.length > 0;
        if (cachedFresh) {
          parsed = cached.parsed;
          propagationRebuilds += 1;
        } else {
          parsed = parseFile(file);
          filesReread += 1;
          if (stamp) changedFromMtime = Math.min(changedFromMtime, stamp.mtimeMs);
          for (const err of parsed.errors || []) errors.push(err);
        }
        cacheMap.set(file, { stamp, parsed, bucket: null, contributed: null, racy });
      }
    }

    // Rebuild the global signature set from persisted contributions.
    if (bucket && Array.isArray(bucket.signatures)) {
      for (const sig of bucket.signatures) signatures.add(sig);
    }

    // Fold the deduped contribution into a bucket when it was re-derived.
    if (!bucket) {
      const kept = [];
      const fileSigs = [];
      for (const rec of parsed.records) {
        const sig = signatureOf ? signatureOf(rec) : "";
        if (sig) {
          if (signatures.has(sig)) {
            duplicatesSkipped += 1;
            continue;
          }
          signatures.add(sig);
          fileSigs.push(sig);
        }
        kept.push(rec);
      }
      contributed = kept;
      bucket = foldBucket(contributed, parsed, relPath, stamp, fileSigs);
      // Persist the deduped contribution for windowed files so a cold
      // start can serve the recent-requests table without re-parsing. The
      // payload is attached even when EMPTY: forked/archived copies
      // contribute nothing, and without the (empty) marker every restart
      // would re-parse them just to rediscover the empty contribution.
      if (needRecords) {
        bucket.records = contributed;
        bucket.events = parsed.events || [];
      }
      if (writeStoredBucket(id, relPath, bucket, nowMs)) bucketWrites += 1;
      const entry = cacheMap.get(file);
      if (entry) {
        entry.bucket = bucket;
        entry.contributed = contributed;
        if (!needRecords && entry.parsed.records.length) {
          entry.parsed = { ...entry.parsed, records: [], events: [] };
          entry.contributed = [];
          entry.bucket = { ...bucket, records: [], events: [] };
          parsed = entry.parsed;
          contributed = [];
        }
      }
    }

    buckets.push({ relPath, bucket });
    if (needRecords) {
      for (const rec of contributed) outRecords.push(rec);
      for (const ev of parsed.events || []) outEvents.push(ev);
    }
  }

  // Prune cache entries for files that disappeared.
  if (cacheMap.size > stamped.length) {
    const present = new Set(stamped.map((s) => s.file));
    for (const key of [...cacheMap.keys()]) {
      if (!present.has(key)) cacheMap.delete(key);
    }
  }

  outRecords.sort((a, b) => b.time - a.time);
  outEvents.sort((a, b) => b.time - a.time);

  return {
    records: outRecords,
    events: outEvents,
    buckets,
    errors,
    meta: {
      filesScanned: stamped.length,
      filesReread,
      propagationRebuilds,
      bucketDiskHits,
      bucketWrites,
      duplicatesSkipped,
      recordCount: outRecords.length,
      recordCountWindowed: outRecords.length,
    },
  };
}

module.exports = { scanFilesWithBuckets };
