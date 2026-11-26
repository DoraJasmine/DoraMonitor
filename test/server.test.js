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
  const syncPage = await fetch(`${base}/sync`);
  assert.equal(syncPage.status, 200);
  const syncStatus = await fetch(`${base}/api/sync`);
  assert.equal(syncStatus.status, 200);
  const syncBody = await syncStatus.json();
  assert.equal(typeof syncBody.configured, "boolean");
  assert.equal(Object.hasOwn(syncBody, "ssh"), false);
  const rejected = await fetch(`${base}/api/sync`, { method: "POST", headers: { Origin: "https://evil.example" } });
  assert.equal(rejected.status, 403);
  assert.equal((await rejected.json()).error, "forbidden_origin");

  // /api/usage/peer-workspaces: device=local returns empty; tool & range params filter properly.
  const localPeerWs = await fetch(`${base}/api/usage/peer-workspaces?device=local&tool=antigravity`);
  assert.equal(localPeerWs.status, 200);
  assert.deepEqual(await localPeerWs.json(), { rows: [] });

  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const { savePeersToCache } = require("../src/sync");
  const { dayKey } = require("../src/aggregate");
  const prevHome = process.env.USERPROFILE;
  const prevUnixHome = process.env.HOME;
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "dora-srv-peerws-"));
  process.env.USERPROFILE = tmpHome;
  process.env.HOME = tmpHome;
  try {
    const today = dayKey(Date.now());
    const oldDay = dayKey(Date.now() - 20 * 86400_000);
    savePeersToCache([
      {
        version: 4,
        device: "peer-box",
        days: {
          [today]: { antigravity: { "Gemini 4 Hydrogen (High)": { i: 100, o: 10, cr: 0, cc: 0, req: 1 } } },
          [oldDay]: { antigravity: { "Gemini 4 Hydrogen (High)": { i: 500, o: 50, cr: 0, cc: 0, req: 5 } } },
        },
        wsNames: { abc: "demo-ws" },
        wsDaily: {
          [today]: { antigravity: { abc: { i: 100, o: 10, cr: 0, cc: 0, req: 1, credits: 0 } } },
          [oldDay]: { antigravity: { abc: { i: 500, o: 50, cr: 0, cc: 0, req: 5, credits: 0 } } },
        },
      },
    ]);
    const r7d = await (await fetch(`${base}/api/usage/peer-workspaces?device=peer-box&tool=antigravity&range=7d`)).json();
    assert.equal(r7d.rows.length, 1);
    assert.equal(r7d.rows[0].totalTokens, 110);
    const rAll = await (await fetch(`${base}/api/usage/peer-workspaces?device=peer-box&tool=antigravity&range=all`)).json();
    assert.equal(rAll.rows[0].totalTokens, 660);

    // /api/usage/query: device=<peer> isolates peer totals; resolved filters peer records too.
    fs.writeFileSync(
      path.join(tmpHome, ".doramonitor", "config.json"),
      JSON.stringify({ sync: { enabled: true, deviceName: "win" } })
    );
    savePeersToCache([
      {
        version: 4,
        device: "peer-box",
        days: {
          [today]: {
            antigravity: {
              "Gemini 4 Hydrogen (High)": { i: 200, o: 20, cr: 800, cc: 0, req: 2 },
              "Gemini 4 Neon (XHigh)": { i: 500, o: 50, cr: 1500, cc: 0, req: 5 },
            },
          },
        },
        wsNames: { w1: "demo-ws" },
        wsDaily: {
          [today]: {
            antigravity: { w1: { i: 700, o: 70, cr: 2300, cc: 0, req: 7, credits: 0 } },
          },
        },
      },
    ]);
    const store = require("../src/store");
    const dbPath = path.join(tmpHome, "srv-store.db");
    assert.ok(store.open(dbPath));
    try {
      store.ingestTool({
        tool: "antigravity",
        home: path.join(tmpHome, "agy"),
        force: true,
        records: [
          {
            tool: "antigravity",
            time: Date.now(),
            model: "Gemini 4 Hydrogen (XHigh)",
            modelDisplay: "Gemini 4 Hydrogen (XHigh)",
            modelResolved: "gemini-4-hydrogen",
            inputOther: 100,
            output: 10,
            inputCacheRead: 400,
            inputCacheCreation: 0,
            project: "D:\\LocalProj",
          },
        ],
        events: [],
      });

      const peerOnly = await (
        await fetch(`${base}/api/usage/query?range=7d&device=peer-box&tool=antigravity`)
      ).json();
      assert.equal(peerOnly.totals.requests, 7);
      assert.equal(peerOnly.totals.totalTokens, 3070);
      assert.deepEqual(peerOnly.workspaces.map((w) => w.workspaceName), ["demo-ws"]);

      const mergedHydrogen = await (
        await fetch(`${base}/api/usage/query?range=7d&device=all&tool=antigravity&resolved=gemini-4-hydrogen`)
      ).json();
      assert.equal(mergedHydrogen.totals.requests, 3);
      assert.equal(mergedHydrogen.totals.totalTokens, 510 + 1020);
    } finally {
      store.close();
    }
  } finally {
    if (prevHome === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevHome;
    if (prevUnixHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevUnixHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("HTTP server update endpoints require confirm and enforce active-phase lock", async (t) => {
  const selfUpdate = require("../src/self-update");
  const fs = require("node:fs");
  const server = createServer(null);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  // Missing confirm -> 400
  const bad = await fetch(`${base}/api/update/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, "confirm_required");

  // Status & version-check respond cleanly
  const stRes = await fetch(`${base}/api/update/status`);
  assert.equal(stRes.status, 200);
  const stBody = await stRes.json();
  assert.equal(typeof stBody.version, "string");

  // Active phase in STATUS_FILE causes 409 without spawning a real updater
  const prevStatus = fs.existsSync(selfUpdate.STATUS_FILE)
    ? fs.readFileSync(selfUpdate.STATUS_FILE, "utf8")
    : null;
  try {
    selfUpdate.writeStatus({ phase: "installing", progress: 50, fromVersion: "1.0.0" });
    const conflict = await fetch(`${base}/api/update/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    assert.equal(conflict.status, 409);
    const body = await conflict.json();
    assert.equal(body.started, false);
    assert.ok(body.error.includes("正在进行"));
  } finally {
    if (prevStatus !== null) fs.writeFileSync(selfUpdate.STATUS_FILE, prevStatus, "utf8");
    else fs.rmSync(selfUpdate.STATUS_FILE, { force: true });
  }
});
