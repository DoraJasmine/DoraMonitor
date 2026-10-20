"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  resolveModelIdentity,
  displayNameFor,
  QODER_DISPLAY_NAMES,
  PRICING_KEYS,
} = require("../src/model-identity");

/**
 * Routing-tier selectors, not models: the app picks whichever backend model
 * the plan serves, so there is no list price to attach. They must still have
 * a display name so the UI never shows a bare code.
 */
const ROUTING_TIERS = new Set(["auto", "efficient", "lite", "performance", "ultimate"]);

test("model-identity: QoderCN routing codes resolve to display names", () => {
  assert.strictEqual(resolveModelIdentity("dfmodel").modelDisplay, "DeepSeek-V4-Flash");
  assert.strictEqual(resolveModelIdentity("dmodel").modelDisplay, "DeepSeek-V4-Pro");
  assert.strictEqual(resolveModelIdentity("qfmodel").modelDisplay, "Qwen3.6-Flash");
  assert.strictEqual(resolveModelIdentity("qmodel_latest").modelDisplay, "Qwen3.7-Max");
  assert.strictEqual(resolveModelIdentity("mmodel").modelDisplay, "MiniMax-M3");
  assert.strictEqual(resolveModelIdentity("gm51model").modelDisplay, "GLM-5.2");
  assert.strictEqual(resolveModelIdentity("kmodel").modelDisplay, "Kimi-K2.7-Code");
});

test("model-identity: every mapped model code also yields a pricing key", () => {
  // A name without a price is exactly the bug that made Qwen traffic bill at
  // Kimi K2.6 rates; keep the two tables in step. Routing tiers are exempt —
  // they delegate to whatever model the plan serves.
  for (const code of Object.keys(QODER_DISPLAY_NAMES)) {
    if (ROUTING_TIERS.has(code)) continue;
    const id = resolveModelIdentity(code);
    assert.ok(
      id.pricingKey,
      `code "${code}" has a display name but no pricing key`
    );
  }
});

test("model-identity: routing tiers are named but unpriced", () => {
  for (const tier of ROUTING_TIERS) {
    const id = resolveModelIdentity(tier);
    assert.notStrictEqual(id.modelDisplay, tier, `tier "${tier}" should be capitalised`);
    assert.strictEqual(id.pricingKey, null, `tier "${tier}" must not claim a price row`);
  }
});

test("model-identity: unmapped codes pass through unchanged", () => {
  const id = resolveModelIdentity("some-new-code-2027");
  assert.strictEqual(id.modelDisplay, "some-new-code-2027");
  assert.strictEqual(id.pricingKey, null);
  assert.strictEqual(id.known, false);
});

test("model-identity: lookup is case-insensitive and provider-qualified", () => {
  assert.strictEqual(resolveModelIdentity("DFMODEL").modelDisplay, "DeepSeek-V4-Flash");
  assert.strictEqual(resolveModelIdentity("qodercn:dfmodel").modelDisplay, "DeepSeek-V4-Flash");
  assert.strictEqual(resolveModelIdentity("vendor/qfmodel").modelDisplay, "Qwen3.6-Flash");
});

test("model-identity: provider is echoed back for provenance", () => {
  const id = resolveModelIdentity("dfmodel", { provider: "qodercn" });
  assert.strictEqual(id.provider, "qodercn");
});

test("model-identity: empty / unknown input is tolerated", () => {
  assert.strictEqual(displayNameFor(""), "unknown");
  assert.strictEqual(displayNameFor(null), "unknown");
  assert.strictEqual(displayNameFor("unknown"), "unknown");
});

test("model-identity: pricing keys resolve to a real price row", () => {
  const { matchPrice } = require("../src/pricing");
  for (const [code, pricingKey] of Object.entries(PRICING_KEYS)) {
    const price = matchPrice(pricingKey, { fxRate: 7.2, inputTokens: 1000 });
    assert.ok(
      price && price.id && price.id !== "kimi-k2.6",
      `pricing key "${pricingKey}" (from code "${code}") still falls back to the Kimi K2.6 estimate`
    );
  }
});
