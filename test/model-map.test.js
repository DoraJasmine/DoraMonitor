"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  loadModelMap,
  resolveModel,
  ENV_MODEL_ALIAS,
} = require("../src/model-map");

describe("model-map", () => {
  let tmp;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kcd-map-"));
    fs.writeFileSync(
      path.join(tmp, "config.toml"),
      `
default_model = "demo/kimi-k2.6"

[providers.demo]
type = "openai"
base_url = "https://example.invalid/v1"
api_key = "sk-SHOULD-NOT-LEAK"

[models."demo/kimi-k2.6"]
provider = "demo"
model = "kimi-k2.6"
display_name = "Kimi K2.6 Demo"

[models."demo/other"]
provider = "demo"
model = "other-model"
`,
      "utf8"
    );
  });

  after(() => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("loads aliases without secrets", () => {
    const map = loadModelMap(tmp);
    assert.equal(map.defaultModel, "demo/kimi-k2.6");
    assert.equal(map.aliases["demo/kimi-k2.6"].model, "kimi-k2.6");
    assert.equal(map.aliases["demo/kimi-k2.6"].displayName, "Kimi K2.6 Demo");
    const blob = JSON.stringify(map);
    assert.equal(blob.includes("sk-SHOULD-NOT-LEAK"), false);
    assert.equal(blob.includes("api_key"), false);
  });

  it("resolves config alias", () => {
    const map = loadModelMap(tmp);
    const r = resolveModel("demo/kimi-k2.6", map);
    assert.equal(r.resolved, "kimi-k2.6");
    assert.equal(r.display, "Kimi K2.6 Demo");
    assert.equal(r.provider, "demo");
  });

  it("resolves __kimi_env_model__ via KIMI_MODEL_NAME", () => {
    const prev = process.env.KIMI_MODEL_NAME;
    process.env.KIMI_MODEL_NAME = "kimi-k3";
    try {
      const map = loadModelMap(tmp);
      assert.ok(map.envModel);
      assert.equal(map.envModel.name, "kimi-k3");
      assert.ok(map.aliases[ENV_MODEL_ALIAS]);
      const r = resolveModel(ENV_MODEL_ALIAS, map);
      assert.equal(r.fromEnv, true);
      assert.equal(r.resolved, "kimi-k3");
    } finally {
      if (prev === undefined) delete process.env.KIMI_MODEL_NAME;
      else process.env.KIMI_MODEL_NAME = prev;
    }
  });
});
