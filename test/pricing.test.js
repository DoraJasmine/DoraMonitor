"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { matchPrice, costForUsage } = require("../src/pricing");

describe("pricing", () => {
  it("matches kimi-k3", () => {
    const p = matchPrice("opencode-go/kimi-k3");
    assert.equal(p.id, "kimi-k3");
    assert.equal(p.input, 3.0);
    assert.equal(p.estimated, false);
  });

  it("matches k2.7 code", () => {
    const p = matchPrice("workbuddy/kimi-k2.7-code");
    assert.equal(p.id, "kimi-k2.7-code");
    assert.equal(p.cacheHit, 0.19);
  });

  it("matches k2.6", () => {
    const p = matchPrice("kimi-k2.6");
    assert.equal(p.id, "kimi-k2.6");
    assert.equal(p.output, 4.0);
  });

  it("falls back for non-kimi models", () => {
    const p = matchPrice("grok-api/grok-4.5");
    assert.equal(p.estimated, true);
    assert.equal(p.id, "kimi-k2.6");
  });

  it("computes cost with cache", () => {
    const c = costForUsage("kimi-k2.6", {
      inputOther: 1_000_000,
      output: 1_000_000,
      inputCacheRead: 1_000_000,
      inputCacheCreation: 0,
    });
    // 0.95 + 4.00 + 0.16 = 5.11
    assert.ok(Math.abs(c.total - 5.11) < 1e-9);
    assert.equal(c.estimated, false);
  });
});
