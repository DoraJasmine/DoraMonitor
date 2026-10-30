"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { getCodexQuota, readCachedCodexQuota } = require("../src/codex-quota");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aum-codex-quota-test-"));
}

function homeWithAuth(tokens) {
  const home = tmpDir();
  fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({ tokens }));
  return home;
}

function whamResponse() {
  return {
    plan_type: "plus",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: { used_percent: 42, limit_window_seconds: 18000, reset_at: 1761800000 },
      secondary_window: { used_percent: 7, limit_window_seconds: 604800, reset_at: 1762200000 },
    },
    credits: { has_credits: false, unlimited: false, balance: null },
  };
}

function okFetch(calls, body = whamResponse()) {
  return async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => body };
  };
}

test("codex-quota: missing auth.json reports no_auth without network", async () => {
  const calls = [];
  const q = await getCodexQuota(tmpDir(), { fetchImpl: okFetch(calls), cacheFile: path.join(tmpDir(), "c.json") });
  assert.strictEqual(q.available, false);
  assert.strictEqual(q.reason, "no_auth");
  assert.strictEqual(calls.length, 0);
});

test("codex-quota: maps wham windows, persists, throttles repeat calls", async () => {
  const home = homeWithAuth({ access_token: "tok", account_id: "acc-1", refresh_token: "rt" });
  const cacheFile = path.join(tmpDir(), "codex-quota.json");
  const calls = [];

  const q = await getCodexQuota(home, { fetchImpl: okFetch(calls), cacheFile });
  assert.strictEqual(q.available, true);
  assert.strictEqual(q.planType, "plus");
  assert.deepStrictEqual(
    q.windows.map((w) => [w.kind, w.usedPercent]),
    [["session", 42], ["weekly", 7]]
  );
  assert.strictEqual(q.windows[0].resetsAt, new Date(1761800000 * 1000).toISOString());
  assert.deepStrictEqual(calls, ["https://chatgpt.com/backend-api/wham/usage"]);

  // Persisted snapshot readable by the provider scan path.
  const cached = readCachedCodexQuota(cacheFile);
  assert.strictEqual(cached.available, true);
  assert.strictEqual(cached.windows.length, 2);

  // Second call inside the throttle window must not hit the network.
  const q2 = await getCodexQuota(home, { fetchImpl: okFetch(calls), cacheFile });
  assert.strictEqual(q2.available, true);
  assert.strictEqual(calls.length, 1);
});

test("codex-quota: 401 triggers token refresh, writes auth.json back, retries", async () => {
  const home = homeWithAuth({ access_token: "old", account_id: "acc-1", refresh_token: "rt-1" });
  const cacheFile = path.join(tmpDir(), "codex-quota.json");
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push(url);
    if (url.endsWith("/oauth/token")) {
      return { ok: true, status: 200, json: async () => ({ access_token: "new", refresh_token: "rt-2" }) };
    }
    if (opts.headers.Authorization === "Bearer old") {
      return { ok: false, status: 401, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => whamResponse() };
  };

  const q = await getCodexQuota(home, { fetchImpl, cacheFile });
  assert.strictEqual(q.available, true);
  assert.deepStrictEqual(calls, [
    "https://chatgpt.com/backend-api/wham/usage",
    "https://auth.openai.com/oauth/token",
    "https://chatgpt.com/backend-api/wham/usage",
  ]);
  const auth = JSON.parse(fs.readFileSync(path.join(home, "auth.json"), "utf8"));
  assert.strictEqual(auth.tokens.access_token, "new");
  assert.strictEqual(auth.tokens.refresh_token, "rt-2");
});

test("codex-quota: network failure falls back to persisted snapshot", async () => {
  const home = homeWithAuth({ access_token: "tok" });
  const cacheFile = path.join(tmpDir(), "codex-quota.json");
  fs.writeFileSync(cacheFile, JSON.stringify({
    available: true, reason: null,
    windows: [{ kind: "session", label: "5-hour", usedPercent: 55, resetsAt: null }],
    fetchedAt: new Date().toISOString(),
  }));
  const failing = async () => {
    throw new Error("offline");
  };
  const q = await getCodexQuota(home, { force: true, fetchImpl: failing, cacheFile });
  assert.strictEqual(q.available, true);
  assert.strictEqual(q.windows[0].usedPercent, 55);
});

test("codex-quota: millisecond reset_at is converted to seconds", async () => {
  const home = homeWithAuth({ access_token: "tok" });
  const cacheFile = path.join(tmpDir(), "codex-quota.json");
  const body = whamResponse();
  body.rate_limit.primary_window.reset_at = 1761800000 * 1000;
  const q = await getCodexQuota(home, { fetchImpl: okFetch([], body), cacheFile });
  assert.strictEqual(q.windows[0].resetsAt, new Date(1761800000 * 1000).toISOString());
});
