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

  it("prices K3.1 Pro at its official published rates", () => {
    for (const name of ["kimi-k3.1-pro", "kimi-k3.1", "k3.1-pro", "k3-1-pro"]) {
      const p = matchPrice(name, { fxRate: 7.2 });
      assert.equal(p.id, "kimi-k3.1-pro", name);
      assert.equal(p.input, 13.0, name);
      assert.equal(p.output, 68.0, name);
      assert.equal(p.cacheHit, 1.3, name);
      assert.equal(p.cacheWrite, 13.0, name);
      assert.equal(p.estimated, false, name);
    }
  });

  it("uses exact TTL cache-write rates when known and the simple average otherwise", () => {
    const typed = costForUsage("kimi-k3.1-pro", {
      inputCacheCreation: 1_000_000,
      inputCacheCreationShort: 250_000,
      inputCacheCreationLong: 750_000,
    }, { skipSettings: true });
    assert.ok(Math.abs(typed.total - (0.25 * 13 + 0.75 * 26)) < 1e-9);
    assert.equal(typed.estimated, false);

    const untyped = costForUsage("kimi-k3.1-pro", { inputCacheCreation: 1_000_000 }, { skipSettings: true });
    assert.ok(Math.abs(untyped.total - 19.5) < 1e-9);
    assert.equal(untyped.estimated, true);

    const singleTier = costForUsage("kimi-k2.7-code", { inputCacheCreation: 1_000_000 }, { skipSettings: true });
    assert.equal(singleTier.total, 6.5);
    assert.equal(singleTier.estimated, false);

    const prices = listPrices({ fxRate: 7.2 });
    const k31 = prices.find((p) => p.id === "kimi-k3.1-pro");
    assert.equal(k31.cacheWriteLong, 26);
    assert.equal(k31.cacheWritePeriod, "5min");
    assert.equal(k31.cacheWriteLongPeriod, "1h");
    const gpt = prices.find((p) => p.id === "gpt-6-sol");
    assert.equal(gpt.cacheWriteLong, 5 * 7.2);
    assert.equal(gpt.cacheWritePeriod, "30m");
    assert.equal(gpt.cacheWriteLongPeriod, "12h");
  });

  it("matches k2.7 code highspeed at its own official rates", () => {
    const p = matchPrice("kimi-k2.7-code-highspeed", { fxRate: 7.2 });
    assert.equal(p.id, "kimi-k2.7-code-highspeed");
    assert.equal(p.cacheHit, 2.6);
    assert.equal(p.input, 13.0);
    assert.equal(p.output, 54.0);
    assert.equal(p.estimated, false);
  });

  it("matches k3.1 pro highspeed at its own official rates", () => {
    const p = matchPrice("kimi-k3.1-pro-highspeed", { fxRate: 7.2 });
    assert.equal(p.id, "kimi-k3.1-pro-highspeed");
    assert.equal(p.input, 26.0);
    assert.equal(p.output, 136.0);
    assert.equal(p.cacheHit, 1.3);
    assert.equal(p.cacheWrite, 26.0);
    assert.equal(p.estimated, false);
  });

  it("matches k2.7 code", () => {
    const p = matchPrice("workbuddy/kimi-k2.7-code", { fxRate: 7.2 });
    assert.equal(p.id, "kimi-k2.7-code");
    assert.equal(p.cacheHit, 1.3);
  });

  it("does not present the input-rate billing fallback as an official cache-write price", () => {
    const prices = listPrices({ fxRate: 7.2 });
    for (const id of ["kimi-k2.7-code-highspeed", "kimi-k2.7-code", "kimi-k2.6", "deepseek-flash", "deepseek-v4-pro", "gemini-3.1-pro", "gemini-3.8-flash", "gemini-3-flash", "minimax-m3", "gpt-5", "codex-auto-review"]) {
      assert.equal(prices.find((p) => p.id === id).cacheWrite, null, id);
    }
    for (const id of ["kimi-k3", "kimi-k3.1-pro", "qwen3.7-max", "minimax-m2.7", "gpt-6-sol", "claude-sonnet-5"]) {
      assert.ok(prices.find((p) => p.id === id).cacheWrite > 0, id);
    }
    const k2 = matchPrice("kimi-k2.7-code", { fxRate: 7.2 });
    assert.equal(k2.cacheWrite, k2.input);
  });

  it("matches k2.6", () => {
    const p = matchPrice("kimi-k2.6", { fxRate: 7.2 });
    assert.equal(p.id, "kimi-k2.6");
    assert.equal(p.output, 27.0);
  });

  it("prices gpt-6.1-sol at its announced rates", () => {
    for (const name of ["gpt-6.1-sol", "gpt-6.1", "codex/gpt-6.1-sol"]) {
      const p = matchPrice(name, { fxRate: 7.2 });
      assert.equal(p.id, "gpt-6.1-sol", name);
      assert.equal(p.input, 2.0 * 7.2, name);
      assert.equal(p.cacheHit, 0.1 * 7.2, name);
      assert.equal(p.cacheWrite, 2.5 * 7.2, name);
      assert.equal(p.output, 10.0 * 7.2, name);
      assert.equal(p.estimated, false, name);
    }
  });

  it("maps the dated deepseek flash suffix to the flash price row", () => {
    const p = matchPrice("deepseek-v4.1-flash-1017", { fxRate: 7.2, time: Date.UTC(2026, 9, 20, 2) });
    assert.equal(p.id, "deepseek-flash");
    assert.equal(p.input, 2.0);
    assert.equal(p.estimated, false);
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
    assert.ok(ids.has("kimi-k3.1-pro"));
    assert.ok(ids.has("kimi-k3.1-pro-highspeed"));
    assert.ok(ids.has("kimi-k2.7-code-highspeed"));
    assert.ok(ids.has("deepseek-flash"));
    assert.ok(ids.has("deepseek-v4-pro"));
    assert.ok(ids.has("glm-5.3"));
    assert.ok(ids.has("glm-5.3-flash"));
    assert.ok(ids.has("gpt-6-sol"));
    assert.ok(ids.has("gpt-6-luna"));
    assert.ok(ids.has("gpt-5.6-sol"));
    const kimiK3 = prices.find((p) => p.id === "kimi-k3");
    assert.equal(kimiK3.nativeCurrency, "CNY");
    assert.equal(kimiK3.input, 20);
    const peakFlash = prices.find((p) => p.id === "deepseek-flash" && p.period === "peak");
    const offPeakFlash = prices.find((p) => p.id === "deepseek-flash" && p.period === "offPeak");
    assert.equal(peakFlash.nativeCurrency, "CNY");
    assert.equal(peakFlash.input, 2);
    assert.equal(offPeakFlash.output, 4);
    assert.equal(prices.find((p) => p.id === "qwen3.6-flash").input, 0.25 * 7.2);
    assert.equal(prices.find((p) => p.id === "qwen3.6-flash").output, 1.5 * 7.2);
    assert.equal(prices.find((p) => p.id === "qwen3.5-plus").input, 0.4 * 7.2);
    assert.equal(prices.find((p) => p.id === "qwen3.5-plus").output, 2.4 * 7.2);
    const minimaxM3 = prices.find((p) => p.id === "minimax-m3");
    assert.equal(minimaxM3.nativeCurrency, "CNY");
    assert.equal(minimaxM3.input, 2.1);
    assert.equal(minimaxM3.output, 8.4);
    assert.ok(prices.every((p) => /^https:\/\//.test(p.sourceUrl)));
    assert.equal(prices.find((p) => p.id === "gpt-6-sol").sourceUrl, "https://developers.openai.com/api/docs/models/gpt-6-sol");
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

  it("prices GPT-6 Sol and Luna at official Standard USD rates before CNY conversion", () => {
    const prices = listPrices({ fxRate: 7.2 });
    const sol = prices.find((p) => p.id === "gpt-6-sol");
    const luna = prices.find((p) => p.id === "gpt-6-luna");
    assert.deepEqual([sol.input, sol.cacheHit, sol.cacheWrite, sol.output],
      [2, 0.2, 2.5, 10].map((rate) => rate * 7.2));
    assert.deepEqual([luna.input, luna.cacheHit, luna.cacheWrite, luna.output],
      [0.1, 0.01, 0.125, 0.5].map((rate) => rate * 7.2));
    assert.equal(sol.nativeCurrency, "USD");
    assert.equal(luna.nativeCurrency, "USD");
    assert.equal(matchPrice("codex/gpt-6-sol", { fxRate: 7.2 }).id, "gpt-6-sol");
    assert.equal(matchPrice("gpt-6-luna", { fxRate: 7.2 }).id, "gpt-6-luna");
  });

  it("applies GPT-6 long-context rates to an entire request above 272K input", () => {
    const usage = {
      inputOther: 272_001,
      inputCacheRead: 1_000,
      inputCacheCreation: 1_000,
      output: 1_000,
    };
    const cost = costForUsage("gpt-6-luna", usage, {
      settings: { fxRate: 7.2, customPrices: [] },
    });
    // Unknown TTL uses the simple average of the $0.25/$0.50 long-context write rates.
    const expectedUsd = (272_001 * 0.2 + 1_000 * 0.02 + 1_000 * 0.375 + 1_000 * 0.75) / 1e6;
    assert.ok(Math.abs(cost.total - expectedUsd * 7.2) < 1e-12);
    assert.equal(cost.priceId, "gpt-6-luna");
  });

  it("uses the published GPT-5.6 long-context and cache-write rates", () => {
    const c = costForUsage("gpt-5.6-sol", {
      inputOther: 272_001,
      inputCacheRead: 1_000,
      inputCacheCreation: 1_000,
      output: 1_000,
    }, { skipSettings: true, settings: { fxRate: 7.2, customPrices: [] } });
    // Over 272K: input/cache x2, output x1.5; unknown TTL averages $10/$20 writes.
    const expected = ((272_001 * 8) + (1_000 * 0.8) + (1_000 * 15) + (1_000 * 30)) / 1e6;
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
