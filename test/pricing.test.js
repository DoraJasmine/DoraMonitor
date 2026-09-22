"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { matchPrice, costForUsage, listPrices } = require("../src/pricing");
const { DEFAULTS, toDisplay } = require("../src/settings");

describe("pricing", () => {
  it("defaults to CNY display and converts the internal CNY amount exactly once", () => {
    assert.equal(DEFAULTS.currency, "CNY");
    assert.equal(toDisplay(1, { currency: "CNY", fxRate: 7.2 }), 1);
    assert.equal(toDisplay(7.2, { currency: "USD", fxRate: 7.2 }), 1);
  });

  it("matches kimi-k3", () => {
    const p = matchPrice("opencode-go/kimi-k3", { fxRate: 7.2 });
    assert.equal(p.id, "kimi-k3");
    assert.equal(p.input, 20.0);
    assert.equal(p.estimated, false);
  });

  it("matches k2.7 code", () => {
    const p = matchPrice("workbuddy/kimi-k2.7-code", { fxRate: 7.2 });
    assert.equal(p.id, "kimi-k2.7-code");
    assert.equal(p.cacheHit, 1.3);
  });

  it("matches k2.6", () => {
    const p = matchPrice("kimi-k2.6", { fxRate: 7.2 });
    assert.equal(p.id, "kimi-k2.6");
    assert.equal(p.output, 27.0);
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
    }, { settings: { fxRate: 7.2, customPrices: [] } });
    // ¥6.50 + ¥27.00 + ¥1.10 = ¥34.60 in the internal CNY ledger.
    assert.ok(Math.abs(c.total - 34.6) < 1e-9);
    assert.equal(c.estimated, false);
  });

  it("keeps Kimi's CNY price invariant when the display exchange rate changes", () => {
    const usage = { inputOther: 1_000_000, output: 1_000_000, inputCacheRead: 1_000_000 };
    for (const fxRate of [6.5, 7.2, 8]) {
      const cost = costForUsage("kimi-k2.6", usage, {
        settings: { currency: "CNY", fxRate, customPrices: [] },
      });
      assert.ok(Math.abs(cost.total - 34.6) < 1e-9);
    }
  });

  it("uses DeepSeek's peak price for V4 Flash and legacy aliases", () => {
    // Monday 2026-09-21 01:00 UTC — inside DeepSeek's weekday peak window.
    const c = costForUsage("deepseek/deepseek-chat", {
      time: Date.UTC(2026, 8, 21, 1, 0, 0),
      inputOther: 1_000_000,
      output: 1_000_000,
      inputCacheRead: 1_000_000,
    }, { skipSettings: true });
    assert.equal(matchPrice("DeepSeek-V4-Flash", { time: Date.UTC(2026, 8, 21, 1) }).id, "deepseek-flash");
    assert.ok(Math.abs(c.total - 10.04) < 1e-9);
    assert.equal(c.estimated, false);
  });

  it("uses DeepSeek's half-price off-peak rate from the request time", () => {
    // Monday 2026-09-21 04:00 UTC — immediately after the peak window.
    const c = costForUsage("DeepSeek-V4-Pro", {
      time: Date.UTC(2026, 8, 21, 4, 0, 0),
      inputOther: 1_000_000,
      output: 1_000_000,
      inputCacheRead: 1_000_000,
    }, { skipSettings: true });
    assert.ok(Math.abs(c.total - 36.3 / 2) < 1e-9);
    assert.equal(c.estimated, false);
  });

  it("marks DeepSeek costs as estimated when the request time is unavailable", () => {
    const c = costForUsage("deepseek-flash", { output: 1_000_000 }, { skipSettings: true });
    assert.equal(c.total, 8);
    assert.equal(c.estimated, true);
  });

  it("uses DeepSeek's matching rate for blank custom-price components", () => {
    const c = costForUsage("deepseek-flash", {
      time: Date.UTC(2026, 8, 21, 4, 0, 0),
      inputOther: 1_000_000,
      output: 1_000_000,
      inputCacheRead: 1_000_000,
    }, {
      settings: {
        fxRate: 7.2,
        customPrices: [{ model: "deepseek-flash", input: 0.2, cacheHit: null, output: null, currency: "USD" }],
      },
    });
    assert.ok(Math.abs(c.total - (0.2 * 7.2 + 4.02)) < 1e-9);
    assert.equal(c.estimated, false);
  });

  it("lists every built-in official price family for the web price table", () => {
    const prices = listPrices({ fxRate: 7.2 });
    const ids = new Set(prices.map((p) => p.id));
    assert.ok(ids.has("kimi-k3"));
    assert.ok(ids.has("deepseek-flash"));
    assert.ok(ids.has("deepseek-v4-pro"));
    assert.ok(ids.has("glm-5.3"));
    assert.ok(ids.has("glm-5.3-flash"));
    assert.ok(ids.has("gpt-5.6-sol"));
    const kimiK3 = prices.find((p) => p.id === "kimi-k3");
    assert.equal(kimiK3.nativeCurrency, "CNY");
    assert.equal(kimiK3.input, 20);
    const peakFlash = prices.find((p) => p.id === "deepseek-flash" && p.period === "peak");
    const offPeakFlash = prices.find((p) => p.id === "deepseek-flash" && p.period === "offPeak");
    assert.equal(peakFlash.nativeCurrency, "CNY");
    assert.equal(peakFlash.input, 2);
    assert.equal(offPeakFlash.output, 4);
  });

  it("uses BigModel China's CNY prices without applying fxRate", () => {
    for (const fxRate of [6.5, 7.2, 8]) {
      const flash = matchPrice("GLM-5.3-Flash", { fxRate });
      const flagship = matchPrice("glm-5.3", { fxRate });
      assert.equal(flash.input, 0.8);
      assert.equal(flash.cacheHit, 0.23);
      assert.equal(flash.cacheWrite, 0);
      assert.equal(flash.output, 2.8);
      assert.equal(flagship.input, 8);
      assert.equal(flagship.cacheWrite, 0);
      assert.equal(flagship.output, 28);
    }
  });

  it("applies fxRate only to OpenAI prices", () => {
    assert.equal(matchPrice("gpt-5.6-sol", { fxRate: 7 }).input, 28);
    assert.equal(matchPrice("gpt-5.6-sol", { fxRate: 8 }).input, 32);
    assert.equal(toDisplay(28, { currency: "USD", fxRate: 7 }), 4);
  });

  it("uses the published GPT-5.6 long-context and cache-write rates", () => {
    const c = costForUsage("gpt-5.6-sol", {
      inputOther: 272_001,
      inputCacheRead: 1_000,
      inputCacheCreation: 1_000,
      output: 1_000,
    }, { skipSettings: true });
    // Over 272K: input/cache x2, output x1.5; Sol cache write is $5/M.
    const expected = ((272_001 * 8) + (1_000 * 0.8) + (1_000 * 10) + (1_000 * 30)) / 1e6;
    assert.ok(Math.abs(c.total - expected * 7.2) < 1e-12);
  });

  it("keeps DeepSeek's CNY price invariant when the display exchange rate changes", () => {
    const usage = {
      time: Date.UTC(2026, 8, 21, 1, 0, 0),
      inputOther: 1_000_000,
      output: 1_000_000,
      inputCacheRead: 1_000_000,
    };
    for (const fxRate of [6.5, 7.2, 8]) {
      const cost = costForUsage("deepseek-flash", usage, {
        settings: { currency: "CNY", fxRate, customPrices: [] },
      });
      // Flash peak: ¥2 input + ¥8 output + ¥0.04 cache hit per 1M.
      assert.ok(Math.abs(cost.total - 10.04) < 1e-9);
    }
  });

  it("uses DeepSeek's off-peak rate on a Chinese statutory holiday", () => {
    // 2026-09-25 09:00 Beijing is the Mid-Autumn Festival holiday.
    const p = matchPrice("deepseek-flash", {
      time: Date.UTC(2026, 8, 25, 1, 0, 0),
      fxRate: 7.2,
    });
    assert.equal(p.input, 1);
  });
});
