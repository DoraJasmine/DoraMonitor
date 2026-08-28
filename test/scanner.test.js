"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { scanUsage } = require("../src/scanner");

describe("scanner", () => {
  let tmp;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kcd-scan-"));
    const wireDir = path.join(
      tmp,
      "sessions",
      "wd_demo",
      "session_abc",
      "agents",
      "main"
    );
    fs.mkdirSync(wireDir, { recursive: true });
    const lines = [
      JSON.stringify({
        type: "context.append_message",
        message: {
          role: "user",
          content: [{ type: "text", text: "SECRET PROMPT should not appear" }],
        },
        time: 1,
      }),
      JSON.stringify({
        type: "usage.record",
        model: "demo/kimi-k2.6",
        usage: {
          inputOther: 100,
          output: 20,
          inputCacheRead: 50,
          inputCacheCreation: 10,
        },
        usageScope: "turn",
        time: 1_700_000_000_000,
      }),
      JSON.stringify({
        type: "usage.record",
        model: "demo/kimi-k2.6",
        usage: {
          inputOther: 999,
          output: 999,
          inputCacheRead: 999,
          inputCacheCreation: 999,
        },
        usageScope: "session",
        time: 1_700_000_000_001,
      }),
      JSON.stringify({
        type: "usage.record",
        model: "__kimi_env_model__",
        usage: {
          inputOther: 10,
          output: 5,
          inputCacheRead: 0,
          inputCacheCreation: 0,
        },
        usageScope: "turn",
        time: 1_700_000_000_002,
      }),
    ];
    fs.writeFileSync(path.join(wireDir, "wire.jsonl"), lines.join("\n"), "utf8");
  });

  after(() => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("reads only turn usage.record token fields", () => {
    const map = {
      defaultModel: null,
      aliases: {
        "demo/kimi-k2.6": {
          provider: "demo",
          model: "kimi-k2.6",
          displayName: "Demo K2.6",
        },
      },
      envModel: { name: "kimi-k3", provider: "env", model: "kimi-k3" },
    };
    const { records, meta } = scanUsage(tmp, map);
    assert.equal(meta.recordCount, 2);
    assert.equal(records.length, 2);
    const blob = JSON.stringify(records);
    assert.equal(blob.includes("SECRET PROMPT"), false);
    const first = records.find((r) => r.model === "demo/kimi-k2.6");
    assert.ok(first);
    assert.equal(first.inputOther, 100);
    assert.equal(first.output, 20);
    assert.equal(first.inputCacheRead, 50);
    assert.equal(first.inputCacheCreation, 10);
    assert.equal(first.modelResolved, "kimi-k2.6");
    const envRec = records.find((r) => r.model === "__kimi_env_model__");
    assert.ok(envRec);
    assert.equal(envRec.fromEnv, true);
    assert.equal(envRec.modelResolved, "kimi-k3");
  });
});
