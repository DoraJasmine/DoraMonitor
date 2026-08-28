"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { buildHeatmap } = require("../src/aggregate");

describe("buildHeatmap", () => {
  it("returns leveled cells for recent activity", () => {
    const now = Date.parse("2026-07-26T12:00:00+08:00");
    const records = [
      {
        time: now - 3600_000,
        inputOther: 1000,
        output: 100,
        inputCacheRead: 0,
        inputCacheCreation: 0,
        costUsd: 0.01,
      },
      {
        time: now - 2 * 24 * 3600_000,
        inputOther: 5000,
        output: 500,
        inputCacheRead: 1000,
        inputCacheCreation: 0,
        costUsd: 0.05,
      },
    ];
    const hm = buildHeatmap(records, now, 4);
    assert.ok(hm.cells.length >= 7);
    assert.ok(hm.maxTokens > 0);
    const active = hm.cells.filter((c) => c.totalTokens > 0);
    assert.ok(active.length >= 1);
    assert.ok(active.every((c) => c.level >= 1 && c.level <= 4));
  });
});
