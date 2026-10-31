"use strict";

const assert = require("node:assert");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { appendSamples, setCheckpoint } = require("../src/quota-estimator-store");
const {
  maybeRunScheduledEstimation,
  estimateScopeFor,
  SCHEDULED_MIN_MINUTES,
  SCHEDULED_MIN_DELTA,
  SCHEDULED_DELTA_PERCENT,
  SCHEDULED_MIN_GAP_MS,
} = require("../src/quota-sampler");

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "doramonitor-sampler-"));
}

function kimiSample(usedPercent, sampledAt, overrides = {}) {
  return { version: 1, provider: "kimi", accountKey: "kimi:default", window: "session", usedPercent, sampledAt, source: "kimi-api", ...overrides };
}

test("scheduled estimation sets an anchor on the first sighting and does not fire", () => {
  const root = tempRoot();
  const now = Date.now();
  appendSamples([kimiSample(10, new Date(now).toISOString())], root);
  const fired = maybeRunScheduledEstimation(root, { now, calculate: () => assert.fail("must not fire") });
  assert.deepEqual(fired, []);
});

test("amount trigger fires alone after the quota grew by the delta percent", () => {
  const root = tempRoot();
  const now = Date.now();
  appendSamples([kimiSample(10, new Date(now - 60_000).toISOString())], root);
  assert.deepEqual(maybeRunScheduledEstimation(root, { now, calculate: () => assert.fail("anchor only") }), []);
  appendSamples([kimiSample(10 + SCHEDULED_DELTA_PERCENT, new Date(now).toISOString())], root);
  const fired = maybeRunScheduledEstimation(root, { now, calculate: () => {} });
  assert.equal(fired.length, 1);
  assert.equal(fired[0].provider, "kimi");
  assert.equal(fired[0].accountKey, "kimi:default");
});

test("duration trigger needs both elapsed minutes and the minimum delta", () => {
  const root = tempRoot();
  const now = Date.now();
  appendSamples([kimiSample(10, new Date(now - (SCHEDULED_MIN_MINUTES + 5) * 60_000).toISOString())], root);
  maybeRunScheduledEstimation(root, { now, calculate: () => assert.fail("anchor only") });
  // Enough time but below the minimum delta — must not fire.
  appendSamples([kimiSample(10 + SCHEDULED_MIN_DELTA - 0.5, new Date(now).toISOString())], root);
  assert.deepEqual(maybeRunScheduledEstimation(root, { now, calculate: () => assert.fail("below min delta") }), []);
  // Duration + minimum delta — fires.
  appendSamples([kimiSample(10 + SCHEDULED_MIN_DELTA, new Date(now).toISOString())], root);
  const fired = maybeRunScheduledEstimation(root, { now, calculate: () => {} });
  assert.equal(fired.length, 1);
});

test("a quota window reset re-anchors instead of firing", () => {
  const root = tempRoot();
  const now = Date.now();
  appendSamples([kimiSample(80, new Date(now - 120_000).toISOString())], root);
  maybeRunScheduledEstimation(root, { now, calculate: () => assert.fail("anchor only") });
  appendSamples([kimiSample(5, new Date(now).toISOString())], root);
  const fired = maybeRunScheduledEstimation(root, { now, calculate: () => assert.fail("reset must not fire") });
  assert.deepEqual(fired, []);
});

test("the minimum gap suppresses immediate repeat firing", () => {
  const root = tempRoot();
  const now = Date.now();
  appendSamples([kimiSample(10, new Date(now - 120_000).toISOString())], root);
  maybeRunScheduledEstimation(root, { now, calculate: () => {} });
  // First trigger fires and stamps lastRunAt…
  appendSamples([kimiSample(10 + SCHEDULED_DELTA_PERCENT, new Date(now).toISOString())], root);
  assert.equal(maybeRunScheduledEstimation(root, { now, calculate: () => {} }).length, 1);
  // …so growth inside the gap is suppressed…
  appendSamples([kimiSample(10 + 2 * SCHEDULED_DELTA_PERCENT, new Date(now).toISOString())], root);
  const suppressed = maybeRunScheduledEstimation(root, { now, calculate: () => assert.fail("gap suppresses") });
  assert.deepEqual(suppressed, []);
  // …and after the gap the accumulated growth fires again.
  const later = now + SCHEDULED_MIN_GAP_MS + 1;
  appendSamples([kimiSample(10 + 3 * SCHEDULED_DELTA_PERCENT, new Date(later).toISOString())], root);
  const refired = maybeRunScheduledEstimation(root, { now: later, calculate: () => {} });
  assert.equal(refired.length, 1);
});

test("a reset timestamp change re-anchors even when used percent is unchanged", () => {
  const root = tempRoot();
  const now = Date.now();
  appendSamples([kimiSample(10, new Date(now - 120_000).toISOString(), { resetsAt: "old-window" })], root);
  maybeRunScheduledEstimation(root, { now, calculate: () => assert.fail("anchor only") });
  appendSamples([kimiSample(10, new Date(now).toISOString(), { resetsAt: "new-window" })], root);
  const fired = maybeRunScheduledEstimation(root, { now, calculate: () => assert.fail("reset must not fire") });
  assert.deepEqual(fired, []);
});

test("a failed scheduled calculation keeps its anchor and retries the same interval", () => {
  const root = tempRoot();
  const now = Date.now();
  appendSamples([kimiSample(10, new Date(now - 120_000).toISOString())], root);
  maybeRunScheduledEstimation(root, { now, calculate: () => assert.fail("anchor only") });
  appendSamples([kimiSample(10 + SCHEDULED_DELTA_PERCENT, new Date(now).toISOString())], root);
  assert.equal(maybeRunScheduledEstimation(root, { now, calculate: () => { throw new Error("temporary failure"); } }).length, 1);
  assert.equal(maybeRunScheduledEstimation(root, { now, calculate: () => {} }).length, 1);
  assert.equal(maybeRunScheduledEstimation(root, { now }).length, 0);
});

test("session and weekly schedules fire independently", () => {
  const root = tempRoot();
  const now = Date.now();
  appendSamples([
    kimiSample(10, new Date(now - 120_000).toISOString()),
    kimiSample(10, new Date(now - 120_000).toISOString(), { window: "weekly" }),
  ], root);
  maybeRunScheduledEstimation(root, { now, calculate: () => assert.fail("anchor only") });
  appendSamples([
    kimiSample(10 + SCHEDULED_DELTA_PERCENT, new Date(now).toISOString()),
    kimiSample(11, new Date(now).toISOString(), { window: "weekly" }),
  ], root);
  const fired = maybeRunScheduledEstimation(root, { now, calculate: () => {} });
  assert.equal(fired.length, 1);
  assert.equal(fired[0].window, "session");
  assert.equal(fired[0].estimateKind, "standard");
});

test("scheduled estimation ignores legacy long-term anchors", () => {
  const root = tempRoot();
  const now = Date.now();
  for (const window of ["session", "weekly"]) {
    setCheckpoint(`long-term-estimation:kimi\0kimi:default\0${window}`, {
      anchorAt: new Date(now - 6 * 60 * 60_000).toISOString(),
      anchorPercent: 10,
      resetsAt: null,
      lastRunAt: null,
    }, root);
  }
  appendSamples([
    kimiSample(30, new Date(now).toISOString()),
    kimiSample(30, new Date(now).toISOString(), { window: "weekly" }),
  ], root);
  const fired = maybeRunScheduledEstimation(root, { now, calculate: () => assert.fail("first standard anchor only") });
  assert.deepEqual(fired, []);
});

test("scope selection follows the estimation settings", () => {
  assert.equal(estimateScopeFor("kimi", {}), "all-clients");
  assert.equal(estimateScopeFor("kimi", { quotaEstimation: { kimiCodeOnly: true } }), "kimi-code-only");
  assert.equal(estimateScopeFor("openai", {}), "all-clients");
  assert.equal(estimateScopeFor("openai", { quotaEstimation: { codexOnly: true } }), "codex-only");
});
