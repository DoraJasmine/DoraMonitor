"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { runSync, peerRecordsCached } = require("../src/sync");
const { sanitizeSettings } = require("../src/settings");

function settings(shared, deviceName) {
  return {
    sync: {
      enabled: true,
      backend: "local",
      deviceName,
      local: { path: shared },
    },
  };
}

function record(model) {
  return {
    tool: "kimi-code",
    time: Date.parse("2026-10-31T08:00:00Z"),
    model,
    inputOther: 100,
    output: 20,
    inputCacheRead: 300,
    inputCacheCreation: 10,
  };
}

test("local sync settings preserve the shared path and legacy defaults", () => {
  const local = sanitizeSettings({ sync: { enabled: true, backend: "local", deviceName: "wsl", local: { path: "/mnt/c/dora" } } });
  assert.equal(local.sync.backend, "local");
  assert.equal(local.sync.local.path, "/mnt/c/dora");
  assert.equal(local.sync.ssh.port, 22);
  assert.equal(sanitizeSettings({ sync: { backend: "unknown" } }).sync.backend, "ssh");
});

test("local directory sync exchanges v1/v2 peers and survives offline reads", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dora-local-sync-"));
  const shared = path.join(root, "shared");
  const windowsHome = path.join(root, "windows-home");
  const wslHome = path.join(root, "wsl-home");
  let home = windowsHome;
  t.mock.method(os, "homedir", () => home);

  const windows = await runSync([record("k3.1-pro")], settings(shared, "desktop-win"));
  assert.equal(windows.uploaded, true);
  assert.equal(windows.downloaded, true);
  assert.deepEqual(windows.peers, []);

  const remoteDir = path.join(shared, "ai-usage-monitor");
  fs.writeFileSync(path.join(remoteDir, "legacy.json"), JSON.stringify({
    version: 1,
    device: "legacy",
    days: { "2026-10-30": { codex: { "gpt-5": { i: 1, o: 2, cr: 3, cc: 4, req: 1 } } } },
  }));
  fs.writeFileSync(path.join(remoteDir, "broken.json"), "not json");

  home = wslHome;
  const wsl = await runSync([record("k2.7-code")], settings(shared, "desktop-wsl"));
  assert.equal(wsl.uploaded, true);
  assert.deepEqual(wsl.peers.map((peer) => peer.device).sort(), ["desktop-win", "legacy"]);

  home = windowsHome;
  const windowsAgain = await runSync([record("k3.1-pro")], settings(shared, "desktop-win"));
  assert.equal(windowsAgain.uploaded, true);
  assert.deepEqual(windowsAgain.peers.map((peer) => peer.device).sort(), ["desktop-wsl", "legacy"]);
  assert.ok(windowsAgain.peers.find((peer) => peer.device === "desktop-wsl").deviceId);
  assert.ok(peerRecordsCached().some((item) => item.device === "desktop-wsl" && item.model === "k2.7-code"));

  const disconnected = path.join(root, "disconnected");
  fs.writeFileSync(disconnected, "not a directory");
  const offline = await runSync([], settings(disconnected, "desktop-win"));
  assert.equal(offline.uploaded, false);
  assert.equal(offline.fromCache, true);
  assert.deepEqual(offline.peers.map((peer) => peer.device).sort(), ["desktop-wsl", "legacy"]);
  assert.equal(fs.readdirSync(remoteDir).some((name) => name.endsWith(".tmp")), false);
});

test("local sync rejects a duplicate device name without overwriting data", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dora-device-identity-"));
  const shared = path.join(root, "shared");
  let home = path.join(root, "home-a");
  t.mock.method(os, "homedir", () => home);

  const first = await runSync([record("first")], settings(shared, "same-host"));
  assert.equal(first.uploaded, true);
  const ownFile = path.join(shared, "ai-usage-monitor", "same-host.json");
  const original = fs.readFileSync(ownFile, "utf8");

  home = path.join(root, "home-b");
  const duplicate = await runSync([record("second")], settings(shared, "same-host"));
  assert.equal(duplicate.uploaded, false);
  assert.equal(duplicate.uploadError, "duplicate_device_name");
  assert.equal(duplicate.error, "duplicate_device_name");
  assert.equal(fs.readFileSync(ownFile, "utf8"), original);
});

test("local sync rejects ambiguous relative paths", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dora-local-path-"));
  t.mock.method(os, "homedir", () => home);
  const result = await runSync([], settings("relative/shared", "desktop-wsl"));
  assert.equal(result.uploaded, false);
  assert.equal(result.uploadError, "local path must be absolute");
  assert.equal(result.downloaded, false);
});

test("local sync serializes writers and recovers an abandoned lock", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dora-local-lock-"));
  const shared = path.join(root, "shared");
  const remoteDir = path.join(shared, "ai-usage-monitor");
  const lock = path.join(remoteDir, ".desktop-win.json.lock");
  fs.mkdirSync(remoteDir, { recursive: true });
  fs.writeFileSync(lock, "busy");
  t.mock.method(os, "homedir", () => path.join(root, "home"));

  const busy = await runSync([], settings(shared, "desktop-win"));
  assert.equal(busy.uploadError, "device_sync_in_progress");
  const old = new Date(Date.now() - 61_000);
  fs.utimesSync(lock, old, old);
  const recovered = await runSync([], settings(shared, "desktop-win"));
  assert.equal(recovered.uploaded, true);
  assert.equal(fs.existsSync(lock), false);
});
