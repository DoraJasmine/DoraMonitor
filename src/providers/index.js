"use strict";

const fs = require("fs");
const path = require("path");
const { toolMeta, fileStamp } = require("./base");
const kimiCode = require("./kimi-code");
const zcode = require("./zcode");
const qoderCn = require("./qoder-cn");
const qoderCnCli = require("./qoder-cn-cli");
const codex = require("./codex");
const claudeCode = require("./claude-code");
const dsh = require("./dsh");

/**
 * Provider registry.
 *
 * Each provider turns one tool's local data into normalized usage records.
 * Adding a tool = adding a module here; aggregation, pricing, and UI consume
 * the registry without knowing provider internals.
 */
const PROVIDERS = [kimiCode, zcode, qoderCn, qoderCnCli, codex, claudeCode, dsh];

/** Resolve each provider's data home and availability. */
function listProviders() {
  return PROVIDERS.map((p) => {
    let home = null;
    try {
      home = p.defaultHome();
    } catch {
      home = null;
    }
    let available = false;
    try {
      available = !!home && p.isAvailable(home);
    } catch {
      available = false;
    }
    return { id: p.id, label: p.label, creditsOnly: !!p.creditsOnly, ...toolMeta(p.id), home, available };
  });
}

function getProvider(id) {
  return PROVIDERS.find((p) => p.id === id) || null;
}

/** Files whose change should trigger a rescan for a provider.
 * Cheap stat-only probe used for incremental cache validation. */
function sourceFiles(provider, home) {
  if (provider.id === "kimi-code") {
    const root = path.join(home, "sessions");
    return listFilesRecursive(root, "wire.jsonl");
  }
  if (provider.id === "qoder-cn-cli") {
    const root = path.join(home, "projects");
    return listFilesRecursive(root, ".jsonl", true);
  }
  if (provider.id === "zcode") {
    return [path.join(home, "cli", "db", "db.sqlite")];
  }
  if (provider.id === "qoder-cn") {
    return [path.join(home, "SharedClientCache", "cache", "db", "local.db")];
  }
  if (provider.id === "codex") {
    // Codex compresses older and archived rollouts to .jsonl.zst — the probe
    // must match the suffixes the scanner reads, or a compressed file
    // appearing/appearing never invalidates the cache.
    return [
      ...listRolloutFiles(path.join(home, "sessions")),
      ...listRolloutFiles(path.join(home, "archived_sessions")),
    ];
  }
  if (provider.id === "claude-code") {
    return listFilesRecursive(path.join(home, "projects"), ".jsonl", true);
  }
  if (provider.id === "dsh") {
    return [
      ...listFilesRecursive(path.join(home, "sessions"), ".jsonl.zstd", true),
      ...listFilesRecursive(path.join(home, "sessions"), ".jsonl", true),
    ];
  }
  return [];
}

function listFilesRecursive(root, matchName, suffix = false) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const full = path.join(root, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "blobs" || ent.name === "tasks" || ent.name === "node_modules") continue;
      out.push(...listFilesRecursive(full, matchName, suffix));
    } else if (ent.isFile()) {
      if (suffix ? ent.name.endsWith(matchName) : ent.name === matchName) out.push(full);
    }
  }
  return out;
}

const CODEX_ROLLOUT_SUFFIXES = [".jsonl.zst", ".jsonl.zstd", ".jsonl"];

/** Rollout files in the suffixes the Codex scanner actually reads. */
function listRolloutFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === "node_modules") continue;
        walk(full);
      } else if (
        ent.isFile() &&
        CODEX_ROLLOUT_SUFFIXES.some((suffix) => ent.name.endsWith(suffix))
      ) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

module.exports = {
  PROVIDERS,
  listProviders,
  getProvider,
  sourceFiles,
  fileStamp,
};
