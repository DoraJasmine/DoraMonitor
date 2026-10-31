"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { buildHeatmap, sliceHeatmap } = require("../src/aggregate");

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
        costCny: 0.01,
      },
      {
        time: now - 2 * 24 * 3600_000,
        inputOther: 5000,
        output: 500,
        inputCacheRead: 1000,
        inputCacheCreation: 0,
        costCny: 0.05,
      },
    ];
    const hm = buildHeatmap(records, now, 4);
    assert.ok(hm.cells.length >= 7);
    assert.ok(hm.maxTokens > 0);
    const active = hm.cells.filter((c) => c.totalTokens > 0);
    assert.ok(active.length >= 1);
    assert.ok(active.every((c) => c.level >= 1 && c.level <= 4));
  });

  it("reindexes a short range and recalculates its intensity and month labels", () => {
    const now = Date.parse("2026-07-26T12:00:00+08:00");
    const records = [
      { time: now - 40 * 86_400_000, inputOther: 100_000, output: 0, inputCacheRead: 0, inputCacheCreation: 0 },
      { time: now - 86_400_000, inputOther: 5000, output: 0, inputCacheRead: 0, inputCacheCreation: 0 },
    ];
    const full = buildHeatmap(records, now, 53);
    const week = sliceHeatmap(full, 7);
    assert.equal(week.cells.length, 7);
    assert.equal(week.start, "2026-07-20");
    assert.equal(week.end, "2026-07-26");
    assert.ok(week.cells.every((cell) => cell.weekIndex === 0));
    assert.equal(week.maxTokens, 5000);
    assert.equal(week.cells.find((cell) => cell.totalTokens === 5000).level, 4);
    assert.ok(week.monthLabels.every((label) => label.weekIndex === 0));

    const month = sliceHeatmap(full, 30);
    assert.equal(month.cells.length, 30);
    assert.equal(month.maxTokens, 5000);
    assert.equal(month.cells[0].weekIndex, 0);
    assert.ok(month.cells.every((cell) => cell.date > "2026-06-26"));
  });
});
