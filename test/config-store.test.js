"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  ConfigError,
  loadConfig,
  getConfigView,
  saveProvider,
  deleteProvider,
  saveModel,
  deleteModel,
  setDefaultModel,
  setSecondaryModel,
} = require("../src/config-store");

const BASE_TOML = `# top comment
default_model = "kimi/kimi-k2.5"

[providers.kimi]
type = "kimi"
base_url = "https://api.moonshot.ai/v1"
api_key = "sk-secret-kimi"

[providers.openai]
type = "openai"

[models."kimi/kimi-k2.5"]
provider = "kimi"
model = "kimi-k2.5"
max_context_size = 262144

[models."kimi/kimi-k3"]
provider_id = "kimi"
model = "kimi-k3"
max_context_size = 1048576
capabilities = ["tool_use", "image_in"]

[permission]
default_mode = "acceptEdits"
max_turns = 10

[hooks.agent_started]
command = "echo hi"
`;

describe("config-store", () => {
  let tmp;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kcd-cfg-"));
  });
  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function writeToml(content) {
    const p = path.join(tmp, "config.toml");
    fs.writeFileSync(p, content, "utf8");
    return p;
  }

  it("loads missing config as empty object", () => {
    assert.deepEqual(loadConfig(path.join(tmp, "nope")), {});
  });

  it("raises invalid_toml on malformed file", () => {
    writeToml("not = = valid");
    assert.throws(() => loadConfig(tmp), (e) => e.code === "invalid_toml");
    fs.rmSync(path.join(tmp, "config.toml"));
  });

  it("round-trips provider/model mutations preserving unknown sections", () => {
    writeToml(BASE_TOML);
    saveProvider(tmp, { id: "deepseek", type: "openai", baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-ds" });
    saveModel(tmp, {
      alias: "deepseek/deepseek-chat",
      providerId: "deepseek",
      model: "deepseek-chat",
      maxContextSize: 131072,
      capabilities: ["tool_use"],
    });
    const doc = loadConfig(tmp);
    // Unknown sections untouched
    assert.equal(doc.permission.default_mode, "acceptEdits");
    assert.deepEqual(doc.hooks.agent_started, { command: "echo hi" });
    // Provider written
    assert.equal(doc.providers.deepseek.type, "openai");
    assert.equal(doc.providers.deepseek.api_key, "sk-ds");
    assert.equal(doc.providers.deepseek.base_url, "https://api.deepseek.com/v1");
    // Model alias written with structured provider pointer
    const m = doc.models["deepseek/deepseek-chat"];
    assert.equal(m.provider, "deepseek");
    assert.equal(m.provider_id, undefined, "wire field is provider, not provider_id");
    assert.equal(m.model, "deepseek-chat");
    assert.equal(m.max_context_size, 131072);
    assert.deepEqual(m.capabilities, ["tool_use"]);
  });

  it("masks api keys and env values in the view", () => {
    writeToml(BASE_TOML);
    const view = getConfigView(tmp);
    const json = JSON.stringify(view);
    assert.ok(!json.includes("sk-secret-kimi"), "api_key must not leak");
    const kimi = view.providers.find((p) => p.id === "kimi");
    assert.equal(kimi.has_api_key, true);
    assert.equal(kimi.api_key, undefined);
    assert.equal(view.defaultModel, "kimi/kimi-k2.5");
    assert.equal(view.models.length, 2);
    assert.deepEqual(view.models.find((m) => m.alias === "kimi/kimi-k3").capabilities, ["tool_use", "image_in"]);
  });

  it("writes backup before save", () => {
    writeToml(BASE_TOML);
    saveProvider(tmp, { id: "xai", type: "openai" });
    assert.ok(fs.existsSync(path.join(tmp, "config.toml.kcd-bak")), "backup file exists");
    const bak = fs.readFileSync(path.join(tmp, "config.toml.kcd-bak"), "utf8");
    assert.ok(bak.includes("sk-secret-kimi"), "backup holds pre-save content");
  });

  it("validates provider type against the whitelist", () => {
    writeToml(BASE_TOML);
    assert.throws(
      () => saveProvider(tmp, { id: "bad", type: "cohere" }),
      (e) => e.code === "invalid_type"
    );
  });

  it("rejects provider ids with dots or reserved alias prefix", () => {
    writeToml(BASE_TOML);
    assert.throws(() => saveProvider(tmp, { id: "a.b", type: "openai" }), (e) => e.code === "invalid_id");
    assert.throws(
      () => saveModel(tmp, { alias: "__reserved", providerId: "kimi", model: "x" }),
      (e) => e.code === "invalid_alias"
    );
  });

  it("requires a provider for model aliases", () => {
    writeToml(BASE_TOML);
    assert.throws(
      () => saveModel(tmp, { alias: "orphan/x", model: "x" }),
      (e) => e.code === "invalid_model"
    );
  });

  it("rejects max_context_size that is not a positive integer", () => {
    writeToml(BASE_TOML);
    assert.throws(
      () => saveModel(tmp, { alias: "kimi/k2", providerId: "kimi", model: "k2", maxContextSize: -5 }),
      (e) => e.code === "invalid_value"
    );
  });

  it("deleting a provider removes its models and clears pointers", () => {
    writeToml(BASE_TOML);
    setDefaultModel(tmp, "kimi/kimi-k3");
    setSecondaryModel(tmp, { model: "kimi/kimi-k2.5", defaultEffort: "low" });
    deleteProvider(tmp, "kimi");
    const doc = loadConfig(tmp);
    assert.equal(doc.providers.kimi, undefined);
    assert.equal(doc.models?.["kimi/kimi-k2.5"], undefined);
    assert.equal(doc.models?.["kimi/kimi-k3"], undefined);
    assert.equal(doc.default_model, undefined);
    assert.equal(doc.secondary_model, undefined);
    assert.equal(doc.providers.openai.type, "openai", "other providers survive");
  });

  it("deleting a model clears default/secondary pointers", () => {
    writeToml(BASE_TOML);
    setDefaultModel(tmp, "kimi/kimi-k2.5");
    setSecondaryModel(tmp, { model: "kimi/kimi-k2.5", defaultEffort: "high" });
    deleteModel(tmp, "kimi/kimi-k2.5");
    const doc = loadConfig(tmp);
    assert.equal(doc.models["kimi/kimi-k2.5"], undefined);
    assert.equal(doc.default_model, undefined);
    assert.equal(doc.secondary_model, undefined);
  });

  it("setting an unknown default/secondary model fails with not_found", () => {
    writeToml(BASE_TOML);
    assert.throws(() => setDefaultModel(tmp, "ghost/x"), (e) => e.code === "not_found");
    assert.throws(() => setSecondaryModel(tmp, { model: "ghost/x" }), (e) => e.code === "not_found");
  });

  it("clearing default/secondary model with empty input", () => {
    writeToml(BASE_TOML);
    setDefaultModel(tmp, "kimi/kimi-k2.5");
    setSecondaryModel(tmp, { model: "kimi/kimi-k2.5", defaultEffort: "low", maxOutputSize: 8192 });
    const before = loadConfig(tmp);
    assert.equal(before.default_model, "kimi/kimi-k2.5");
    assert.equal(before.secondary_model.model, "kimi/kimi-k2.5");
    assert.equal(before.secondary_model.default_effort, "low");
    assert.equal(before.secondary_model.max_output_size, 8192);
    setDefaultModel(tmp, "");
    setSecondaryModel(tmp, {});
    const after = loadConfig(tmp);
    assert.equal(after.default_model, undefined);
    assert.equal(after.secondary_model, undefined);
  });

  it("updating a provider type requires a valid protocol", () => {
    writeToml(BASE_TOML);
    saveProvider(tmp, { id: "openai", type: "anthropic" });
    const doc = loadConfig(tmp);
    assert.equal(doc.providers.openai.type, "anthropic");
  });

  it("clearing api_key on a provider removes the key field", () => {
    writeToml(BASE_TOML);
    saveProvider(tmp, { id: "kimi", apiKey: "" });
    const doc = loadConfig(tmp);
    assert.equal(doc.providers.kimi.api_key, undefined);
  });

  it("saveProvider on a new provider requires a type", () => {
    writeToml(BASE_TOML);
    assert.throws(() => saveProvider(tmp, { id: "noless" }), (e) => e.code === "invalid_type");
  });
});
