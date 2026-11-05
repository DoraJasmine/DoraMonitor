"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { mergePeerUsage, mergePeerWorkspaces } = require("../src/server");

const localResult = () => ({
  totals: {
    requests: 161,
    inputOther: 5_430_000,
    output: 67_000,
    inputCacheRead: 32_270_000,
    inputCacheCreation: 0,
    costCny: 50.12,
    credits: 0,
    totalTokens: 37_767_000,
    cacheHitRate: 32_270_000 / 37_767_000,
  },
  models: [
    {
      tool: "claude",
      model: "deepseek-v4.1-flash-1017",
      modelDisplay: "DeepSeek-V4.1-Flash",
      modelResolved: "deepseek-v4.1-flash-1017",
      priceId: null,
      costEstimated: true,
      estReq: 85,
      requests: 85,
      inputOther: 4_100_000,
      output: 50_000,
      inputCacheRead: 20_650_000,
      inputCacheCreation: 0,
      costCny: 33.1,
      credits: 0,
      totalTokens: 24_800_000,
    },
  ],
  daily: [{ date: "2026-11-04", requests: 161, inputOther: 5_430_000, output: 67_000, inputCacheRead: 32_270_000, inputCacheCreation: 0, costCny: 50.12, credits: 0, totalTokens: 37_767_000 }],
  hourly: [{ hour: 16, requests: 150, totalTokens: 37_000_000 }],
  workspaces: [{ workspaceKey: "ws1", workspaceName: "d:/proj", requests: 161, totalTokens: 37_767_000, inputOther: 5_430_000, output: 67_000, inputCacheRead: 32_270_000, inputCacheCreation: 0, credits: 0 }],
});

const peerRecord = (over) => ({
  device: "wsl",
  tool: "claude",
  model: "deepseek-v4.1-flash-1017",
  modelDisplay: "DeepSeek-V4.1-Flash",
  modelResolved: "deepseek-v4.1-flash-1017",
  day: "2026-11-04",
  time: new Date(2026, 10, 4, 12).getTime(),
  requests: 510,
  inputOther: 12_000_000,
  output: 200_000,
  inputCacheRead: 103_300_000,
  inputCacheCreation: 0,
  costCny: 90.51,
  credits: 0,
  ...over,
});

test("mergePeerUsage: 对端日汇总并进合计与模型,合计与趋势图一致", () => {
  const result = localResult();
  const merged = mergePeerUsage(result, [peerRecord()], {
    device: "all",
    startDay: "2026-11-04",
    endDay: "2026-11-04",
    tool: "all",
    workspace: "all",
    model: "all",
  });
  assert.ok(merged, "应返回对端贡献");
  assert.deepEqual(merged.devices, ["wsl"]);
  assert.equal(result.totals.requests, 671);
  assert.equal(result.totals.totalTokens, 37_767_000 + 115_500_000);
  // 同一 tool+model 合并为一行,而不是追加重复行
  assert.equal(result.models.length, 1);
  assert.equal(result.models[0].requests, 85 + 510);
  assert.equal(result.models[0].totalTokens, 24_800_000 + 115_500_000);
  // 小时分布仍是本机数据
  assert.equal(result.hourly.length, 1);
});

test("mergePeerUsage: 设备/工具/日期/模型筛选生效", () => {
  const result = localResult();
  assert.equal(mergePeerUsage(result, [peerRecord()], {
    device: "local", startDay: "2026-11-04", endDay: "2026-11-04", tool: "all", workspace: "all", model: "all",
  }), null);
  assert.equal(mergePeerUsage(localResult(), [peerRecord()], {
    device: "all", startDay: "2026-11-05", endDay: "2026-11-05", tool: "all", workspace: "all", model: "all",
  }), null);
  assert.equal(mergePeerUsage(localResult(), [peerRecord()], {
    device: "all", startDay: "2026-11-04", endDay: "2026-11-04", tool: "codex", workspace: "all", model: "all",
  }), null);
  // 指定工作区时对端没有工作区维度,不能混入
  assert.equal(mergePeerUsage(localResult(), [peerRecord()], {
    device: "all", startDay: "2026-11-04", endDay: "2026-11-04", tool: "all", workspace: "ws1", model: "all",
  }), null);
});

test("mergePeerUsage: 指定对端设备只并入该设备", () => {
  const result = localResult();
  const merged = mergePeerUsage(result, [peerRecord(), peerRecord({ device: "mac", requests: 10 })], {
    device: "wsl", startDay: "2026-11-04", endDay: "2026-11-04", tool: "all", workspace: "all", model: "all",
  });
  assert.ok(merged);
  assert.deepEqual(merged.devices, ["wsl"]);
  assert.equal(result.totals.requests, 671);
});

const peerWsRow = (over) => ({
  key: "peer:abcd1234",
  workspaceKey: "peer:abcd1234",
  workspaceName: "d:/proj",
  devices: ["wsl"],
  daily: { "2026-11-04": { i: 10_000_000, o: 200_000, cr: 90_000_000, cc: 0, req: 500, credits: 0 } },
  tools: [{ tool: "claude", totalTokens: 100_200_000, requests: 500 }],
  totalTokens: 100_200_000,
  requests: 500,
  credits: 0,
  ...over,
});

test("mergePeerWorkspaces: 同名工作区并入同一行,工作区用量不再只有本机", () => {
  const result = localResult();
  const devices = mergePeerWorkspaces(result, [peerWsRow()]);
  assert.deepEqual(devices, ["wsl"]);
  assert.equal(result.workspaces.length, 1);
  assert.equal(result.workspaces[0].totalTokens, 37_767_000 + 100_200_000);
  assert.equal(result.workspaces[0].requests, 161 + 500);
});

test("mergePeerWorkspaces: 无同名工作区时作为对端工作区追加", () => {
  const result = localResult();
  mergePeerWorkspaces(result, [peerWsRow({ workspaceName: "d:/other", workspaceKey: "peer:beefcafe" })]);
  assert.equal(result.workspaces.length, 2);
  const peerRow = result.workspaces.find((w) => w.workspaceKey === "peer:beefcafe");
  assert.ok(peerRow);
  assert.equal(peerRow.workspaceName, "d:/other");
  assert.equal(peerRow.totalTokens, 100_200_000);
  // 排序:对端行更大,排在第一
  assert.equal(result.workspaces[0].workspaceKey, "peer:beefcafe");
});

test("mergePeerWorkspaces: 空数据返回 null", () => {
  assert.equal(mergePeerWorkspaces(localResult(), []), null);
  assert.equal(mergePeerWorkspaces(localResult(), [peerWsRow({ daily: {}, totalTokens: 0, requests: 0 })]), null);
});
