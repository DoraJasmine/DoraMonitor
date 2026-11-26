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

test("peerWorkspaceSummaries: records actual cell tool (never 'all') and filters by tool", () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const { peerWorkspaceSummaries, savePeersToCache } = require("../src/sync");
  const prevHome = process.env.USERPROFILE;
  const prevUnixHome = process.env.HOME;
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "dora-peer-ws-"));
  process.env.USERPROFILE = tmpHome;
  process.env.HOME = tmpHome;
  try {
    savePeersToCache([
      {
        version: 4,
        device: "wsl",
        days: { "2026-11-26": { "kimi-code": { k3: { i: 100, o: 10, cr: 0, cc: 0, req: 1 } } } },
        wsNames: { abc123: "compareExp" },
        wsDaily: {
          "2026-11-26": {
            "kimi-code": { abc123: { i: 100, o: 10, cr: 0, cc: 0, req: 1, credits: 0 } },
            codex: { abc123: { i: 200, o: 20, cr: 0, cc: 0, req: 2, credits: 0 } },
          },
        },
      },
    ]);
    const allTools = peerWorkspaceSummaries("wsl", { tool: "all" });
    assert.equal(allTools.length, 1);
    assert.deepEqual(
      allTools[0].tools.map((t) => t.tool),
      ["codex", "kimi-code"]
    );
    assert.equal(allTools[0].totalTokens, 330);

    const codexOnly = peerWorkspaceSummaries("wsl", { tool: "codex" });
    assert.equal(codexOnly.length, 1);
    assert.deepEqual(codexOnly[0].tools, [{ tool: "codex", totalTokens: 220, requests: 2 }]);

    const agyOnly = peerWorkspaceSummaries("wsl", { tool: "antigravity" });
    assert.equal(agyOnly.length, 0);
  } finally {
    if (prevHome === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevHome;
    if (prevUnixHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevUnixHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("mergePeerUsage: resolved 筛选只并入匹配计价身份的对端记录,且命中率与全站口径一致", () => {
  const result = {
    totals: {
      requests: 0, inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0,
      costCny: 0, credits: 0, totalTokens: 0, cacheHitRate: 0,
    },
    models: [],
    daily: [],
    hourly: [],
    workspaces: [],
  };
  const hydrogen = peerRecord({
    tool: "antigravity",
    model: "Gemini 4 Hydrogen (High)",
    modelDisplay: "Gemini 4 Hydrogen (High)",
    modelResolved: "Gemini 4 Hydrogen (High)",
    requests: 10,
    inputOther: 1000,
    output: 500,
    inputCacheRead: 9000,
    inputCacheCreation: 0,
  });
  const neon = peerRecord({
    tool: "antigravity",
    model: "Gemini 4 Neon (XHigh)",
    modelDisplay: "Gemini 4 Neon (XHigh)",
    modelResolved: "Gemini 4 Neon (XHigh)",
    requests: 5,
    inputOther: 2000,
    output: 1000,
    inputCacheRead: 2000,
    inputCacheCreation: 0,
  });
  const merged = mergePeerUsage(result, [hydrogen, neon], {
    device: "all",
    startDay: "2026-11-04",
    endDay: "2026-11-04",
    tool: "antigravity",
    workspace: "all",
    model: "all",
    resolved: "gemini-4-hydrogen",
  });
  assert.ok(merged);
  assert.equal(result.totals.requests, 10);
  assert.equal(result.models.length, 1);
  assert.equal(result.models[0].model, "Gemini 4 Hydrogen (High)");
  // 命中率 = cacheRead / (inputOther + cacheRead + cacheCreation) = 9000 / 10000 = 0.9（不含 output，不含 cacheWrite）
  assert.equal(result.totals.cacheHitRate, 0.9);
  assert.equal(result.models[0].cacheHitRate, 0.9);
});

test("mergePeerWorkspaces: 缓存命中率排除 output 与 cacheCreation 误记分子", () => {
  const result = { workspaces: [] };
  mergePeerWorkspaces(result, [
    peerWsRow({
      daily: { "2026-11-04": { i: 1000, o: 5000, cr: 9000, cc: 0, req: 10, credits: 0 } },
      totalTokens: 15000,
      requests: 10,
    }),
  ]);
  assert.equal(result.workspaces[0].cacheHitRate, 0.9);
});
