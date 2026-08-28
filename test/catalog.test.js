"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  stripCatalog,
  loadBuiltin,
  fetchCatalogOrBuiltIn,
  readDiskCache,
  writeDiskCache,
  catalogProviderModels,
  catalogProviderType,
  importCatalogProvider,
} = require("../src/catalog");

const SAMPLE_CATALOG = {
  kimi: {
    id: "kimi",
    name: "Kimi (Moonshot)",
    api: "https://api.moonshot.ai/v1",
    type: "kimi",
    models: {
      "kimi-k3": {
        id: "kimi-k3",
        limit: { context: 1048576 },
        tool_call: true,
        reasoning: true,
        reasoning_options: [
          { type: "effort", values: ["none", "low", "medium", "high"] },
          { type: "toggle" },
        ],
        modalities: { input: ["text"] },
      },
      "kimi-k3-always": {
        id: "kimi-k3-always",
        limit: { context: 1048576 },
        tool_call: true,
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "high"] }],
        modalities: { input: ["text"] },
      },
      "some-embedding": {
        id: "some-embedding",
        limit: { context: 8192 },
        modalities: { output: ["text"] },
      },
      "deprecated-old": {
        id: "deprecated-old",
        status: "deprecated",
        modalities: { output: ["text"] },
      },
      "vision-only": {
        id: "vision-only",
        modalities: { output: ["image"] },
      },
    },
  },
  unknown: {
    id: "unknown",
    name: "Unknown vendor",
    api: "https://unknown.example/v1",
    models: {
      "model-1": { id: "model-1", limit: { context: 32768 }, tool_call: true },
    },
  },
};

describe("catalog", () => {
  let tmp;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kcd-cat-"));
  });
  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("loads the bundled snapshot with valid providers", () => {
    const builtin = loadBuiltin();
    assert.equal(builtin.source, "builtin");
    assert.ok(
      builtin.providers.length >= 100,
      "full models.dev mirror ships as the bundled snapshot"
    );
    const moonshot = builtin.providers.find((p) => p.id === "moonshotai");
    assert.ok(moonshot.models["kimi-k2.5"], "moonshotai kimi alias model present");
  });

  it("strips catalog to the field whitelist", () => {
    const stripped = stripCatalog(SAMPLE_CATALOG);
    const kimi = stripped.find((p) => p.id === "kimi");
    assert.deepEqual(Object.keys(kimi).sort(), ["api", "id", "models", "name", "type"]);
    const m = kimi.models["kimi-k3"];
    assert.deepEqual(Object.keys(m).sort(), [
      "id",
      "limit",
      "modalities",
      "reasoning",
      "reasoning_options",
      "tool_call",
    ]);
  });

  it("normalizes usable chat models with capabilities", () => {
    const stripped = stripCatalog(SAMPLE_CATALOG);
    const models = catalogProviderModels(stripped.find((p) => p.id === "kimi"));
    const ids = models.map((m) => m.id);
    assert.ok(ids.includes("kimi-k3"));
    assert.ok(!ids.includes("some-embedding"), "embedding models excluded");
    assert.ok(!ids.includes("deprecated-old"), "deprecated models excluded");
    assert.ok(!ids.includes("vision-only"), "non-text-output models excluded");
    const k3 = models.find((m) => m.id === "kimi-k3");
    assert.equal(k3.context, 1048576);
    assert.deepEqual(k3.capabilities, ["thinking", "tool_use"]);
    // reasoning_options -> efforts: "none" is the disable tier, never a level.
    assert.deepEqual(k3.supportEfforts, ["low", "medium", "high"]);
    assert.equal(k3.offEffort, "none");
    assert.equal(k3.alwaysThinking, undefined, "toggle present => not always-on");

    // effort list without a disable tier and no toggle => always-on model.
    const k3a = models.find((m) => m.id === "kimi-k3-always");
    assert.deepEqual(k3a.supportEfforts, ["low", "high"]);
    assert.equal(k3a.offEffort, undefined);
    assert.equal(k3a.alwaysThinking, true);
  });

  it("resolves wire type explicitly or guesses openai", () => {
    const stripped = stripCatalog(SAMPLE_CATALOG);
    const kimi = stripped.find((p) => p.id === "kimi");
    assert.deepEqual(catalogProviderType(kimi), { type: "kimi", guessed: false });
    const unknown = stripped.find((p) => p.id === "unknown");
    assert.deepEqual(catalogProviderType(unknown), { type: "openai", guessed: true });
  });

  it("imports a provider + all model aliases in one atomic write", () => {
    const result = importCatalogProvider(tmp, {
      providerId: "moonshotai",
      apiKey: "sk-abc",
      baseUrl: "",
      defaultModel: "kimi-k2.5",
    });
    assert.equal(result.type, "openai", "mirror provider without type is guessed");
    assert.equal(result.modelsImported >= 6, true);

    const fs2 = require("fs");
    const text = fs2.readFileSync(path.join(tmp, "config.toml"), "utf8");
    assert.ok(text.includes('type = "openai"'));
    assert.ok(text.includes('api_key = "sk-abc"'));
    assert.ok(text.includes('[models."moonshotai/kimi-k3"]'));
    assert.ok(text.includes("max_context_size = 1048576"));

    const { loadConfig } = require("../src/config-store");
    const doc = loadConfig(tmp);
    assert.equal(doc.default_model, "moonshotai/kimi-k2.5");
    assert.equal(doc.default_provider, "moonshotai");
    const m = doc.models["moonshotai/kimi-k2.5"];
    assert.equal(m.provider, "moonshotai", "alias uses the required provider field");
    assert.equal(m.model, "kimi-k2.5");
    assert.equal(m.max_context_size, 262144);
    // Catalog metadata (capabilities etc.) is written so kimi-code's schema
    // accepts the entry — same as applyCatalogProvider.
    assert.deepEqual(m.capabilities, [
      "image_in",
      "video_in",
      "thinking",
      "tool_use",
    ]);
    // Effort metadata from the snapshot's reasoning_options is persisted so
    // kimi-code exposes thinking tiers instead of a bare on/off toggle.
    const k3 = doc.models["moonshotai/kimi-k3"];
    assert.ok(k3.support_efforts.includes("high"), "effort tiers written");
    assert.equal(k3.default_effort, "high", "kimi-code default effort persisted");
  });

  it("rejects import of an unknown provider", () => {
    assert.throws(
      () => importCatalogProvider(tmp, { providerId: "ghost" }),
      (e) => e.code === "not_found"
    );
  });

  it("rejects provider ids with invalid characters", () => {
    assert.throws(
      () => importCatalogProvider(tmp, { providerId: "bad id" }),
      (e) => e.code === "invalid_id"
    );
  });

  it("falls back to the persisted snapshot when the network fails", async () => {
    const cacheFile = path.join(tmp, "catalog-cache.json");
    const providers = stripCatalog(SAMPLE_CATALOG);
    writeDiskCache(cacheFile, providers, 1700000000000);

    const data = await fetchCatalogOrBuiltIn({
      force: true,
      cacheFile,
      url: "https://127.0.0.1:1/api.json", // always fails fast
    });
    assert.equal(data.source, "cached");
    assert.equal(data.fetchedAt, 1700000000000);
    const ids = data.providers.map((p) => p.id).sort();
    assert.deepEqual(ids, ["kimi", "unknown"]);
  });

  it("falls back to the bundled snapshot when cache is missing", async () => {
    const data = await fetchCatalogOrBuiltIn({
      force: true,
      cacheFile: path.join(tmp, "missing-cache.json"),
      url: "https://127.0.0.1:1/api.json",
    });
    assert.equal(data.source, "builtin");
    assert.ok(
      data.providers.length >= 100,
      "full mirror snapshot served when no cache exists"
    );
  });

  it("ignores a corrupt persisted snapshot", () => {
    const cacheFile = path.join(tmp, "corrupt-cache.json");
    fs.writeFileSync(cacheFile, "{not json", "utf8");
    assert.equal(readDiskCache(cacheFile), null);

    fs.writeFileSync(cacheFile, JSON.stringify({ fetchedAt: "nope" }), "utf8");
    assert.equal(readDiskCache(cacheFile), null);
  });

  it("reads Tauri-written caches with snake_case fetched_at", () => {
    const cacheFile = path.join(tmp, "tauri-cache.json");
    fs.writeFileSync(
      cacheFile,
      JSON.stringify({ fetched_at: 1700000000000, providers: [] }),
      "utf8"
    );
    const disk = readDiskCache(cacheFile);
    assert.equal(disk.fetchedAt, 1700000000000);
    assert.deepEqual(disk.providers, []);
  });
});
