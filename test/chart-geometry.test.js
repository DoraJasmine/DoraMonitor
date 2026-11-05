"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

// 图表几何工具是给 Vite 前端用的 ESM,这里动态导入。
const load = () => import("../web/src/components/chart-geometry.mjs");

test("nearestIndex: 端点与刻度精确命中", async () => {
  const { nearestIndex } = await load();
  // 7 天视图在 640 宽 viewBox 下 44..628 的等距刻度
  const xs = [44, 141.33, 238.67, 336, 433.33, 530.67, 628];
  assert.equal(nearestIndex(44, xs), 0);
  assert.equal(nearestIndex(628, xs), 6);
  assert.equal(nearestIndex(336, xs), 3);
  assert.equal(nearestIndex(530.67, xs), 5);
});

test("nearestIndex: 刻度之间吸附到最近点,不再按容器宽度线性偏移", async () => {
  const { nearestIndex } = await load();
  const xs = [44, 141.33, 238.67, 336, 433.33, 530.67, 628];
  // 11-04 的真实刻度 530.67,偏移前后的点击都应收敛到索引 5
  assert.equal(nearestIndex(520, xs), 5);
  assert.equal(nearestIndex(540, xs), 5);
  // 11-05(最后一天)必须可达,旧实现会落到 11-04
  assert.equal(nearestIndex(620, xs), 6);
});

test("nearestIndex: 越界值吸附到最近端点", async () => {
  const { nearestIndex } = await load();
  const xs = [44, 141.33, 238.67, 336, 433.33, 530.67, 628];
  assert.equal(nearestIndex(0, xs), 0);
  assert.equal(nearestIndex(700, xs), 6);
});

test("nearestIndex: 单点与空序列", async () => {
  const { nearestIndex } = await load();
  assert.equal(nearestIndex(320, [320]), 0);
  assert.equal(nearestIndex(10, []), null);
  assert.equal(nearestIndex(10, null), null);
  assert.equal(nearestIndex(Number.NaN, [0, 1]), null);
});
