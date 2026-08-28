"use strict";

const fs = require("fs");
const path = require("path");
const { sessionsRoot } = require("./paths");

const ARCHIVE_DIR = ".kcd-archive";
const SESSION_RE = /^session_[0-9a-fA-F-]{8,}$/;
const WORKSPACE_RE = /^wd_[A-Za-z0-9._-]+$/;

function workspacesJsonPath(home) {
  return path.join(home, "workspaces.json");
}

function sessionIndexPath(home) {
  return path.join(home, "session_index.jsonl");
}

function loadWorkspaceMeta(home) {
  const p = workspacesJsonPath(home);
  if (!fs.existsSync(p)) return { version: 1, workspaces: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    return {
      version: raw.version || 1,
      workspaces: raw.workspaces || {},
      deleted: raw.deleted_workspace_ids || [],
    };
  } catch {
    return { version: 1, workspaces: {} };
  }
}

function listWorkspaceDirs(home) {
  const root = sessionsRoot(home);
  const out = [];
  if (!fs.existsSync(root)) return out;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (ent.name === ARCHIVE_DIR) continue;
    if (!WORKSPACE_RE.test(ent.name)) continue;
    out.push(ent.name);
  }
  return out.sort();
}

function readStateSafe(sessionDir) {
  const sp = path.join(sessionDir, "state.json");
  if (!fs.existsSync(sp)) {
    return { title: null, workDir: null, createdAt: null, updatedAt: null };
  }
  try {
    const o = JSON.parse(fs.readFileSync(sp, "utf8"));
    // Never surface lastPrompt / custom blobs
    return {
      title: typeof o.title === "string" ? o.title : null,
      workDir: typeof o.workDir === "string" ? o.workDir : null,
      createdAt: o.createdAt || null,
      updatedAt: o.updatedAt || null,
      isCustomTitle: !!o.isCustomTitle,
    };
  } catch {
    return { title: null, workDir: null, createdAt: null, updatedAt: null };
  }
}

function dirSizeApprox(dir) {
  let total = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let ents;
    try {
      ents = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      const full = path.join(cur, e.name);
      try {
        if (e.isDirectory()) stack.push(full);
        else if (e.isFile()) {
          total += fs.statSync(full).size;
          files += 1;
        }
      } catch {
        /* skip */
      }
    }
  }
  return { bytes: total, files };
}

function listSessionsInDir(dir, workspaceId, status) {
  const sessions = [];
  if (!fs.existsSync(dir)) return sessions;
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return sessions;
  }
  for (const ent of ents) {
    if (!ent.isDirectory() || !SESSION_RE.test(ent.name)) continue;
    const sessionDir = path.join(dir, ent.name);
    const meta = readStateSafe(sessionDir);
    let size = { bytes: 0, files: 0 };
    try {
      size = dirSizeApprox(sessionDir);
    } catch {
      /* ignore */
    }
    let mtime = null;
    try {
      mtime = fs.statSync(sessionDir).mtimeMs;
    } catch {
      /* ignore */
    }
    sessions.push({
      id: ent.name,
      workspaceId,
      status,
      title: meta.title || ent.name,
      workDir: meta.workDir,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt || (mtime ? new Date(mtime).toISOString() : null),
      bytes: size.bytes,
      files: size.files,
    });
  }
  return sessions;
}

/**
 * List workspaces and sessions under a kimi home.
 * status: active | archived | all
 * workspace: optional filter
 */
function listSessions(home, options = {}) {
  const status = options.status || "active";
  const workspaceFilter = options.workspace || null;
  const meta = loadWorkspaceMeta(home);
  const root = sessionsRoot(home);
  const archiveRoot = path.join(root, ARCHIVE_DIR);

  const workspaceIds = new Set(listWorkspaceDirs(home));
  // Also include archive-only workspaces
  if (fs.existsSync(archiveRoot)) {
    try {
      for (const ent of fs.readdirSync(archiveRoot, { withFileTypes: true })) {
        if (ent.isDirectory() && WORKSPACE_RE.test(ent.name)) {
          workspaceIds.add(ent.name);
        }
      }
    } catch {
      /* ignore */
    }
  }
  if (workspaceFilter) {
    if (!WORKSPACE_RE.test(workspaceFilter)) {
      return { error: "invalid_workspace", workspaces: [], sessions: [] };
    }
  }

  const workspaces = [];
  const sessions = [];

  for (const wid of [...workspaceIds].sort()) {
    if (workspaceFilter && wid !== workspaceFilter) continue;
    const info = meta.workspaces[wid] || {};
    const activeDir = path.join(root, wid);
    const archDir = path.join(archiveRoot, wid);
    // Count once — avoid triple directory walks
    const activeAll = listSessionsInDir(activeDir, wid, "active");
    const archAll = listSessionsInDir(archDir, wid, "archived");
    const activeList = status === "archived" ? [] : activeAll;
    const archList = status === "active" ? [] : archAll;
    const allForWs = [...activeList, ...archList];
    workspaces.push({
      id: wid,
      name: info.name || humanizeWorkspace(wid),
      root: info.root || null,
      createdAt: info.created_at || null,
      lastOpenedAt: info.last_opened_at || null,
      activeCount: activeAll.length,
      archivedCount: archAll.length,
      empty: activeAll.length === 0 && archAll.length === 0,
    });
    sessions.push(...allForWs);
  }

  sessions.sort((a, b) => {
    const ta = Date.parse(a.updatedAt || a.createdAt || 0) || 0;
    const tb = Date.parse(b.updatedAt || b.createdAt || 0) || 0;
    return tb - ta;
  });

  return {
    home,
    archiveRoot: ARCHIVE_DIR,
    workspaces,
    sessions,
  };
}

function humanizeWorkspace(id) {
  // wd_name_hash → name
  const m = String(id).match(/^wd_(.+)_[0-9a-f]{8,}$/i);
  if (m) return m[1];
  return id;
}

function assertSafeSessionPath(home, workspaceId, sessionId) {
  if (!WORKSPACE_RE.test(workspaceId)) {
    throw Object.assign(new Error("invalid workspace id"), { code: "invalid_workspace" });
  }
  if (!SESSION_RE.test(sessionId)) {
    throw Object.assign(new Error("invalid session id"), { code: "invalid_session" });
  }
  const root = path.resolve(sessionsRoot(home));
  return { root };
}

function resolveActivePath(home, workspaceId, sessionId) {
  assertSafeSessionPath(home, workspaceId, sessionId);
  const root = path.resolve(sessionsRoot(home));
  const full = path.resolve(root, workspaceId, sessionId);
  if (!full.startsWith(root + path.sep) && full !== root) {
    throw Object.assign(new Error("path escape blocked"), { code: "path_escape" });
  }
  return full;
}

function resolveArchivePath(home, workspaceId, sessionId) {
  assertSafeSessionPath(home, workspaceId, sessionId);
  const root = path.resolve(sessionsRoot(home));
  const full = path.resolve(root, ARCHIVE_DIR, workspaceId, sessionId);
  const archRoot = path.resolve(root, ARCHIVE_DIR);
  if (!full.startsWith(archRoot + path.sep) && full !== archRoot) {
    throw Object.assign(new Error("path escape blocked"), { code: "path_escape" });
  }
  return full;
}

function rmRecursive(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function moveDir(src, dest) {
  ensureDir(path.dirname(dest));
  if (fs.existsSync(dest)) {
    throw Object.assign(new Error("destination already exists"), { code: "exists" });
  }
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    // Cross-device fallback
    fs.cpSync(src, dest, { recursive: true });
    rmRecursive(src);
  }
}

/** Remove matching lines from session_index.jsonl (best-effort). */
function scrubSessionIndex(home, sessionId) {
  const p = sessionIndexPath(home);
  if (!fs.existsSync(p)) return { removed: 0 };
  let text;
  try {
    text = fs.readFileSync(p, "utf8");
  } catch {
    return { removed: 0 };
  }
  const lines = text.split(/\r?\n/);
  const kept = [];
  let removed = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.includes(`"sessionId":"${sessionId}"`) || line.includes(`"sessionId": "${sessionId}"`)) {
      removed += 1;
      continue;
    }
    // also match by session dir basename
    if (line.includes(`/${sessionId}"`) || line.includes(`\\${sessionId}"`)) {
      removed += 1;
      continue;
    }
    kept.push(line);
  }
  if (removed > 0) {
    fs.writeFileSync(p, kept.join("\n") + (kept.length ? "\n" : ""), "utf8");
  }
  return { removed };
}

function archiveSession(home, workspaceId, sessionId) {
  const src = resolveActivePath(home, workspaceId, sessionId);
  if (!fs.existsSync(src)) {
    throw Object.assign(new Error("session not found"), { code: "not_found" });
  }
  const dest = resolveArchivePath(home, workspaceId, sessionId);
  moveDir(src, dest);
  // Keep index pointing? Prefer scrub so kimi doesn't open missing path
  scrubSessionIndex(home, sessionId);
  // Clean empty workspace dir (optional, keep for isolation identity)
  return { ok: true, workspaceId, sessionId, status: "archived", path: dest };
}

function unarchiveSession(home, workspaceId, sessionId) {
  const src = resolveArchivePath(home, workspaceId, sessionId);
  if (!fs.existsSync(src)) {
    throw Object.assign(new Error("archived session not found"), { code: "not_found" });
  }
  const dest = resolveActivePath(home, workspaceId, sessionId);
  moveDir(src, dest);
  // Re-append minimal index entry if workDir known
  const st = readStateSafe(dest);
  appendSessionIndex(home, {
    sessionId,
    sessionDir: dest.replace(/\\/g, "/"),
    workDir: st.workDir || null,
  });
  return { ok: true, workspaceId, sessionId, status: "active", path: dest };
}

function appendSessionIndex(home, entry) {
  const p = sessionIndexPath(home);
  try {
    fs.appendFileSync(p, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    /* ignore */
  }
}

function deleteSession(home, workspaceId, sessionId, statusHint) {
  let target = null;
  const active = resolveActivePath(home, workspaceId, sessionId);
  const archived = resolveArchivePath(home, workspaceId, sessionId);
  if (statusHint === "archived" && fs.existsSync(archived)) target = archived;
  else if (statusHint === "active" && fs.existsSync(active)) target = active;
  else if (fs.existsSync(active)) target = active;
  else if (fs.existsSync(archived)) target = archived;
  else {
    throw Object.assign(new Error("session not found"), { code: "not_found" });
  }
  rmRecursive(target);
  scrubSessionIndex(home, sessionId);
  return { ok: true, workspaceId, sessionId, deleted: true, path: target };
}

/**
 * Delete an empty workspace directory (no active/archived sessions).
 * Also removes empty archive workspace folder and updates workspaces.json.
 */
function deleteWorkspace(home, workspaceId, options = {}) {
  if (!WORKSPACE_RE.test(workspaceId)) {
    throw Object.assign(new Error("invalid workspace id"), { code: "invalid_workspace" });
  }
  const root = path.resolve(sessionsRoot(home));
  const activeDir = path.resolve(root, workspaceId);
  const archDir = path.resolve(root, ARCHIVE_DIR, workspaceId);

  if (!activeDir.startsWith(root + path.sep)) {
    throw Object.assign(new Error("path escape blocked"), { code: "path_escape" });
  }

  const activeSessions = listSessionsInDir(activeDir, workspaceId, "active");
  const archSessions = listSessionsInDir(archDir, workspaceId, "archived");
  if (activeSessions.length > 0 || archSessions.length > 0) {
    throw Object.assign(
      new Error("workspace is not empty; archive/delete sessions first"),
      {
        code: "not_empty",
        activeCount: activeSessions.length,
        archivedCount: archSessions.length,
      }
    );
  }

  const force = options.force === true;
  // Remove empty dirs if present
  if (fs.existsSync(activeDir)) {
    // ensure no unexpected non-session content unless force
    const leftovers = safeListNames(activeDir);
    if (leftovers.length && !force) {
      throw Object.assign(
        new Error("workspace directory has leftover files"),
        { code: "not_empty", leftovers: leftovers.slice(0, 10) }
      );
    }
    rmRecursive(activeDir);
  }
  if (fs.existsSync(archDir)) {
    rmRecursive(archDir);
  }

  // Update workspaces.json — move id to deleted_workspace_ids
  const wp = workspacesJsonPath(home);
  if (fs.existsSync(wp)) {
    try {
      const raw = JSON.parse(fs.readFileSync(wp, "utf8"));
      raw.workspaces = raw.workspaces || {};
      raw.deleted_workspace_ids = raw.deleted_workspace_ids || [];
      if (raw.workspaces[workspaceId]) {
        delete raw.workspaces[workspaceId];
      }
      if (!raw.deleted_workspace_ids.includes(workspaceId)) {
        raw.deleted_workspace_ids.push(workspaceId);
      }
      fs.writeFileSync(wp, JSON.stringify(raw, null, 2) + "\n", "utf8");
    } catch {
      /* ignore meta write failures */
    }
  }

  return { ok: true, workspaceId, deleted: true };
}

function safeListNames(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => n !== "." && n !== "..");
  } catch {
    return [];
  }
}

const PREVIEW_MAX_MESSAGES = 80;
const PREVIEW_MAX_CHARS = 2500;

function clipText(s, max = PREVIEW_MAX_CHARS) {
  // Strip NULs and lone surrogates so JSON.stringify never emits invalid UTF-8/JSON.
  let t = String(s || "")
    .replace(/\u0000/g, "")
    .replace(/[\uD800-\uDFFF]/g, "\uFFFD")
    // collapse extreme control chars except \n \t
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  if (t.length <= max) return t;
  return t.slice(0, max) + "…";
}

function extractTextParts(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const p of content) {
    if (!p || typeof p !== "object") continue;
    if (typeof p.text === "string") parts.push(p.text);
    else if (p.type === "text" && typeof p.text === "string") parts.push(p.text);
  }
  return parts.join("\n");
}

function extractTurnInputText(input) {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return "";
  return input
    .map((x) => {
      if (!x) return "";
      if (typeof x === "string") return x;
      if (x.type === "text" && typeof x.text === "string") return x.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function normalizePreviewText(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeSecret(raw) {
  return /api[_-]?key|sk-[a-zA-Z0-9]{12,}|BEGIN (RSA |OPENSSH )?PRIVATE KEY/i.test(
    raw
  );
}

function pushPreviewMessage(messages, msg) {
  if (!msg || !msg.text || !String(msg.text).trim()) return;
  const norm = normalizePreviewText(msg.text);
  if (!norm) return;
  const last = messages[messages.length - 1];
  // Drop exact consecutive duplicates (turn.prompt + append_message, steers, etc.)
  if (
    last &&
    last.role === msg.role &&
    normalizePreviewText(last.text) === norm
  ) {
    // keep earlier timestamp if missing on last
    if (!last.time && msg.time) last.time = msg.time;
    return;
  }
  messages.push({
    role: msg.role,
    time: msg.time || null,
    text: clipText(msg.text),
  });
}

function flushAssistantStep(messages, bucket) {
  if (!bucket) return;
  const text = (bucket.texts || []).join("");
  if (!text.trim()) return;
  pushPreviewMessage(messages, {
    role: "assistant",
    time: bucket.time || null,
    text: looksLikeSecret(text)
      ? "[redacted: possible secret content]"
      : text,
  });
}

/**
 * Privacy-safe session preview: roles + truncated text only.
 * - User: context.append_message (preferred); turn.prompt/steer only as fallback
 * - Assistant: reconstruct from content.part loop events (wire rarely stores role=assistant)
 * Skips tool dumps, usage, credentials. Caps message count/size.
 */
function getSessionPreview(home, workspaceId, sessionId, statusHint) {
  assertSafeSessionPath(home, workspaceId, sessionId);
  let sessionDir = null;
  const active = resolveActivePath(home, workspaceId, sessionId);
  const archived = resolveArchivePath(home, workspaceId, sessionId);
  if (statusHint === "archived" && fs.existsSync(archived)) sessionDir = archived;
  else if (fs.existsSync(active)) sessionDir = active;
  else if (fs.existsSync(archived)) sessionDir = archived;
  else {
    throw Object.assign(new Error("session not found"), { code: "not_found" });
  }

  const meta = readStateSafe(sessionDir);
  const wireCandidates = [
    path.join(sessionDir, "agents", "main", "wire.jsonl"),
    path.join(sessionDir, "wire.jsonl"),
  ];
  // also first agent wire if main missing
  const agentsDir = path.join(sessionDir, "agents");
  if (fs.existsSync(agentsDir)) {
    try {
      for (const name of fs.readdirSync(agentsDir)) {
        const w = path.join(agentsDir, name, "wire.jsonl");
        if (fs.existsSync(w) && !wireCandidates.includes(w)) wireCandidates.push(w);
      }
    } catch {
      /* ignore */
    }
  }

  let wirePath = null;
  for (const c of wireCandidates) {
    if (fs.existsSync(c)) {
      wirePath = c;
      break;
    }
  }

  const messages = [];
  let truncated = false;
  if (wirePath) {
    let text = "";
    try {
      text = fs.readFileSync(wirePath, "utf8");
    } catch {
      text = "";
    }
    const lines = text.split(/\r?\n/);
    // stepKey -> { texts:[], time }
    let currentAssistant = null;
    let currentStepKey = null;

    const maybeStartAssistantStep = (stepKey, time) => {
      if (currentStepKey && currentStepKey !== stepKey) {
        flushAssistantStep(messages, currentAssistant);
        currentAssistant = null;
      }
      currentStepKey = stepKey;
      if (!currentAssistant) {
        currentAssistant = { texts: [], time: time || null };
      } else if (!currentAssistant.time && time) {
        currentAssistant.time = time;
      }
    };

    for (const line of lines) {
      if (!line) continue;
      if (messages.length >= PREVIEW_MAX_MESSAGES) {
        truncated = true;
        break;
      }
      // Fast path filter
      if (
        !line.includes('"context.append_message"') &&
        !line.includes('"turn.steer"') &&
        !line.includes('"turn.prompt"') &&
        !line.includes('"content.part"') &&
        !line.includes('"step.end"')
      ) {
        continue;
      }
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const type = obj.type;

      if (type === "context.append_message") {
        // Flush pending assistant text before a new user/system message
        if (currentAssistant) {
          flushAssistantStep(messages, currentAssistant);
          currentAssistant = null;
          currentStepKey = null;
        }
        const msg = obj.message || {};
        const role = msg.role || "unknown";
        if (role === "tool") continue;
        const raw = extractTextParts(msg.content);
        if (!raw.trim()) continue;
        pushPreviewMessage(messages, {
          role,
          time: obj.time || null,
          text: looksLikeSecret(raw)
            ? "[redacted: possible secret content]"
            : raw,
        });
        continue;
      }

      if (type === "turn.steer" || type === "turn.prompt") {
        // Only use as user fallback; dedupe will drop if append_message already added it.
        const raw = extractTurnInputText(obj.input);
        if (!raw.trim()) continue;
        // Prefer not to interrupt assistant reconstruction mid-step unless empty
        pushPreviewMessage(messages, {
          role: "user",
          time: obj.time || null,
          text: looksLikeSecret(raw)
            ? "[redacted: possible secret content]"
            : raw,
        });
        continue;
      }

      if (type === "context.append_loop_event") {
        const ev = obj.event || {};
        const evType = ev.type;
        if (evType === "content.part") {
          const part = ev.part || {};
          // Visible assistant reply text only (skip think / tool_use noise)
          if (part.type === "text" && typeof part.text === "string" && part.text) {
            const stepKey = String(
              ev.stepUuid || `${ev.turnId || ""}:${ev.step || ""}`
            );
            maybeStartAssistantStep(stepKey, obj.time || null);
            currentAssistant.texts.push(part.text);
          }
          continue;
        }
        if (evType === "step.end") {
          flushAssistantStep(messages, currentAssistant);
          currentAssistant = null;
          currentStepKey = null;
        }
      }
    }
    // trailing assistant buffer
    flushAssistantStep(messages, currentAssistant);
    if (lines.length > 8000) truncated = true;
    if (messages.length >= PREVIEW_MAX_MESSAGES) truncated = true;
  }

  return {
    workspaceId,
    sessionId,
    status: sessionDir.includes(ARCHIVE_DIR) ? "archived" : "active",
    title: meta.title || sessionId,
    workDir: meta.workDir,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    messageCount: messages.length,
    truncated,
    messages,
  };
}

module.exports = {
  ARCHIVE_DIR,
  listSessions,
  archiveSession,
  unarchiveSession,
  deleteSession,
  deleteWorkspace,
  getSessionPreview,
  scrubSessionIndex,
  WORKSPACE_RE,
  SESSION_RE,
};
