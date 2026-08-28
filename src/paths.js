"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

/**
 * Resolve the Kimi Code data home directory.
 * Priority: explicit override → KIMI_CODE_HOME → ~/.kimi-code
 */
function resolveKimiHome(override) {
  if (override && String(override).trim()) {
    return path.resolve(expandHome(String(override).trim()));
  }
  if (process.env.KIMI_CODE_HOME && process.env.KIMI_CODE_HOME.trim()) {
    return path.resolve(expandHome(process.env.KIMI_CODE_HOME.trim()));
  }
  return path.join(os.homedir(), ".kimi-code");
}

function expandHome(p) {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  // Windows %USERPROFILE% style
  return p.replace(/%([^%]+)%/g, (_, name) => process.env[name] || `%${name}%`);
}

function defaultCandidates() {
  const list = [];
  if (process.env.KIMI_CODE_HOME) {
    list.push(path.resolve(expandHome(process.env.KIMI_CODE_HOME)));
  }
  list.push(path.join(os.homedir(), ".kimi-code"));
  // Windows user profile explicit form
  if (process.env.USERPROFILE) {
    list.push(path.join(process.env.USERPROFILE, ".kimi-code"));
  }
  // de-dupe
  return [...new Set(list.map((p) => path.normalize(p)))];
}

function isKimiHome(dir) {
  if (!dir || !fs.existsSync(dir)) return false;
  try {
    const st = fs.statSync(dir);
    if (!st.isDirectory()) return false;
    // Heuristic: sessions/ or config.toml or wire.jsonl somewhere
    if (fs.existsSync(path.join(dir, "config.toml"))) return true;
    if (fs.existsSync(path.join(dir, "sessions"))) return true;
    return false;
  } catch {
    return false;
  }
}

function sessionsRoot(home) {
  return path.join(home, "sessions");
}

function configPath(home) {
  return path.join(home, "config.toml");
}

module.exports = {
  resolveKimiHome,
  expandHome,
  defaultCandidates,
  isKimiHome,
  sessionsRoot,
  configPath,
};
