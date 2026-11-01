"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");

/**
 * Self-update orchestrator (一键更新).
 *
 * Two deployment modes:
 *   - "source": the dashboard runs from a git working tree. Update =
 *     stop services → git fetch + ff-only merge → npm install → build →
 *     start services. Local uncommitted changes or a diverged branch
 *     abort the update (never discard user work).
 *   - "npm": installed globally. Update = `npm install -g doramonitor@latest`
 *     → restart services.
 *
 * The API endpoint (`POST /api/update/apply`) spawns THIS FILE as a detached
 * child process so the update survives the web server restart it performs
 * itself. Progress is written to ~/.doramonitor/update-status.json and read
 * back by `GET /api/update/status`. A stale "running" status (no progress
 * for 10 minutes) is reported as failed.
 */

const HOME_DIR = path.join(os.homedir(), ".doramonitor");
const STATUS_FILE = path.join(HOME_DIR, "update-status.json");
const LOG_FILE = path.join(HOME_DIR, "update.log");
const STALE_MS = 10 * 60_000;

function currentVersion() {
  return require("../package.json").version;
}

function detectMode(rootDir) {
  const repoDir = rootDir || path.join(__dirname, "..");
  if (fs.existsSync(path.join(repoDir, ".git"))) {
    return { mode: "source", repoDir };
  }
  return { mode: "npm", repoDir: null };
}

// ---------------------------------------------------------------------------
// Status file (read by the API while the detached updater runs)
// ---------------------------------------------------------------------------

function readStatus() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATUS_FILE, "utf8"));
    if (raw.phase === "running" && Date.now() - (raw.heartbeat || 0) > STALE_MS) {
      return { ...raw, phase: "error", error: "更新超时(10 分钟无进展),请查看 ~/.doramonitor/update.log" };
    }
    return raw;
  } catch {
    return null;
  }
}

function writeStatus(status) {
  try {
    fs.mkdirSync(HOME_DIR, { recursive: true });
    const tmp = `${STATUS_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...status, heartbeat: Date.now() }), "utf8");
    fs.renameSync(tmp, STATUS_FILE);
  } catch {
    /* best effort */
  }
}

function appendLog(line) {
  try {
    fs.mkdirSync(HOME_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`, "utf8");
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------
// Detached spawn (API side)
// ---------------------------------------------------------------------------

/** Spawn the updater as a detached child; returns { started, mode, error }. */
function spawnApply(rootDir) {
  try {
    const modeInfo = detectMode(rootDir);
    const running = readStatus();
    if (running && running.phase === "running" && Date.now() - (running.heartbeat || 0) < STALE_MS) {
      return { started: false, error: "已有更新正在进行中", mode: modeInfo.mode };
    }
    const script = __filename;
    const child = spawn(process.execPath, [script, "--run"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true, // 不弹命令行窗口
      cwd: modeInfo.repoDir || undefined,
      env: process.env,
    });
    child.unref();
    appendLog(`spawned updater (mode=${modeInfo.mode}, pid=${child.pid})`);
    return { started: true, mode: modeInfo.mode };
  } catch (err) {
    return { started: false, error: String(err && err.message ? err.message : err) };
  }
}

// ---------------------------------------------------------------------------
// Detached updater (script side, `node self-update.js --run`)
// ---------------------------------------------------------------------------

function sh(cmd, args, opts = {}) {
  const { env, ...rest } = opts;
  execFileSync(cmd, args, {
    stdio: "ignore",
    windowsHide: true,
    timeout: 10 * 60_000,
    ...rest,
    env: env || process.env,
  });
}

/** 子进程环境:把当前 node 目录并到 PATH 最前——脱离进程(计划任务拉起)
 *  的 PATH 不保证含 npm;git/git-bash 也在系统 PATH 中,合并无害。*/
function childEnv() {
  const nodeDir = path.dirname(process.execPath);
  return { ...process.env, PATH: `${nodeDir}${path.delimiter}${process.env.PATH || ""}` };
}

function stopServices() {
  const isWin = process.platform === "win32";
  appendLog("stopping services");
  if (isWin) {
    // web:通过端口找监听进程并终止;daemon:读取 pid 文件。
    try {
      const out = execFileSync("netstat", ["-ano"], { encoding: "utf8", timeout: 15_000, windowsHide: true });
      for (const line of out.split(/\r?\n/)) {
        if (/:\d+\s+.*LISTENING\s+(\d+)\s*$/.test(line) && /:3847\s/.test(line)) {
          const pid = line.trim().split(/\s+/).pop();
          if (pid && pid !== String(process.pid)) {
            try {
              execFileSync("taskkill", ["/F", "/PID", pid], { stdio: "ignore", timeout: 15_000, windowsHide: true });
              appendLog(`stopped web listener pid ${pid}`);
            } catch {
              /* already gone */
            }
          }
        }
      }
    } catch {
      /* netstat unavailable — schtasks /end below still applies */
    }
    for (const task of ["doramonitor-web", "doramonitor-daemon"]) {
      try {
        execFileSync("schtasks", ["/end", "/tn", task], { stdio: "ignore", timeout: 15_000, windowsHide: true });
      } catch {
        /* task not running */
      }
    }
    try {
      const daemonPid = fs.readFileSync(path.join(HOME_DIR, "daemon.pid"), "utf8").trim();
      if (daemonPid && daemonPid !== String(process.pid)) {
        try {
          execFileSync("taskkill", ["/F", "/PID", daemonPid], { stdio: "ignore", timeout: 15_000, windowsHide: true });
        } catch {
          /* already gone */
        }
      }
    } catch {
      /* no pid file */
    }
  } else {
    try {
      sh("systemctl", ["--user", "stop", "doramonitor-web.service", "doramonitor-daemon.service"]);
    } catch {
      appendLog("systemctl stop skipped (no user units?)");
    }
  }
}

function startServices() {
  const isWin = process.platform === "win32";
  appendLog("starting services");
  if (isWin) {
    for (const task of ["doramonitor-daemon", "doramonitor-web"]) {
      try {
        sh("schtasks", ["/run", "/tn", task], { timeout: 15_000 });
      } catch (err) {
        appendLog(`schtasks /run ${task} failed: ${err.message}`);
      }
    }
  } else {
    try {
      sh("systemctl", ["--user", "restart", "doramonitor-daemon.service", "doramonitor-web.service"]);
    } catch {
      appendLog("systemctl restart skipped (no user units?)");
    }
  }
}

async function waitHealthy(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch("http://127.0.0.1:3847/api/health", { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

async function run() {
  const fromVersion = currentVersion();
  const status = { phase: "running", progress: 5, fromVersion, toVersion: null, startedAt: new Date().toISOString(), error: null };
  writeStatus(status);
  appendLog(`update started (from ${fromVersion})`);
  try {
    const { mode, repoDir } = detectMode();
    status.mode = mode;
    writeStatus(status);

    stopServices();
    status.progress = 15;
    writeStatus(status);

    if (mode === "source") {
      status.phase = "fetching";
      status.progress = 25;
      writeStatus(status);
      const git = (args) => sh("git", args, { cwd: repoDir });
      // 已跟踪文件的未提交修改或与远端分叉时中止——绝不丢弃用户的工作。
      // 未跟踪文件不阻断:ff-only merge 与 reset --hard 均不触碰它们。
      let porcelain = "";
      try {
        porcelain = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: repoDir, encoding: "utf8", timeout: 15_000, windowsHide: true });
      } catch (err) {
        throw new Error(`git status 失败:${err.message}`);
      }
      if (porcelain.trim()) {
        throw new Error("本地有未提交修改,已中止更新(请先提交或暂存)");
      }
      appendLog("git fetch");
      git(["fetch", "origin", "main"]);
      try {
        git(["merge", "--ff-only", "origin/main"]);
      } catch {
        // ff 不可能:区分"仅提交图分叉"(内容一致,安全移动指针)与
        // "存在真实代码差异"(可能有未推送的工作,中止)。
        let diff = "";
        try {
          diff = execFileSync("git", ["diff", "--stat", "HEAD", "origin/main"], {
            cwd: repoDir, encoding: "utf8", timeout: 15_000, windowsHide: true,
          });
        } catch (err) {
          throw new Error(`git diff 失败:${err.message}`);
        }
        if (diff.trim()) {
          throw new Error("本地分支与 origin/main 存在实际代码差异,已中止更新(请手动处理)");
        }
        appendLog("diverged but identical tree → moving HEAD to origin/main");
        git(["reset", "--hard", "origin/main"]);
      }
      status.phase = "installing";
      status.progress = 50;
      writeStatus(status);
      appendLog("npm install");
      sh("npm", ["install", "--no-audit", "--no-fund"], { cwd: repoDir, timeout: 15 * 60_000, shell: process.platform === "win32", env: childEnv() });
      status.phase = "building";
      status.progress = 75;
      writeStatus(status);
      appendLog("npm run build");
      sh("npm", ["run", "build"], { cwd: repoDir, timeout: 10 * 60_000, shell: process.platform === "win32", env: childEnv() });
    } else {
      status.phase = "installing";
      writeStatus(status);
      appendLog("npm install -g doramonitor@latest");
      sh("npm", ["install", "-g", "doramonitor@latest", "--no-audit", "--no-fund"], { timeout: 15 * 60_000, shell: process.platform === "win32", env: childEnv() });
    }

    status.phase = "restarting";
    status.progress = 90;
    status.toVersion = currentVersion();
    writeStatus(status);
    startServices();

    appendLog("waiting for health");
    const healthy = await waitHealthy();
    if (!healthy) {
      throw new Error("更新后服务未能恢复健康(见 ~/.doramonitor/update.log)");
    }

    status.phase = "done";
    status.progress = 100;
    status.finishedAt = new Date().toISOString();
    writeStatus(status);
    appendLog(`update done (${fromVersion} → ${status.toVersion})`);
  } catch (err) {
    status.phase = "error";
    status.error = String(err && err.message ? err.message : err);
    status.finishedAt = new Date().toISOString();
    writeStatus(status);
    appendLog(`update FAILED: ${status.error}`);
    // 尽力恢复服务,避免看板停摆。
    try {
      startServices();
    } catch {
      /* ignore */
    }
  }
}

module.exports = {
  currentVersion,
  detectMode,
  spawnApply,
  readStatus,
  STATUS_FILE,
  LOG_FILE,
};

if (require.main === module) {
  if (process.argv.includes("--run")) {
    run();
  } else {
    console.log(JSON.stringify(readStatus()));
  }
}
