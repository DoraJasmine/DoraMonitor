"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { quotaProviderOf, normalizeQuotaRecord, normalizeQuotaState } = require("./quota-schema");

const FILES = ["samples.jsonl", "history.jsonl", "state.json"];
const migratedRoots = new Map();

function migrationError(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function digest(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function atomicWrite(file, content) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, content, "utf8");
    fs.renameSync(tmp, file);
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}

function withLock(root, action) {
  fs.mkdirSync(root, { recursive: true });
  const lock = path.join(root, "migration.lock");
  let handle;
  try {
    handle = fs.openSync(lock, "wx");
  } catch {
    migrationError("migration_lock_busy", "Another process is migrating quota data");
  }
  try {
    fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), "utf8");
    return action();
  } finally {
    fs.closeSync(handle);
    fs.unlinkSync(lock);
  }
}

function sampleKey(sample) {
  return [quotaProviderOf(sample), sample.accountKey, sample.window, sample.sampledAt, sample.source].join("\0");
}

function historyKey(item) {
  return [
    quotaProviderOf(item), item.accountKey || "default", item.usageScope, item.estimateKind || "standard",
    item.window, item.cacheHitRate, item.createdAt, item.signature || "",
  ].join("\0");
}

function transformJsonl(text, keyFor, file) {
  const rows = new Map();
  const warnings = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (index === lines.length - 1 || lines.slice(index + 1).every((item) => !item)) {
        warnings.push(`${file}:${index + 1} trailing unparsed line preserved in backup`);
        continue;
      }
      migrationError("migration_invalid_jsonl", `${file}:${index + 1} is not valid JSON`);
    }
    const normalized = normalizeQuotaRecord(parsed, { strict: true });
    const key = keyFor(normalized);
    if (rows.has(key) && JSON.stringify(rows.get(key)) !== JSON.stringify(normalized)) {
      migrationError("migration_conflict", `${file}:${index + 1} conflicts with an existing canonical key`);
    }
    rows.set(key, normalized);
  }
  const records = [...rows.values()];
  return { records, warnings };
}

function prepareMigration(root) {
  const plans = [];
  const warnings = [];
  for (const name of FILES) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    const original = fs.readFileSync(file, "utf8");
    if (name === "state.json") {
      let state;
      try {
        state = JSON.parse(original);
      } catch {
        migrationError("migration_invalid_state", "state.json is not valid JSON");
      }
      const normalized = normalizeQuotaState(state, { strict: true });
      const content = JSON.stringify(normalized, null, 1);
      plans.push({ name, file, content, count: 1, changed: content !== original });
    } else {
      const { records, warnings: rowWarnings } = transformJsonl(original, name === "samples.jsonl" ? sampleKey : historyKey, name);
      warnings.push(...rowWarnings);
      const content = records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : "");
      plans.push({ name, file, content, count: records.length, changed: content !== original });
    }
  }
  return { plans: plans.filter((plan) => plan.changed), warnings };
}

function backupOriginals(root, plans, backupRoot) {
  fs.mkdirSync(backupRoot, { recursive: true });
  const manifest = { createdAt: new Date().toISOString(), files: {} };
  for (const plan of plans) {
    const backup = path.join(backupRoot, plan.name);
    fs.copyFileSync(plan.file, backup);
    if (digest(backup) !== digest(plan.file)) migrationError("backup_failed", `Backup verification failed for ${plan.name}`);
    manifest.files[plan.name] = { bytes: fs.statSync(plan.file).size, sha256: digest(plan.file) };
  }
  atomicWrite(path.join(backupRoot, "manifest.json"), JSON.stringify(manifest, null, 1));
}

function migrateQuotaStorage(root) {
  if (!FILES.some((name) => fs.existsSync(path.join(root, name)))) return { ok: true, status: "already_migrated", count: 0 };
  return withLock(root, () => {
    const { plans, warnings } = prepareMigration(root);
    if (!plans.length) return { ok: true, status: "already_migrated", count: 0 };
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupRoot = path.join(root, "backups", `v1-to-v2-${stamp}-${process.pid}`);
    backupOriginals(root, plans, backupRoot);
    for (const plan of plans) {
      const tmp = `${plan.file}.${process.pid}.migrate.tmp`;
      fs.writeFileSync(tmp, plan.content, "utf8");
      if (plan.name === "state.json") JSON.parse(fs.readFileSync(tmp, "utf8"));
      else transformJsonl(fs.readFileSync(tmp, "utf8"), plan.name === "samples.jsonl" ? sampleKey : historyKey, plan.name);
    }
    for (const plan of plans) {
      const tmp = `${plan.file}.${process.pid}.migrate.tmp`;
      fs.renameSync(tmp, plan.file);
    }
    const report = {
      migratedAt: new Date().toISOString(),
      version: 2,
      backup: backupRoot,
      files: Object.fromEntries(plans.map((plan) => [plan.name, plan.count])),
      warnings,
    };
    atomicWrite(path.join(root, "migration-report.json"), JSON.stringify(report, null, 1));
    return { ok: true, status: "migrated", count: plans.length, backup: backupRoot, warnings };
  });
}

function ensureQuotaStorageMigrated(root, { write = false } = {}) {
  if (migratedRoots.get(root)) return { ok: true, status: "already_migrated" };
  try {
    const result = migrateQuotaStorage(root);
    migratedRoots.set(root, true);
    return result;
  } catch (error) {
    if (write) throw error;
    return { ok: false, status: "read_only_fallback", error };
  }
}

function restoreQuotaBackup(backupRoot, root) {
  return withLock(root, () => {
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(backupRoot, "manifest.json"), "utf8"));
    } catch {
      migrationError("backup_invalid", "Backup manifest is missing or invalid");
    }
    for (const name of FILES) {
      const backup = path.join(backupRoot, name);
      if (!fs.existsSync(backup)) continue;
      if (manifest.files?.[name]?.sha256 !== digest(backup)) migrationError("backup_invalid", `Backup verification failed for ${name}`);
    }
    for (const name of FILES) {
      const backup = path.join(backupRoot, name);
      if (fs.existsSync(backup)) atomicWrite(path.join(root, name), fs.readFileSync(backup, "utf8"));
    }
    migratedRoots.delete(root);
    return { ok: true };
  });
}

module.exports = { migrateQuotaStorage, ensureQuotaStorageMigrated, restoreQuotaBackup };
