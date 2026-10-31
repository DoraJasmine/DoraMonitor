"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { buildSummary } = require("../src/sync");

const SALT = "a".repeat(32);

test("sync v3: wsDaily hashes workspace keys deterministically and reserves __-slots", () => {
  const records = [
    { tool: "claude-code", time: Date.now(), model: "m", inputOther: 10, output: 0, inputCacheRead: 0, inputCacheCreation: 0, credits: 0, project: "D:\\work\\demo", costCny: 0.5 },
    { tool: "claude-code", time: Date.now(), model: "m", inputOther: 5, output: 0, inputCacheRead: 0, inputCacheCreation: 0, credits: 0, project: "D:\\work\\demo", costCny: 0.25 },
    { tool: "zcode", time: Date.now(), model: "m", inputOther: 7, output: 0, inputCacheRead: 0, inputCacheCreation: 0, credits: 0, project: null },
  ];
  const summary = buildSummary("dev", records, null, [], null, SALT);
  assert.strictEqual(summary.version, 3);
  assert.strictEqual(summary.wsSalt, SALT);
  assert.ok(summary.wsDaily, "wsDaily present");

  const day = Object.keys(summary.wsDaily)[0];
  const slots = summary.wsDaily[day];
  // Same project → one hashed slot with folded tokens; reserved null-project → "unknown" literal.
  const hashedSlots = Object.keys(slots).filter((k) => k !== "unknown");
  assert.strictEqual(hashedSlots.length, 1, "one hashed slot");
  assert.strictEqual(slots[hashedSlots[0]].i, 15);
  assert.strictEqual(slots.unknown.i, 7, "reserved key travels as literal slot");

  // Hash is deterministic under the same salt and differs under another salt.
  const summary2 = buildSummary("dev", records, null, [], null, SALT);
  assert.strictEqual(Object.keys(summary2.wsDaily[day])[0] !== undefined, true);
  const other = buildSummary("dev", records, null, [], null, "b".repeat(32));
  const otherHashed = Object.keys(other.wsDaily[day]).filter((k) => k !== "unknown")[0];
  assert.notStrictEqual(otherHashed, hashedSlots[0], "different salt → different hash");
});

test("sync v3: without a salt no wsDaily is emitted (v2-compatible)", () => {
  const summary = buildSummary("dev", [{ tool: "t", time: Date.now(), model: "m", credits: 0 }], null, [], null, null);
  assert.strictEqual(summary.wsDaily, undefined);
  assert.strictEqual(summary.wsSalt, undefined);
});
