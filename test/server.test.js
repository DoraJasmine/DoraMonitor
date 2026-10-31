"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { DEFAULT_HOST, createServer, parseArgs, urlHost, requestAllowed, settingsView } = require("../src/server");

test("server: defaults to the IPv4 loopback interface", () => {
  assert.equal(DEFAULT_HOST, "127.0.0.1");
  assert.equal(parseArgs([]).host, "127.0.0.1");
});

test("server: preserves an explicit host override", () => {
  assert.equal(parseArgs(["node", "server.js", "--host", "::1"]).host, "::1");
});

test("server: formats wildcard and IPv6 hosts for URLs", () => {
  assert.equal(urlHost("::"), "127.0.0.1");
  assert.equal(urlHost("0.0.0.0"), "127.0.0.1");
  assert.equal(urlHost("::1"), "[::1]");
});

test("settings view hides the WebDAV password without mutating saved settings", () => {
  const settings = { currency: "CNY", sync: { backend: "webdav", webdav: { username: "u", password: "secret" } } };
  const view = settingsView(settings);
  assert.equal(view.sync.webdav.password, undefined);
  assert.equal(view.sync.webdav.hasPassword, true);
  assert.equal(view.sync.webdav.username, "u");
  assert.equal(settings.sync.webdav.password, "secret");
  assert.equal(JSON.stringify(view).includes("secret"), false);
});

test("loopback server rejects rebinding and cross-site writes", () => {
  assert.equal(requestAllowed({ method: "GET", headers: { host: "evil.example" } }), false);
  assert.equal(requestAllowed({ method: "POST", headers: { host: "127.0.0.1:3847", origin: "https://evil.example" } }), false);
  assert.equal(requestAllowed({ method: "POST", headers: { host: "127.0.0.1:3847", origin: "http://127.0.0.1:3847" } }), true);
  assert.equal(requestAllowed({ method: "POST", headers: { host: "127.0.0.1:3847" } }), true);
  assert.equal(requestAllowed({ method: "POST", headers: { host: "192.168.1.20:3847" } }, "0.0.0.0"), true);
});

test("HTTP server enforces the origin guard before running mutations", async (t) => {
  const server = createServer(null);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  const rejected = await fetch(`${base}/api/sync`, { method: "POST", headers: { Origin: "https://evil.example" } });
  assert.equal(rejected.status, 403);
  assert.equal((await rejected.json()).error, "forbidden_origin");
});
