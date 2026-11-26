"use strict";

/**
 * Cursor provider tests — the account-API daily cell pipeline and the
 * aes-256-gcm credential unseal. The live network/DPAPI path is not exercised
 * (no credentials in CI); instead the cache contract that `scan()` consumes
 * is pinned here, because collection is synchronous while the fetch is not.
 */

const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const cursor = require("../src/tools/cursor");
const {
  cellsFromResponse,
  readCursorUsageCache,
  isCursorInstalled,
  unsealValue,
} = require("../src/cursor-usage");

function tmpFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doramonitor-cursor-test-"));
  const file = path.join(dir, name);
  if (content !== undefined) fs.writeFileSync(file, content);
  return file;
}

function writeCache(cells, fetchedAt = new Date().toISOString()) {
  return tmpFile(
    "cursor-usage.json",
    JSON.stringify({ available: true, reason: null, fetchedAt, cells })
  );
}

test("cursor: cellsFromResponse flattens series and drops zero-token days", () => {
  const cells = cellsFromResponse({
    series: [
      {
        dimensions: { model: "grok-4.7" },
        points: [
          { dayStartTime: "2026-11-09T00:00:00.000Z", tokens: 42, includedTokens: 40, contractedCost: "0.0" },
          { dayStartTime: "2026-11-08T00:00:00.000Z", tokens: 0, includedTokens: 0, contractedCost: "0.0" },
        ],
      },
      {
        dimensions: { model: "auto" },
        points: [{ dayStartTime: "2026-11-09T00:00:00.000Z", tokens: 8, includedTokens: 8, contractedCost: "1.5" }],
      },
    ],
  });
  assert.strictEqual(cells.length, 2);
  // Newest day first, then by model within the day.
  assert.deepStrictEqual(cells[0], { day: "2026-11-09", model: "auto", tokens: 8, includedTokens: 8, costUsd: 1.5 });
  assert.deepStrictEqual(cells[1], { day: "2026-11-09", model: "grok-4.7", tokens: 42, includedTokens: 40, costUsd: 0 });
});

test("cursor: recordsFromCells puts the whole total in inputOther", () => {
  const [rec] = cursor.recordsFromCells([
    { day: "2026-11-09", model: "grok-4.7", tokens: 41530832, includedTokens: 41530832, costUsd: 0 },
  ]);
  assert.strictEqual(rec.tool, "cursor");
  assert.strictEqual(rec.model, "grok-4.7");
  assert.strictEqual(rec.inputOther, 41530832);
  assert.strictEqual(rec.output, 0);
  assert.strictEqual(rec.inputCacheRead, 0);
  assert.strictEqual(rec.inputCacheCreation, 0);
  // No request count exists in the source — never invent one.
  assert.strictEqual(rec.requests, 0);
  // Day labels are UTC in the API; records land on local noon of that date.
  assert.strictEqual(rec.time, new Date(2026, 10, 9, 12, 0, 0, 0).getTime());
});

test("cursor: recordsFromCells skips non-positive token rows", () => {
  assert.deepStrictEqual(
    cursor.recordsFromCells([
      { day: "2026-11-09", model: "auto", tokens: 0 },
      { day: "bad-day", model: "auto", tokens: 5 },
    ]).length,
    0
  );
});

test("cursor: unsealValue round-trips the safe-storage layout", () => {
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update("jwt-payload"), cipher.final()]);
  const sealed =
    "cursor-safe-storage:v1:" +
    Buffer.concat([Buffer.from("v10", "latin1"), iv, ciphertext, cipher.getAuthTag()]).toString("base64");
  assert.strictEqual(unsealValue(key, sealed), "jwt-payload");
  assert.strictEqual(unsealValue(key, "plain-value"), null);
});

test("cursor: scan serves the persisted daily cells", () => {
  const cacheFile = writeCache([
    { day: "2026-11-09", model: "grok-4.7", tokens: 100, includedTokens: 100, costUsd: 0 },
    { day: "2026-11-08", model: "auto", tokens: 50, includedTokens: 50, costUsd: 0 },
  ]);
  // A fresh cache makes wakeCursorRefresh a no-op, so scan never hits the network.
  const out = cursor.scan(tmpFile("unused"), { cacheFile });
  assert.strictEqual(out.records.length, 2);
  assert.strictEqual(out.records[0].inputOther, 100);
  assert.strictEqual(out.meta.recordCount, 2);
  assert.ok(out.meta.fetchedAt);
  assert.deepStrictEqual(out.meta.errors, []);
});

test("cursor: scan reports a missing cache without throwing", () => {
  const out = cursor.scan(tmpFile("unused"), { cacheFile: path.join(os.tmpdir(), "nope-cursor-cache.json") });
  assert.strictEqual(out.records.length, 0);
  assert.strictEqual(out.meta.errors.length, 1);
});

test("cursor: cache rejects malformed or unavailable payloads", () => {
  assert.strictEqual(readCursorUsageCache(tmpFile("bad.json", "{oops")), null);
  assert.strictEqual(
    readCursorUsageCache(tmpFile("u.json", JSON.stringify({ available: false, cells: [] }))),
    null
  );
});

test("cursor: isCursorInstalled needs both the credential DB and Local State", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "doramonitor-cursor-home-"));
  assert.strictEqual(isCursorInstalled(home), false);
  fs.mkdirSync(path.join(home, "User", "globalStorage"), { recursive: true });
  fs.writeFileSync(path.join(home, "User", "globalStorage", "state.vscdb"), "");
  assert.strictEqual(isCursorInstalled(home), false);
  fs.writeFileSync(path.join(home, "Local State"), "{}");
  assert.strictEqual(isCursorInstalled(home), true);
});
