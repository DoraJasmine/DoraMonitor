"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { DEFAULT_HOST, parseArgs, urlHost, settingsView } = require("../src/server");

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
