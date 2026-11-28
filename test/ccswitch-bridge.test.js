"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const bridge = require("../src/ccswitch-bridge");

/**
 * Minimal cc-switch.db stand-in with the columns the bridge requires plus
 * the rollups table CC Switch archives into. `withRemoteSyncRow` simulates
 * a ccs-ssh-sync install for conflict tests.
 */
function createCcSwitchDb(root, { withRemoteSyncRow = false } = {}) {
  const dbPath = path.join(root, "cc-switch.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE proxy_request_logs (
      request_id TEXT PRIMARY KEY,
      provider_id TEXT,
      app_type TEXT,
      model TEXT,
      request_model TEXT,
      pricing_model TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_creation_tokens INTEGER,
      input_cost_usd TEXT,
      output_cost_usd TEXT,
      cache_read_cost_usd TEXT,
      cache_creation_cost_usd TEXT,
      total_cost_usd TEXT,
      latency_ms INTEGER,
      first_token_ms INTEGER,
      duration_ms INTEGER,
      status_code INTEGER,
      error_message TEXT,
      session_id TEXT,
      provider_type TEXT,
      is_streaming INTEGER,
      cost_multiplier TEXT,
      created_at INTEGER,
      data_source TEXT,
      input_token_semantics INTEGER
    );
    CREATE TABLE model_pricing (
      model_id TEXT PRIMARY KEY,
      input_cost_per_million TEXT,
      output_cost_per_million TEXT,
      cache_read_cost_per_million TEXT,
      cache_creation_cost_per_million TEXT
    );
    CREATE TABLE usage_daily_rollups (
      day TEXT,
      provider_id TEXT,
      app_type TEXT,
      request_count INTEGER
    );
  `);
  db.prepare(
    `INSERT INTO model_pricing VALUES ('kimi-k2', '1.0', '2.0', '0.1', '2.0')`
  ).run();
  if (withRemoteSyncRow) {
    db.prepare(
      `INSERT INTO proxy_request_logs (request_id, data_source, app_type) VALUES ('remote:x:kimi:y', 'remote_sync', 'kimi')`
    ).run();
  }
  db.close();
  return dbPath;
}

function writePeerSummary(root, days, { device = "GPU-01", deviceId = "dev-uuid-1" } = {}) {
  const cacheDir = path.join(root, ".doramonitor", "remote-cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(
    path.join(cacheDir, "gpu.json"),
    JSON.stringify({ version: 5, device, deviceId, generatedAt: new Date().toISOString(), days })
  );
  return cacheDir;
}

/** Isolate every os.homedir()-derived path (settings, cache, state, status). */
function isolate(t, root) {
  let home = root;
  t.mock.method(os, "homedir", () => home);
  bridge._setProcessProbeForTest(() => false);
  return {
    setHome(h) {
      home = h;
    },
    setProcessRunning(running) {
      bridge._setProcessProbeForTest(() => running);
    },
  };
}

function enableBridge(dbPath) {
  fs.mkdirSync(path.join(os.homedir(), ".doramonitor"), { recursive: true });
  fs.writeFileSync(
    path.join(os.homedir(), ".doramonitor", "config.json"),
    JSON.stringify({ ccSwitch: { enabled: true, dbPath } })
  );
}

function kimiDay(overrides = {}) {
  return {
    i: 1000, o: 500, cr: 2000, cc: 100, req: 2,
    lat: 4000, ft: 1000, dur: 3000,
    ...overrides,
  };
}

test("bridge rows: tokens, costs, timing averages and deterministic ids", () => {
  const catalog = {
    calculateCostColumns({ inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, cacheCreation1hTokens }) {
      // Deterministic stand-in: 1µUSD per token, 1h writes cost double.
      const total = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens + cacheCreation1hTokens;
      return {
        inputCostUsd: String(inputTokens),
        outputCostUsd: String(outputTokens),
        cacheReadCostUsd: String(cacheReadTokens),
        cacheCreationCostUsd: String(cacheCreationTokens),
        totalCostUsd: String(total),
      };
    },
  };
  const { rows, skippedTools, device } = bridge.rowsFromSummary(
    {
      device: "GPU-01",
      deviceId: "dev-uuid-1",
      days: {
        "2026-11-25": {
          "kimi-code": { "kimi-k2": kimiDay() },
          "qoder-cn": { "qoder-model": { i: 1, o: 1, req: 1 } },
        },
      },
    },
    catalog
  );
  assert.equal(device, "GPU-01");
  assert.deepEqual(skippedTools, { "qoder-cn": 1 });
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.requestId, "dora_bridge:dev-uuid-1:kimi-code:kimi-k2:2026-11-25");
  assert.equal(row.providerId, "GPU-01 · Kimi Code");
  assert.equal(row.appType, "kimi");
  assert.equal(row.inputTokens, 1000);
  assert.equal(row.outputTokens, 500);
  // timing sums → per-request averages for latency/ttft, sum for duration
  assert.equal(row.latencyMs, 2000);
  assert.equal(row.firstTokenMs, 500);
  assert.equal(row.durationMs, 3000);
  assert.equal(row.createdAt, Math.floor(new Date(2026, 10, 25, 12, 0, 0).getTime() / 1000), "created_at in seconds");
  assert.equal(row.totalCostUsd, String(1000 + 500 + 2000 + 100));
});

test("runBridge end-to-end: insert, idempotence, update, prune-protection, reset-reconcile", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dora-cc-bridge-"));
  const iso = isolate(t, root);
  const dbPath = createCcSwitchDb(root);
  writePeerSummary(root, { "2026-11-25": { "kimi-code": { "kimi-k2": kimiDay() } } });
  enableBridge(dbPath);

  // 1. First pass inserts.
  const first = bridge.runBridge();
  assert.equal(first.ok, true, `first pass: ${JSON.stringify(first)}`);
  assert.equal(first.inserted, 1);
  assert.equal(first.updated, 0);
  assert.deepEqual(first.byDevice, { "GPU-01": 1 });

  // 2. Second pass: content unchanged → nothing happens.
  const second = bridge.runBridge();
  assert.equal(second.ok, true);
  assert.equal(second.inserted, 0);
  assert.equal(second.updated, 0);
  assert.equal(second.unchanged, 1);

  // 3. Cell changed (more tokens) → guarded UPDATE, not a duplicate row.
  writePeerSummary(root, { "2026-11-25": { "kimi-code": { "kimi-k2": kimiDay({ o: 900 }) } } });
  const third = bridge.runBridge();
  assert.equal(third.ok, true);
  assert.equal(third.inserted, 0);
  assert.equal(third.updated, 1);

  const db = new DatabaseSync(dbPath, { readOnly: true });
  let rows = db.prepare(`SELECT request_id, output_tokens, total_cost_usd FROM proxy_request_logs WHERE data_source = 'dora_bridge'`).all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].output_tokens, 900);
  db.close();

  // 4. CC Switch archived (rollup) the row and dropped it from the log —
  //    the ledger must NOT resurrect it. Same content → hash-match skip.
  const dbw = new DatabaseSync(dbPath);
  dbw.exec(`DELETE FROM proxy_request_logs WHERE data_source = 'dora_bridge'`);
  dbw.prepare(`INSERT INTO usage_daily_rollups VALUES ('2026-11-25', 'GPU-01 · Kimi Code', 'kimi', 2)`).run();
  dbw.close();
  const fourth = bridge.runBridge();
  assert.equal(fourth.ok, true);
  assert.equal(fourth.unchanged, 1);
  assert.equal(fourth.inserted, 0);
  // Changed content on a pruned row → counted as pruned, still not resurrected.
  writePeerSummary(root, { "2026-11-25": { "kimi-code": { "kimi-k2": kimiDay({ o: 700 }) } } });
  const fourth2 = bridge.runBridge();
  assert.equal(fourth2.pruned, 1);
  assert.equal(fourth2.inserted, 0);
  const db2 = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(db2.prepare(`SELECT COUNT(*) AS n FROM proxy_request_logs WHERE data_source = 'dora_bridge'`).get().n, 0);
  db2.close();

  // 5. User resets cc-switch.db entirely (no bridge rows anywhere) →
  //    reconcile clears the ledger and backfills from scratch.
  const dbw2 = new DatabaseSync(dbPath);
  dbw2.exec(`DELETE FROM usage_daily_rollups`);
  dbw2.close();
  const fifth = bridge.runBridge();
  assert.equal(fifth.ok, true);
  assert.equal(fifth.inserted, 1);
  const db3 = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(db3.prepare(`SELECT COUNT(*) AS n FROM proxy_request_logs WHERE data_source = 'dora_bridge'`).get().n, 1);
  const rows5 = db3.prepare(`SELECT output_tokens FROM proxy_request_logs WHERE data_source = 'dora_bridge'`).all();
  db3.close();
  assert.equal(rows5[0].output_tokens, 700);

  iso.setHome(root); // keep the mock alive until test end
});

test("runBridge skips when disabled", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dora-cc-disabled-"));
  const iso = isolate(t, root);
  const result = bridge.runBridge();
  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "disabled");
  iso.setHome(root);
});

test("ccs-ssh-sync coexistence: process pauses, time watermark resumes after its last write", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dora-cc-coexist-"));
  const iso = isolate(t, root);
  const dbPath = createCcSwitchDb(root);
  const cacheDir = path.join(root, ".doramonitor", "remote-cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  // 摘要只有 2026-11-27 一天的聚合数据（无 requests 数组 → 全走聚合行）
  fs.writeFileSync(
    path.join(cacheDir, "gpu.json"),
    JSON.stringify({ version: 6, device: "GPU-01", deviceId: "dev-uuid-1", days: { "2026-11-27": { "kimi-code": { "kimi-k2": kimiDay() } } } })
  );
  enableBridge(dbPath);

  // 1. 对方守护进程在跑 → 暂停，什么都不写。
  iso.setProcessRunning(true);
  const paused = bridge.runBridge();
  assert.equal(paused.ok, false);
  assert.equal(paused.paused, true);
  assert.equal(paused.reason, "process");
  let db = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM proxy_request_logs").get().n, 0);
  db.close();

  // 2. 进程停了；对方写过 2026-11-27 中午（remote_sync 行）→ 水位线当天及之前跳过。
  iso.setProcessRunning(false);
  const wmSec = Math.floor(new Date(2026, 10, 27, 12, 0, 0).getTime() / 1000);
  const dbw = new DatabaseSync(dbPath);
  dbw.prepare("INSERT INTO proxy_request_logs (request_id, data_source, app_type, created_at) VALUES ('remote:x', 'remote_sync', 'kimi', ?)").run(wmSec);
  dbw.close();
  const coexist = bridge.runBridge();
  assert.equal(coexist.ok, true, JSON.stringify(coexist));
  assert.equal(coexist.inserted, 0, "水位线之内的聚合行被跳过");
  assert.deepEqual(coexist.watermarks, { kimi: wmSec });

  // 3. 新的一天出现（水位线之后）→ 正常增量写入。
  fs.writeFileSync(
    path.join(cacheDir, "gpu.json"),
    JSON.stringify({ version: 6, device: "GPU-01", deviceId: "dev-uuid-1", days: { "2026-11-27": { "kimi-code": { "kimi-k2": kimiDay() } }, "2026-11-28": { "kimi-code": { "kimi-k2": kimiDay({ o: 42 }) } } } })
  );
  const next = bridge.runBridge();
  assert.equal(next.ok, true);
  assert.equal(next.inserted, 1, "只写水位线之后的新一天");
  db = new DatabaseSync(dbPath, { readOnly: true });
  const daysWritten = db.prepare("SELECT DISTINCT date(created_at, 'unixepoch', 'localtime') d FROM proxy_request_logs WHERE data_source = 'dora_bridge'").all().map((r) => r.d);
  assert.deepEqual(daysWritten, ["2026-11-28"], "11-27 仍归对方写者，11-28 由桥接写入");
  db.close();

  // 4. 水位线单调持久：删掉对方的行也不会回退重写。
  const dbw2 = new DatabaseSync(dbPath);
  dbw2.prepare("DELETE FROM proxy_request_logs WHERE data_source = 'remote_sync'").run();
  dbw2.close();
  const after = bridge.runBridge();
  assert.equal(after.ok, true);
  assert.equal(after.inserted, 0, "水位线不回退，11-27 不会被补写");

  // 5. 显式清除水位线（对方数据已清理）→ 该天恢复可写。
  const { BridgeState } = bridge;
  const state = new BridgeState();
  state.clearWatermarks();
  state.close();
  const resumed = bridge.runBridge();
  assert.equal(resumed.ok, true);
  assert.equal(resumed.inserted, 1, "清除水位线后 11-27 由桥接接管");
  iso.setHome(root);
});

test("request-level resume: before-watermark skipped, boundary fingerprint-deduped, after written", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dora-cc-resume-"));
  const iso = isolate(t, root);
  const dbPath = createCcSwitchDb(root);
  const cacheDir = path.join(root, ".doramonitor", "remote-cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  enableBridge(dbPath);

  // 对方写者（ccs-ssh-sync）写过一条 kimi 请求 @ T0（同一底层请求的指纹）。
  const wmSec = Math.floor(new Date(2026, 11, 27, 12, 0, 0).getTime() / 1000);
  const dbw = new DatabaseSync(dbPath);
  dbw.prepare(
    "INSERT INTO proxy_request_logs (request_id, data_source, app_type, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, created_at) VALUES ('remote:x:kimi:m1', 'remote_sync', 'kimi', 'k3.1-pro', 100, 50, 10, 2, ?)"
  ).run(wmSec);
  dbw.close();

  // 桥接摘要的请求窗口横跨水位线：
  //   m-before @ T0-3600  → 早于水位线 → 跳过
  //   m-dup    @ T0+5     → 指纹相同（模型归一化 'kimi-code/k3.1-pro'→'k3.1-pro'）→ 边界去重跳过
  //   m-new    @ T0+3600  → 新请求 → 写入
  const t0 = wmSec * 1000;
  const summary = {
    version: 6, device: "GPU-01", deviceId: "dev-uuid-1",
    days: {},
    requests: [
      { i: "h:before", t: t0 - 3_600_000, l: "kimi-code", m: "kimi-code/k3.1-pro", iv: 100, o: 50, cr: 10, cc: 2 },
      { i: "n:dup", t: t0 + 5_000, l: "kimi-code", m: "kimi-code/k3.1-pro", iv: 100, o: 50, cr: 10, cc: 2 },
      { i: "n:new", t: t0 + 3_600_000, l: "kimi-code", m: "kimi-code/k3.1-pro", iv: 200, o: 60, cr: 12, cc: 3 },
    ],
    requestsDays: ["2026-11-27"],
  };
  fs.writeFileSync(path.join(cacheDir, "gpu.json"), JSON.stringify(summary));

  const r = bridge.runBridge();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.inserted, 1, "只有水位线之后且指纹不匹配的新请求写入");
  assert.equal(r.skippedOtherWriter, 2, "早于水位线 + 边界指纹命中 各跳过一条");

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const ids = db.prepare("SELECT request_id FROM proxy_request_logs WHERE request_id LIKE 'dora_bridge:r:%'").all().map((x) => x.request_id);
  assert.equal(ids.length, 1);
  assert.ok(ids[0].includes("n_new"), "写入的是新请求（冒号被 sanitize）");
  db.close();
  iso.setHome(root);
});

test("status reports the conflict so the UI can show the notice", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dora-cc-status-"));
  const iso = isolate(t, root);
  const dbPath = createCcSwitchDb(root, { withRemoteSyncRow: true });
  enableBridge(dbPath);
  const st = bridge.bridgeStatus();
  assert.equal(st.enabled, true);
  assert.equal(st.pausedByConflict, false, "数据级冲突不再暂停——由水位线接管");
  assert.equal(st.otherWriterData, true);
  assert.ok(st.conflictCheckedAt);
  iso.setHome(root);
});
