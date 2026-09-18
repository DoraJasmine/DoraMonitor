#!/usr/bin/env node
"use strict";

/**
 * Kimi Code TUI status_line plugin — cloud quota + local usage in one line.
 *
 * Kimi Code reads [status_line] command in ~/.kimi-code/tui.toml, feeds it a
 * JSON snapshot (model, cwd, git, usage, mode) on stdin and shows the first
 * stdout line as footer line 1. This script merges that snapshot with the
 * structured status files written by the ai-usage daemon(s):
 * ~/.ai-usage-monitor/status.json — the rendered usage line plus cloud quota.
 *
 * Merge rules (Windows native + WSL on the same machine):
 *   - usage line: the freshest status file on THIS side; falls back to the
 *     other side tagged "(win)"/"(wsl)".
 *   - quota: account-wide, so the freshest file whose quota is available
 *     wins, whichever side produced it.
 *
 * Status file search order:
 *   $AI_USAGE_STATUS_FILE
 *   ~/.ai-usage-monitor/status.json                    (this side)
 *   \\wsl.localhost\<distro>\home\<u>\...              (Windows reading WSL)
 *   /mnt/c/Users/<u>/.ai-usage-monitor/status.json     (WSL reading Windows)
 *
 * Output example:
 *   K2.8 Preview | 5h 8%(1h42m) | 周 23%(4d1h) | K:1.2M ¥12.34 (0.05x) 命中:88.2%
 *
 * No dependencies; runs on any Node >= 12. stdin is optional — without a
 * snapshot it still prints the quota/usage line (handy for testing).
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const STALE_MS = 150_000; // daemon default tick is 30s; tolerate a few misses

function readStdinSnapshot(callback) {
  let data = "";
  let settled = false;
  const done = () => {
    if (settled) return;
    settled = true;
    let snap = null;
    try {
      snap = JSON.parse(data);
    } catch {
      snap = null;
    }
    callback(snap);
  };
  try {
    if (process.stdin.isTTY) return done();
  } catch {
    // not a TTY — keep reading
  }
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    data += chunk;
  });
  process.stdin.on("end", done);
  // Never block the footer if stdin never closes.
  setTimeout(done, 2000);
}

function modelName(snap) {
  if (!snap || typeof snap !== "object") return null;
  const m = snap.model;
  let name = null;
  if (typeof m === "string") name = m;
  else if (m && typeof m === "object") {
    name = m.display_name || m.displayName || m.name || m.id || null;
  }
  if (!name) return null;
  // "kimi-code/kimi-for-coding" → "kimi-for-coding"
  const idx = name.lastIndexOf("/");
  if (idx >= 0 && idx < name.length - 1) name = name.slice(idx + 1);
  return name;
}

/** Enumerate every status file we can see, tagged own/cross. */
function statusCandidates() {
  const ownHome = path.resolve(os.homedir());
  const out = [];
  const push = (file) => {
    if (!file) return;
    const real = path.resolve(file);
    // UNC (\\wsl.localhost\...) = WSL side; /mnt/* = Windows side; else ours.
    let side = "own";
    if (real.startsWith("\\\\")) side = "wsl";
    else if (process.platform !== "win32" && real.startsWith("/mnt/")) side = "win";
    out.push({ file: real, side });
  };

  const env = process.env.AI_USAGE_STATUS_FILE;
  if (env && env.trim()) push(env.trim());
  push(path.join(ownHome, ".ai-usage-monitor", "status.json"));

  if (process.platform === "win32") {
    // Windows native: peek into every WSL distro's user homes.
    try {
      for (const distro of fs.readdirSync("\\\\wsl.localhost")) {
        let homes = null;
        try {
          homes = fs.readdirSync(`\\\\wsl.localhost\\${distro}\\home`);
        } catch {
          continue;
        }
        for (const user of homes) {
          push(`\\\\wsl.localhost\\${distro}\\home\\${user}\\.ai-usage-monitor\\status.json`);
        }
      }
    } catch {
      // WSL not installed or VM unreachable
    }
  } else {
    // WSL: fall back to the Windows-side daemon.
    try {
      for (const user of fs.readdirSync("/mnt/c/Users")) {
        if (user === "Public" || user === "Default" || user.startsWith(".")) continue;
        push(`/mnt/c/Users/${user}/.ai-usage-monitor/status.json`);
      }
    } catch {
      // no /mnt/c — plain Linux
    }
  }
  return out;
}

function readStatuses() {
  const found = [];
  for (const cand of statusCandidates()) {
    let payload = null;
    try {
      payload = JSON.parse(fs.readFileSync(cand.file, "utf8"));
    } catch {
      continue;
    }
    let mtime = 0;
    try {
      mtime = fs.statSync(cand.file).mtimeMs;
    } catch {
      // payload already parsed; treat as fresh
    }
    found.push({ ...cand, payload, mtime, stale: Date.now() - mtime > STALE_MS });
  }
  return found;
}

function countdown(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const s = Math.round((t - Date.now()) / 1000);
  if (!Number.isFinite(s) || s <= 0) return null;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${String(m % 60).padStart(2, "0")}m`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24}h`;
}

function quotaParts(statuses) {
  // Quota is account-wide: freshest AVAILABLE window set wins, own side first on ties.
  const withQuota = statuses
    .filter((s) => s.payload && s.payload.quota && s.payload.quota.available)
    .sort((a, b) => b.mtime - a.mtime || (a.side === "own" ? -1 : 1));
  if (!withQuota.length) return null;
  const windows = withQuota[0].payload.quota.windows;
  if (!Array.isArray(windows) || !windows.length) return null;
  const label = { session: "5h", weekly: "周" };
  const parts = [];
  for (const w of windows) {
    if (!w || typeof w.usedPercent !== "number") continue;
    const tag = label[w.kind] || w.label || "?";
    const left = countdown(w.resetsAt);
    parts.push(`${tag} ${Math.round(w.usedPercent)}%${left ? `(${left})` : ""}`);
  }
  return parts.length ? parts : null;
}

function linePart(statuses) {
  // Usage is per-filesystem: prefer this side's freshest file, else the other.
  const own = statuses.filter((s) => s.side === "own").sort((a, b) => b.mtime - a.mtime);
  const cross = statuses.filter((s) => s.side !== "own").sort((a, b) => b.mtime - a.mtime);
  const src = own[0] || cross[0];
  if (!src) return null;
  const line = src.payload && typeof src.payload.line === "string" ? src.payload.line.trim() : "";
  const crossTag = src.side === "own" ? "" : src.side === "wsl" ? "(wsl)" : "(win)";
  if (src.stale) return `${line || "本地:—"}${crossTag}(缓存过期)`;
  if (!line) return null;
  return line + crossTag;
}

function render(snap) {
  const parts = [];

  const model = modelName(snap);
  if (model) parts.push(model);
  const mode = snap && typeof snap.mode === "string" && snap.mode && snap.mode !== "normal" ? snap.mode : null;
  if (mode) parts.push(`[${mode}]`);

  const statuses = readStatuses();
  if (!statuses.length) {
    parts.push("额度:—", "本地:—(无 daemon)");
    return parts.join(" | ");
  }

  const quota = quotaParts(statuses);
  parts.push(...(quota || ["额度:—"]));

  const line = linePart(statuses);
  parts.push(line || "本地:—");

  return parts.join(" | ");
}

readStdinSnapshot((snap) => {
  process.stdout.write(render(snap) + "\n");
});
