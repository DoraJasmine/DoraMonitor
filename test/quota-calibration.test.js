"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { startCalibration, finishCalibration, cancelCalibration, listCalibrations } = require("../src/quota-calibration");
const { readSamples } = require("../src/quota-estimator-store");

const T0 = Date.parse("2026-10-30T10:00:00Z");
const base = { provider: "openai", accountKey: "openai:test", usageScope: "all-clients", window: "session" };

function root() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dora-calibration-"));
}

function quota(usedPercent) {
  return { available: true, windows: [{ kind: "session", usedPercent, resetsAt: "2026-10-30T15:00:00Z" }] };
}

function usage(time, totalTokens = 20_000) {
  return [{
    tool: "codex",
    model: "gpt-6",
    modelResolved: "gpt-6",
    time,
    inputOther: totalTokens / 2,
    inputCacheRead: totalTokens / 2,
    inputCacheCreation: 0,
    output: 0,
    costCny: 1,
  }];
}

test("manual calibration rejects short, low-usage and unchanged intervals", () => {
  const store = root();
  startCalibration({ ...base, quota: quota(10), root: store, now: T0 });
  assert.throws(() => finishCalibration({ ...base, quota: quota(12), records: usage(T0 + 30_000), root: store, now: T0 + 60_000 }), (error) => error.code === "calibration_too_short");
  assert.throws(() => finishCalibration({ ...base, quota: quota(12), records: usage(T0 + 30_000, 100), root: store, now: T0 + 6 * 60_000 }), (error) => error.code === "calibration_too_few_tokens");
  assert.throws(() => finishCalibration({ ...base, quota: quota(10), records: usage(T0 + 30_000), root: store, now: T0 + 6 * 60_000 }), (error) => error.code === "calibration_no_quota_change");
  assert.equal(listCalibrations(base, store).length, 1);
});

test("manual calibration persists exact endpoints and completes once", () => {
  const store = root();
  startCalibration({ ...base, quota: quota(10), root: store, now: T0 });
  assert.throws(() => startCalibration({ ...base, quota: quota(10), root: store, now: T0 + 1000 }), (error) => error.code === "calibration_exists");
  const completed = finishCalibration({ ...base, quota: quota(12), records: usage(T0 + 30_000), root: store, now: T0 + 6 * 60_000 });
  assert.equal(completed.percentSpan, 2);
  assert.equal(completed.totalTokens, 20_000);
  assert.equal(completed.costCny, 1);
  assert.equal(listCalibrations(base, store).length, 0);
  const samples = readSamples(store, T0 + 7 * 60_000);
  assert.equal(samples.length, 2);
  assert.equal(samples[0].sampledAt, new Date(T0).toISOString());
  assert.equal(samples[1].sampledAt, new Date(T0 + 6 * 60_000).toISOString());
  assert.throws(() => finishCalibration({ ...base, quota: quota(12), records: [], root: store, now: T0 + 7 * 60_000 }), (error) => error.code === "calibration_not_found");
});

test("manual calibration can cancel a reset or abandoned interval", () => {
  const store = root();
  startCalibration({ ...base, quota: quota(10), root: store, now: T0 });
  cancelCalibration({ ...base, root: store });
  assert.deepEqual(listCalibrations(base, store), []);
});
