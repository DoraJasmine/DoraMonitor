"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { isNewerVersion, getUpdateStatus, resetCache } = require("../src/update-check");

test("update-check: semver comparison", () => {
  assert.strictEqual(isNewerVersion("1.2.0", "1.1.0"), true);
  assert.strictEqual(isNewerVersion("1.1.1", "1.1.0"), true);
  assert.strictEqual(isNewerVersion("2.0.0", "1.9.9"), true);
  assert.strictEqual(isNewerVersion("1.1.0", "1.1.0"), false);
  assert.strictEqual(isNewerVersion("1.0.9", "1.1.0"), false);
  // 预发布标签按数值主体比较
  assert.strictEqual(isNewerVersion("1.2.0-beta.1", "1.1.0"), true);
});

test("update-check: fetch result cached, newer detected, failures degrade silently", async () => {
  resetCache();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return {
      ok: true,
      json: async () => ({ tag_name: "v99.0.0", html_url: "https://github.com/DoraJasmine/DoraMonitor/releases/tag/v99.0.0" }),
    };
  };
  const first = await getUpdateStatus({ fetchImpl, now: 1000 });
  assert.strictEqual(first.updateAvailable, true);
  assert.strictEqual(first.latest, "99.0.0");
  assert.strictEqual(first.enabled, true);

  // 缓存生效:同一时刻窗口内不再发起请求
  const second = await getUpdateStatus({ fetchImpl, now: 2000 });
  assert.strictEqual(calls, 1);
  assert.strictEqual(second.updateAvailable, true);

  // 失败静默:不抛错、不缓存失败状态
  const failFetch = async () => {
    throw new Error("offline");
  };
  const third = await getUpdateStatus({ fetchImpl: failFetch, now: 99999999 });
  assert.strictEqual(third.updateAvailable, false);
  assert.strictEqual(third.latest, null);
  resetCache();
});

test("update-check: non-ok registry response degrades silently", async () => {
  resetCache();
  const fetchImpl = async () => ({ ok: false, json: async () => ({}) });
  const status = await getUpdateStatus({ fetchImpl, now: 1000 });
  assert.strictEqual(status.updateAvailable, false);
  resetCache();
});
