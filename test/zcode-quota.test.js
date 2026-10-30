"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { fetchZcodeQuota, parseZcodeUsage, accountForKey } = require("../src/zcode-quota");

const payload = {
  code: 200,
  data: {
    limits: [
      { type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 2000, currentValue: 2005, remaining: 0, percentage: 100, nextResetTime: 1786624439633 },
      { type: "TOKENS_LIMIT", unit: 6, number: 1, usage: 10000, currentValue: 2005, remaining: 7994, percentage: 20, nextResetTime: 1787210351998 },
      { type: "TIME_LIMIT", unit: 1, percentage: 50 },
    ],
  },
};

test("ZCode parses current and legacy quota windows without treating limits as usage", () => {
  const quota = parseZcodeUsage(payload, { accountKey: "zcode:test", now: 1786620000000 });
  assert.equal(quota.available, true);
  assert.equal(quota.accountKey, "zcode:test");
  assert.deepEqual(quota.windows.map((window) => [window.kind, window.usedPercent]), [["session", 100], ["weekly", 20]]);
  assert.equal(quota.windows[0].resetsAt, new Date(1786624439633).toISOString());
});

test("ZCode requires an explicit key and never exposes it in the account identity", async () => {
  const missing = await fetchZcodeQuota({ env: {}, fetchImpl: async () => { throw new Error("network must not run"); } });
  assert.equal(missing.reason, "no_credentials");
  const key = "secret-test-key";
  const accountKey = accountForKey(key);
  assert.ok(accountKey.startsWith("zcode:"));
  assert.ok(!accountKey.includes(key));
  let url;
  const quota = await fetchZcodeQuota({
    env: { Z_AI_API_KEY: key },
    fetchImpl: async (input) => {
      url = input;
      return { ok: true, json: async () => payload };
    },
  });
  assert.equal(url, "https://api.z.ai/api/monitor/usage/quota/limit");
  assert.equal(quota.accountKey, accountKey);
  assert.equal(JSON.stringify(quota).includes(key), false);
});

test("BigModel key selects the domestic endpoint", async () => {
  let url;
  await fetchZcodeQuota({
    env: { BIGMODEL_API_KEY: "domestic-key", Z_AI_API_KEY: "international-key" },
    fetchImpl: async (input) => {
      url = input;
      return { ok: true, json: async () => payload };
    },
  });
  assert.equal(url, "https://open.bigmodel.cn/api/monitor/usage/quota/limit");
});
