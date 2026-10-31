"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { migrateQuotaStorage, restoreQuotaBackup } = require("../src/quota-migration");
const { readSamples, appendSamples } = require("../src/quota-estimator-store");
const { buildSummary, quotaSamplesForSync, normalizePeerSummary } = require("../src/sync");

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dora-quota-migration-"));
}

function fixture() {
  const sampledAt = "2026-10-30T08:06:02.276Z";
  const sample = {
    version: 1,
    provider: "kimi",
    accountKey: "kimi:default",
    window: "weekly",
    sampledAt,
    usedPercent: 12.5,
    resetsAt: "reset-a",
    source: "kimi-api",
  };
  const history = {
    version: 1,
    provider: "kimi",
    accountKey: "kimi:default",
    usageScope: "all-clients",
    estimateKind: "standard",
    window: "weekly",
    cacheHitRate: 0.95,
    createdAt: "2026-10-30T09:00:00.000Z",
    calculationStartAt: sampledAt,
    calculationEndAt: "2026-10-30T09:00:00.000Z",
    previousCalculationEndAt: null,
    fullWindowTokens: 123456,
    fullWindowCostCny: 78.25,
    signature: "stable-signature",
  };
  const checkpoint = { anchorAt: sampledAt, anchorPercent: 12.5, resetsAt: "reset-a", lastRunAt: null };
  const state = {
    version: 1,
    cache: { "stable-cache-key": { provider: "kimi", accountKey: "kimi:default", algorithmVersion: 8, generatedAt: history.createdAt } },
    estimates: [history],
    maxima: {},
    checkpoints: { "standard-estimation:stable": checkpoint },
    calibrations: { "stable-calibration": { id: "cal-1", provider: "kimi", accountKey: "kimi:default", startAt: sampledAt } },
  };
  return { sample, history, state, checkpoint };
}

function writeV1(root, data = fixture()) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "samples.jsonl"), JSON.stringify(data.sample) + "\n");
  fs.writeFileSync(path.join(root, "history.jsonl"), JSON.stringify(data.history) + "\n");
  fs.writeFileSync(path.join(root, "state.json"), JSON.stringify(data.state, null, 1));
  return data;
}

test("v1 migration preserves values and stable keys, and is idempotent", () => {
  const root = tmpRoot();
  const data = writeV1(root);
  const result = migrateQuotaStorage(root);
  assert.equal(result.status, "migrated");
  assert.ok(fs.existsSync(path.join(result.backup, "manifest.json")));
  const sample = JSON.parse(fs.readFileSync(path.join(root, "samples.jsonl"), "utf8"));
  assert.equal(sample.version, 2);
  assert.equal(sample.quotaProvider, "kimi");
  assert.equal(sample.provider, undefined);
  assert.equal(sample.usedPercent, 12.5);
  const history = JSON.parse(fs.readFileSync(path.join(root, "history.jsonl"), "utf8"));
  assert.equal(history.fullWindowTokens, data.history.fullWindowTokens);
  assert.equal(history.calculationStartAt, data.history.calculationStartAt);
  assert.equal(history.signature, "stable-signature");
  const state = JSON.parse(fs.readFileSync(path.join(root, "state.json"), "utf8"));
  assert.equal(state.version, 2);
  assert.deepEqual(state.checkpoints["standard-estimation:stable"], data.checkpoint);
  assert.equal(state.cache["stable-cache-key"].quotaProvider, "kimi");
  assert.equal(state.cache["stable-cache-key"].provider, undefined);
  assert.equal(state.calibrations["stable-calibration"].quotaProvider, "kimi");
  const before = ["samples.jsonl", "history.jsonl", "state.json"].map((name) => fs.readFileSync(path.join(root, name), "utf8"));
  assert.equal(migrateQuotaStorage(root).status, "already_migrated");
  const after = ["samples.jsonl", "history.jsonl", "state.json"].map((name) => fs.readFileSync(path.join(root, name), "utf8"));
  assert.deepEqual(after, before);
  assert.equal(restoreQuotaBackup(result.backup, root).ok, true);
  assert.equal(fs.readFileSync(path.join(root, "samples.jsonl"), "utf8"), JSON.stringify(data.sample) + "\n");
  assert.equal(fs.readFileSync(path.join(root, "state.json"), "utf8"), JSON.stringify(data.state, null, 1));
});

test("conflicting identity fields abort without modifying the original file", () => {
  const root = tmpRoot();
  const original = JSON.stringify({ version: 1, provider: "kimi", quotaProvider: "openai", accountKey: "a", window: "weekly", sampledAt: "2026-10-30T00:00:00Z" }) + "\n";
  fs.writeFileSync(path.join(root, "samples.jsonl"), original);
  assert.throws(() => migrateQuotaStorage(root), (error) => error.code === "conflicting_quota_provider");
  assert.equal(fs.readFileSync(path.join(root, "samples.jsonl"), "utf8"), original);
  assert.equal(fs.existsSync(path.join(root, "migration.lock")), false);
});

test("a busy migration lock allows compatible reads but blocks writes", () => {
  const root = tmpRoot();
  const { sample } = writeV1(root);
  fs.writeFileSync(path.join(root, "migration.lock"), "busy");
  const restored = readSamples(root);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].provider, "kimi");
  assert.equal(restored[0].quotaProvider, "kimi");
  assert.throws(() => appendSamples([sample], root), (error) => error.code === "migration_lock_busy");
});

test("peer sync accepts v2-only samples and emits both compatibility fields", () => {
  const sample = {
    version: 2,
    quotaProvider: "kimi",
    accountKey: "kimi:work",
    window: "session",
    sampledAt: new Date().toISOString(),
    usedPercent: 20,
    source: "kimi-api",
  };
  const synced = quotaSamplesForSync([sample]);
  assert.equal(synced.length, 1);
  assert.equal(synced[0].provider, "kimi");
  assert.equal(synced[0].quotaProvider, "kimi");
  assert.equal(synced[0].accountKey, "kimi:work");
  assert.equal(buildSummary("device-a", [], null, synced).version, 3); // v3: + wsDaily/wsSalt, days 兼容 v2 读取
});

test("a tampered backup is rejected before restoring any files", () => {
  const root = tmpRoot();
  writeV1(root);
  const result = migrateQuotaStorage(root);
  const current = fs.readFileSync(path.join(root, "state.json"), "utf8");
  fs.appendFileSync(path.join(result.backup, "samples.jsonl"), "tampered");
  assert.throws(() => restoreQuotaBackup(result.backup, root), (error) => error.code === "backup_invalid");
  assert.equal(fs.readFileSync(path.join(root, "state.json"), "utf8"), current);
});

test("peer codec isolates conflicting samples without dropping valid accounts", () => {
  const valid = { version: 2, quotaProvider: "kimi", accountKey: "kimi:work", window: "session", sampledAt: "2026-10-30T00:00:00Z", usedPercent: 20 };
  const conflict = { provider: "kimi", quotaProvider: "openai", accountKey: "kimi:default", window: "session", sampledAt: "2026-10-30T00:00:00Z", usedPercent: 30 };
  const summary = normalizePeerSummary({ version: 2, days: {}, quotaSamples: [valid, conflict] });
  assert.equal(summary.quotaSamples.length, 1);
  assert.equal(summary.quotaSamples[0].accountKey, "kimi:work");
  assert.equal(summary.quotaSamples[0].provider, "kimi");
  const legacy = { version: 1, days: {} };
  assert.equal(normalizePeerSummary(legacy), legacy);
});

test("migration keeps the highest usage from repeated snapshots in the same reset window", () => {
  const root = tmpRoot();
  const { sample } = writeV1(root);
  fs.appendFileSync(path.join(root, "samples.jsonl"), JSON.stringify({ ...sample, usedPercent: 11.5 }) + "\n");
  fs.appendFileSync(path.join(root, "samples.jsonl"), JSON.stringify({ ...sample, usedPercent: 13.5 }) + "\n");
  const result = migrateQuotaStorage(root);
  assert.equal(result.status, "migrated");
  const rows = readSamples(root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].usedPercent, 13.5);
  assert.ok(fs.existsSync(path.join(result.backup, "samples.jsonl")));
});

test("migration still rejects duplicate snapshots from different reset windows", () => {
  const root = tmpRoot();
  const { sample } = writeV1(root);
  fs.appendFileSync(path.join(root, "samples.jsonl"), JSON.stringify({ ...sample, resetsAt: "reset-b", usedPercent: 13.5 }) + "\n");
  const original = fs.readFileSync(path.join(root, "samples.jsonl"), "utf8");
  assert.throws(() => migrateQuotaStorage(root), (error) => error.code === "migration_conflict");
  assert.equal(fs.readFileSync(path.join(root, "samples.jsonl"), "utf8"), original);
});
