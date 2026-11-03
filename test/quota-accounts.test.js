"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { listKimiQuotaAccounts, resolveKimiQuotaAccount } = require("../src/quota-accounts");
const { sanitizeSettings } = require("../src/settings");
const { fetchQuota } = require("../src/quota");

const accounts = [
  { tool: "kimi-code", accountKey: "kimi:default", label: "Personal", home: "/personal" },
  { tool: "kimi-code", accountKey: "kimi:work", label: "Work", home: "/work" },
];

test("configured Kimi accounts are isolated and require an explicit selection", () => {
  assert.deepEqual(listKimiQuotaAccounts(null, { quotaAccounts: accounts }).map((account) => account.accountKey), ["kimi:default", "kimi:work"]);
  assert.equal(resolveKimiQuotaAccount(null, "kimi:work", { quotaAccounts: accounts }).home, "/work");
  assert.throws(() => resolveKimiQuotaAccount(null, null, { quotaAccounts: accounts }), (error) => error.code === "account_required");
  assert.throws(() => resolveKimiQuotaAccount(null, "kimi:other", { quotaAccounts: accounts }), (error) => error.code === "account_unavailable");
});

test("account settings reject unsupported tools, invalid ids and duplicates", () => {
  const settings = sanitizeSettings({ quotaAccounts: [
    ...accounts,
    accounts[0],
    { tool: "zcode", accountKey: "zcode:one", home: "/z" },
    { tool: "kimi-code", accountKey: "invalid key", home: "/bad" },
  ] });
  assert.deepEqual(settings.quotaAccounts.map((account) => account.accountKey), ["kimi:default", "kimi:work"]);
});

test("Kimi quota cache is isolated by credential home and account key", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dora-kimi-accounts-"));
  const originalFetch = global.fetch;
  context.after(() => { global.fetch = originalFetch; });
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return { ok: true, json: async () => ({ data: { usage: { percentage: 20, reset_at: 1787210351998 } } }) };
  };
  const homes = [path.join(root, "personal"), path.join(root, "work")];
  for (const home of homes) {
    fs.mkdirSync(path.join(home, "credentials"), { recursive: true });
    fs.writeFileSync(path.join(home, "credentials", "kimi-code.json"), JSON.stringify({ access_token: "token", expires_at: 4102444800 }));
  }
  const personal = await fetchQuota(homes[0], { accountKey: "kimi:default" });
  const work = await fetchQuota(homes[1], { accountKey: "kimi:work" });
  await fetchQuota(homes[0], { accountKey: "kimi:default" });
  await fetchQuota(homes[1], { accountKey: "kimi:work" });
  assert.equal(personal.accountKey, "kimi:default");
  assert.equal(work.accountKey, "kimi:work");
  assert.equal(calls, 2);
});

test("api key fetches usages without touching OAuth credentials", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dora-kimi-apikey-"));
  const originalFetch = global.fetch;
  context.after(() => { global.fetch = originalFetch; });
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push([String(url), opts && opts.headers && opts.headers.Authorization]);
    return { ok: true, json: async () => ({ data: { usage: { percentage: 20, reset_at: 1787210351998 } } }) };
  };
  const home = path.join(root, "no-credentials"); // deliberately no credentials file
  const quota = await fetchQuota(home, { accountKey: "kimi:default", apiKey: "sk-kimi-test" });
  assert.equal(quota.available, true);
  assert.equal(quota.source, "api-key");
  assert.equal(quota.windows.length, 1);
  assert.equal(quota.windows[0].usedPercent, 20);
  assert.equal(calls.length, 1);
  assert.ok(calls[0][0].includes("/coding/v1/usages"));
  assert.equal(calls[0][1], "Bearer sk-kimi-test");
  // Repeated call is served from the cache (one fetch total).
  await fetchQuota(home, { accountKey: "kimi:default", apiKey: "sk-kimi-test" });
  assert.equal(calls.length, 1);
});

test("api key error surfaces as an unavailable quota, not a crash", async (context) => {
  const originalFetch = global.fetch;
  context.after(() => { global.fetch = originalFetch; });
  global.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
  const quota = await fetchQuota("/unused", { accountKey: "kimi:default", apiKey: "sk-kimi-bad" });
  assert.equal(quota.available, false);
  assert.equal(quota.reason, "http_401");
  assert.equal(quota.source, "api-key");
});
