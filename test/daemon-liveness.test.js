"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { isDaemonRunning, processIsRunning } = require("../src/daemon-liveness");

test("daemon liveness requires a fresh heartbeat and a live owner", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dora-daemon-live-"));
  const file = path.join(root, "daemon.pid");
  const now = Date.now();
  assert.equal(isDaemonRunning({ file, now, processCheck: () => true }), false);

  fs.writeFileSync(file, "12345\n");
  assert.equal(isDaemonRunning({ file, now, processCheck: () => true }), true);
  assert.equal(isDaemonRunning({ file, now, processCheck: () => false }), false);

  const stale = new Date(now - 120_001);
  fs.utimesSync(file, stale, stale);
  assert.equal(isDaemonRunning({ file, now, processCheck: () => true }), false);

  const fresh = new Date(now + 5000);
  fs.utimesSync(file, fresh, fresh);
  assert.equal(isDaemonRunning({ file, now, processCheck: () => true }), true);
});

test("daemon liveness rejects invalid and unused pids", () => {
  assert.equal(processIsRunning(0), false);
  assert.equal(processIsRunning(-1), false);
  assert.equal(processIsRunning(Number.NaN), false);
});
