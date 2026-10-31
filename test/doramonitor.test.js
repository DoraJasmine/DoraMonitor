"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { isDoraMonitorHealthy } = require("../src/doramonitor");

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("background startup accepts the DoraMonitor health endpoint", async () => {
  let requestedPath = null;
  await withServer((req, res) => {
    requestedPath = req.url;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  }, async (port) => {
    assert.equal(await isDoraMonitorHealthy("127.0.0.1", port), true);
  });
  assert.equal(requestedPath, "/api/health");
});

test("background startup rejects unrelated servers and closed ports", async () => {
  await withServer((req, res) => {
    res.statusCode = 200;
    res.end("not json");
  }, async (port) => {
    assert.equal(await isDoraMonitorHealthy("127.0.0.1", port), false);
  });

  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await isDoraMonitorHealthy("127.0.0.1", port), false);
});
