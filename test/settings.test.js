"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { sanitizeSettings } = require("../src/settings");

test("dashboard settings default to visible quota cards and stable chart ranges", () => {
  const settings = sanitizeSettings({});
  assert.deepEqual(settings.dashboard, { hiddenQuotaCards: [], heatmapRange: "1y", dailyRange: "30d" });
});

test("dashboard settings accept supported ranges and deduplicate hidden cards", () => {
  const settings = sanitizeSettings({ dashboard: {
    hiddenQuotaCards: ["kimi-code:kimi:default", "kimi-code:kimi:default", "codex:openai:test", "invalid"],
    heatmapRange: "7d",
    dailyRange: "7d",
  } });
  assert.deepEqual(settings.dashboard.hiddenQuotaCards, ["kimi-code:kimi:default", "codex:openai:test"]);
  assert.equal(settings.dashboard.heatmapRange, "7d");
  assert.equal(settings.dashboard.dailyRange, "7d");
});

test("dashboard settings reject unknown ranges and non-boolean visibility data", () => {
  const settings = sanitizeSettings({ dashboard: { hiddenQuotaCards: "codex", heatmapRange: "all", dailyRange: "1y" } });
  assert.deepEqual(settings.dashboard, { hiddenQuotaCards: [], heatmapRange: "1y", dailyRange: "30d" });
});

test("kimi api keys are trimmed, length-capped and stored per account", () => {
  const settings = sanitizeSettings({
    kimiApiKey: "  sk-global  ",
    quotaAccounts: [
      { tool: "kimi-code", accountKey: "kimi:default", home: "/p", apiKey: " sk-a " },
      { tool: "kimi-code", accountKey: "kimi:work", home: "/w", apiKey: 42 },
    ],
  });
  assert.equal(settings.kimiApiKey, "sk-global");
  assert.equal(settings.quotaAccounts[0].apiKey, "sk-a");
  assert.equal(settings.quotaAccounts[1].apiKey, ""); // non-string becomes empty
});
