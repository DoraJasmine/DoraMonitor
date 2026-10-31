"use strict";

const fs = require("fs");
const path = require("path");

/**
 * Workspace normalization — turns each tool's raw `project` field into a
 * stable { workspaceKey, workspaceName } pair (FR-10).
 *
 * Rules per tool:
 *   claude-code / codex / omp / dsh / qoder-cn(-cli): `project` is a real
 *     cwd (or project dir name) — key = the cwd, display = last segment.
 *   kimi-code: `project` is a `wd_<name>_<hash>` directory id. Resolve the
 *     real work dir via the workspace's sessions (state.json workDir) or
 *     workspaces.json meta, cached for 60s; fall back to the raw id.
 *   zcode / gemini: source data carries no workspace — `__unknown__`.
 *   missing/empty project: `__unknown__` as well (never fabricate).
 *
 * Aliases (settings.workspaceAliases) replace DISPLAY names only; the key is
 * stable regardless. Aliases are local-only and never synced.
 *
 * Reserved keys: `__unknown__` (no source data), `__legacy__` (imported
 * bucket-only history predating the row store).
 */

const UNKNOWN_KEY = "__unknown__";
const LEGACY_KEY = "__legacy__";
const UNKNOWN_NAME = "未知工作区";
const LEGACY_NAME = "未分组（历史）";

/** wd_* → { workDir, name } cache, keyed by kimi home. 60s TTL. */
const kimiCache = new Map();
const KIMI_CACHE_TTL_MS = 60_000;

function baseName(p) {
  const s = String(p || "").replace(/[\\/]+$/, "");
  if (!s) return "";
  const idx = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return idx >= 0 ? s.slice(idx + 1) : s;
}

function fromCwd(project) {
  const key = String(project || "").trim();
  if (!key) return null;
  const name = baseName(key) || key;
  return { workspaceKey: key, workspaceName: name };
}

/** Kimi `wd_*` id → real work dir. Primary source: workspaces.json meta
 *  (`root` — the authoritative workspace directory); fallback: the newest
 *  session's state.json `cwd`. Kept local to ingestion to avoid coupling
 *  the session manager into it. */
function kimiWorkspaceLookup(home, workspaceId) {
  const now = Date.now();
  const cached = kimiCache.get(home);
  if (cached && now - cached.at < KIMI_CACHE_TTL_MS) {
    return cached.map.get(workspaceId) || null;
  }
  const map = new Map();
  // 1) workspaces.json — id → { root, name }
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(home, "workspaces.json"), "utf8"));
    for (const [id, entry] of Object.entries(meta.workspaces || {})) {
      if (!entry || typeof entry.root !== "string" || !entry.root.trim()) continue;
      const rootDir = entry.root.trim();
      const name = (typeof entry.name === "string" && entry.name.trim()) || baseName(rootDir);
      map.set(id, { workDir: rootDir, name: usableName(name) || id });
    }
  } catch {
    /* no/invalid workspaces.json */
  }
  // 2) session dirs not covered by meta — probe state.json cwd
  const root = path.join(home, "sessions");
  try {
    for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.name === ".kcd-archive") continue;
      if (!/^wd_[\w.-]+_[0-9a-f]+$/.test(ent.name)) continue;
      if (map.has(ent.name)) continue;
      const info = probeKimiWorkspaceDir(path.join(root, ent.name));
      if (info) map.set(ent.name, info);
    }
  } catch {
    /* missing sessions dir → empty map */
  }
  kimiCache.set(home, { at: now, map });
  return map.get(workspaceId) || null;
}

/** Display-name sanitizer: drive roots ("C:") are not useful names. */
function usableName(name) {
  const n = String(name || "").trim();
  if (!n || /^[a-zA-Z]:?$/.test(n)) return null;
  return n;
}

/** Probe one wd_* dir: workDir from the newest session's state.json,
 *  display name from workspaces.json meta or the decoded dir id. */
function probeKimiWorkspaceDir(dir) {
  let newest = null;
  let newestM = 0;
  let sessions = [];
  try {
    sessions = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return null;
  }
  for (const s of sessions) {
    const stPath = path.join(dir, s.name, "state.json");
    try {
      const st = fs.statSync(stPath);
      if (st.mtimeMs > newestM) {
        newestM = st.mtimeMs;
        newest = stPath;
      }
    } catch {
      /* no state.json in this session */
    }
  }
  let workDir = null;
  if (newest) {
    try {
      const o = JSON.parse(fs.readFileSync(newest, "utf8"));
      const cwd = o && typeof o.cwd === "string" && o.cwd.trim() ? o.cwd.trim() : null;
      if (cwd) workDir = cwd;
    } catch {
      /* corrupt state.json */
    }
  }
  // Display name: workspaces.json meta wins; else decoded dir id; else workDir tail.
  let name = null;
  try {
    const wp = path.join(path.dirname(path.dirname(dir + path.sep)), "workspaces.json");
    const meta = JSON.parse(fs.readFileSync(wp, "utf8"));
    const id = path.basename(dir);
    const entry = meta && meta.workspaces && meta.workspaces[id];
    if (entry && typeof entry.name === "string" && entry.name.trim()) name = entry.name.trim();
  } catch {
    /* no/invalid workspaces.json */
  }
  if (!name && workDir) name = baseName(workDir);
  name = usableName(name);
  if (!name) {
    // wd_<name>_<hash> → humanize the <name> part
    const m = path.basename(dir).match(/^wd_(.+)_[0-9a-f]+$/);
    if (m) name = m[1].replace(/_/g, " ");
  }
  if (!workDir && !name) return null;
  return { workDir, name: name || baseName(workDir) || "kimi" };
}

/**
 * Normalize one usage record's project field into a workspace identity.
 * Returns { workspaceKey, workspaceName } — never null.
 */
function normalizeWorkspace(toolId, record, home) {
  const project = record && record.project ? String(record.project) : "";
  if (!project) {
    return { workspaceKey: UNKNOWN_KEY, workspaceName: UNKNOWN_NAME };
  }
  if (toolId === "kimi-code") {
    if (/^wd_[\w.-]+_[0-9a-f]+$/.test(project)) {
      const hit = home ? kimiWorkspaceLookup(home, project) : null;
      if (hit && hit.workDir) {
        return { workspaceKey: hit.workDir, workspaceName: hit.name || baseName(hit.workDir) };
      }
      if (hit && hit.name) {
        return { workspaceKey: project, workspaceName: hit.name };
      }
      // Meta/session lookup missed — at least decode the human part of the id.
      const m = project.match(/^wd_(.+)_[0-9a-f]+$/);
      let decoded = m ? m[1] : "";
      try {
        decoded = decodeURIComponent(decoded);
      } catch {
        /* 非法百分号序列按原样使用 */
      }
      return { workspaceKey: project, workspaceName: m ? decoded.replace(/_/g, " ") || project : project };
    }
    const cwd = fromCwd(project);
    if (cwd) return cwd;
    return { workspaceKey: UNKNOWN_KEY, workspaceName: UNKNOWN_NAME };
  }
  // Real-cwd tools: claude-code, codex, omp, dsh, qoder-cn(-cli).
  const cwd = fromCwd(project);
  if (cwd) return cwd;
  return { workspaceKey: UNKNOWN_KEY, workspaceName: UNKNOWN_NAME };
}

/** Apply a display alias (settings.workspaceAliases) to a workspace row. */
function applyAlias(row, aliases) {
  if (!row || !aliases || typeof aliases !== "object") return row;
  const alias = aliases[row.workspaceKey];
  return alias ? { ...row, workspaceName: alias, aliased: true } : row;
}

module.exports = {
  UNKNOWN_KEY,
  LEGACY_KEY,
  UNKNOWN_NAME,
  LEGACY_NAME,
  normalizeWorkspace,
  applyAlias,
};
