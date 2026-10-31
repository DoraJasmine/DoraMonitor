"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const DAEMON_HEARTBEAT_STALE_MS = 120_000;

function daemonPidFile() {
  return path.join(os.homedir(), ".doramonitor", "daemon.pid");
}

function processIsRunning(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform !== "win32") {
    try {
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
      if (!/cli\.js|ai-usage|doramonitor/.test(cmd)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function isDaemonRunning({ file = daemonPidFile(), now = Date.now(), staleMs = DAEMON_HEARTBEAT_STALE_MS, processCheck = processIsRunning } = {}) {
  try {
    if (now - fs.statSync(file).mtimeMs > staleMs) return false;
    const pid = Number.parseInt(fs.readFileSync(file, "utf8").trim(), 10);
    return processCheck(pid);
  } catch {
    return false;
  }
}

module.exports = { daemonPidFile, processIsRunning, isDaemonRunning, DAEMON_HEARTBEAT_STALE_MS };
