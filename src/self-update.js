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
 *     preflight git status/fetch/divergence → stop services → merge/reset →
 *     npm install → build → start services. Local uncommitted changes,
 *     detached HEAD, untracked feature branch, or diverged tree abort
 *     BEFORE touching running services (never discard user work).
 *   - "npm": installed globally (including `--prefix ~/.local`). Update =
 *     stop services → `npm install -g [--prefix <dir>] doramonitor@latest`
 *     → start services.
 *
 * The API endpoint (`POST /api/update/apply`) writes initial status and spawns
 * THIS FILE as a detached child process (`--port <p> --host <h>`) so the
 * update survives restarting the web server on any configured port/host.
 */

const HOME_DIR = path.join(os.homedir(), ".doramonitor");
const STATUS_FILE = path.join(HOME_DIR, "update-status.json");
const LOG_FILE = path.join(HOME_DIR, "update.log");
const STALE_MS = 10 * 60_000;
const DEFAULT_PORT = 3847;
const DEFAULT_HOST = "127.0.0.1";
const ACTIVE_PHASES = new Set(["running", "fetching", "installing", "building", "restarting"]);

function isActivePhase(phase) {
  return ACTIVE_PHASES.has(phase);
}

/**
 * Read package.json version directly from disk so long-running / post-merge
 * checks never observe a stale `require.cache` entry.
 */
function readVersionFromDisk(packageDir) {
  const pkgPath = path.join(packageDir || path.join(__dirname, ".."), "package.json");
  try {
    const raw = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    return typeof raw.version === "string" && raw.version ? raw.version : null;
  } catch {
    return null;
  }
}

function currentVersion(packageDir) {
  return readVersionFromDisk(packageDir) || require("../package.json").version;
}

function detectMode(rootDir) {
  const repoDir = rootDir || path.join(__dirname, "..");
  if (fs.existsSync(path.join(repoDir, ".git"))) {
    return { mode: "source", repoDir };
  }
  return { mode: "npm", repoDir: null };
}

/**
 * Derive `--prefix <dir>` when running from an installed `node_modules/doramonitor`
 * directory (e.g. `~/.local/lib/node_modules/doramonitor` created by
 * `install-linux.sh`, or `%APPDATA%\npm\node_modules\doramonitor`).
 */
function npmPrefixForPackage(packageDir, platform = process.platform) {
  if (!packageDir) return null;
  const p = platform === "win32" ? path.win32 : path.posix;
  const resolved = p.resolve(packageDir);
  if (p.basename(resolved) !== "doramonitor") return null;
  const nm = p.dirname(resolved);
  if (p.basename(nm).toLowerCase() !== "node_modules") return null;
  const parent = p.dirname(nm);
  if (platform === "win32") return parent;
  return p.basename(parent) === "lib" ? p.dirname(parent) : null;
}

function parseRunArgs(argv = process.argv.slice(2)) {
  let port = DEFAULT_PORT;
  let host = DEFAULT_HOST;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port" && i + 1 < argv.length) {
      const n = Number(argv[++i]);
      if (Number.isInteger(n) && n >= 1 && n <= 65535) port = n;
    } else if (argv[i] === "--host" && i + 1 < argv.length) {
      const h = String(argv[++i] || "").trim();
      if (h) host = h;
    }
  }
  return { port, host };
}

function resolveHealthHost(host) {
  if (!host || host === "0.0.0.0" || host === "::" || host === "[::]") return "127.0.0.1";
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

// ---------------------------------------------------------------------------
// Status file (read by the API while the detached updater runs)
// ---------------------------------------------------------------------------

function readStatus(statusFile = STATUS_FILE) {
  try {
    const raw = JSON.parse(fs.readFileSync(statusFile, "utf8"));
    if (raw && isActivePhase(raw.phase) && Date.now() - (raw.heartbeat || 0) > STALE_MS) {
      return { ...raw, phase: "error", error: "更新超时(10 分钟无进展),请查看 ~/.doramonitor/update.log" };
    }
    return raw;
  } catch {
    return null;
  }
}

function writeStatus(status, statusFile = STATUS_FILE) {
  try {
    fs.mkdirSync(path.dirname(statusFile), { recursive: true });
    const tmp = `${statusFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...status, heartbeat: Date.now() }), "utf8");
    fs.renameSync(tmp, statusFile);
  } catch {
    /* best effort */
  }
}

function appendLog(line, logFile = LOG_FILE) {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`, "utf8");
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------
// Detached spawn (API side)
// ---------------------------------------------------------------------------

/**
 * Spawn the updater as a detached child; returns { started, mode, error }.
 * Optional opts: { port, host, statusFile, logFile, _spawn } for server/tests.
 */
function spawnApply(rootDir, opts = {}) {
  const statusFile = opts.statusFile || STATUS_FILE;
  const logFile = opts.logFile || LOG_FILE;
  const port = Number.isInteger(Number(opts.port)) && Number(opts.port) > 0 ? Number(opts.port) : DEFAULT_PORT;
  const host = typeof opts.host === "string" && opts.host.trim() ? opts.host.trim() : DEFAULT_HOST;
  const spawnFn = opts._spawn || spawn;
  try {
    const modeInfo = detectMode(rootDir);
    const existing = readStatus(statusFile);
    if (existing && isActivePhase(existing.phase) && Date.now() - (existing.heartbeat || 0) < STALE_MS) {
      return { started: false, error: "已有更新正在进行中", mode: modeInfo.mode };
    }
    const pkgDir = rootDir || path.join(__dirname, "..");
    // 先行落盘初始状态再启动子进程,避免前几秒轮询读到上一次更新的 done/error 残留。
    writeStatus({
      phase: "running",
      progress: 1,
      mode: modeInfo.mode,
      fromVersion: currentVersion(pkgDir),
      toVersion: null,
      startedAt: new Date().toISOString(),
      error: null,
      port,
      host,
    }, statusFile);

    const script = __filename;
    const child = spawnFn(
      process.execPath,
      [script, "--run", "--port", String(port), "--host", host],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true, // 不弹命令行窗口
        cwd: modeInfo.repoDir || undefined,
        env: process.env,
      }
    );
    if (child && typeof child.unref === "function") child.unref();
    appendLog(`spawned updater (mode=${modeInfo.mode}, port=${port}, host=${host}, pid=${child?.pid ?? "?"})`, logFile);
    return { started: true, mode: modeInfo.mode };
  } catch (err) {
    return { started: false, error: String(err && err.message ? err.message : err) };
  }
}

// ---------------------------------------------------------------------------
// Detached updater (script side, `node self-update.js --run`)
// ---------------------------------------------------------------------------

/** 子进程环境:把当前 node 目录并到 PATH 最前——脱离进程(计划任务拉起)
 *  的 PATH 不保证含 npm;git/git-bash 也在系统 PATH 中,合并无害。*/
function childEnv() {
  const nodeDir = path.dirname(process.execPath);
  return { ...process.env, PATH: `${nodeDir}${path.delimiter}${process.env.PATH || ""}` };
}

function sh(cmd, args, opts = {}) {
  const { env, useCmdOnWin, ...rest } = opts;
  let actualCmd = cmd;
  let actualArgs = args;
  // Windows 下经 cmd.exe /d /c 启动 npm.cmd,避免 shell:true 触发 Node DEP0190 警告。
  if (process.platform === "win32" && (useCmdOnWin || cmd === "npm")) {
    actualCmd = process.env.ComSpec || "cmd.exe";
    actualArgs = ["/d", "/c", cmd, ...args];
  }
  try {
    return execFileSync(actualCmd, actualArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      windowsHide: true,
      timeout: 10 * 60_000,
      ...rest,
      env: env || process.env,
    });
  } catch (err) {
    const tail = String(err.stderr || err.stdout || "").trim().slice(-280);
    if (tail) appendLog(`${cmd} stderr: ${tail.replace(/\s+/g, " ")}`);
    const detail = tail ? `${err.message} (${tail.split(/\r?\n/).pop()})` : err.message;
    throw new Error(detail);
  }
}

function execText(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
    ...opts,
  });
}

function hasScheduledTask(task) {
  try {
    execFileSync("schtasks", ["/query", "/tn", task], { stdio: "ignore", timeout: 10_000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function hasSystemdUnit(unit) {
  try {
    const out = execText("systemctl", ["--user", "list-unit-files", unit, "--no-legend"], { timeout: 10_000 });
    return out.includes(unit);
  } catch {
    return false;
  }
}

function findListenersOnPort(port) {
  const pids = new Set();
  const targetPort = Number(port) || DEFAULT_PORT;
  if (process.platform === "win32") {
    try {
      const out = execText("netstat", ["-ano"]);
      const portRe = new RegExp(`:${targetPort}\\s+.*LISTENING\\s+(\\d+)\\s*$`);
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(portRe);
        if (m && m[1] !== String(process.pid)) pids.add(m[1]);
      }
    } catch {
      /* netstat unavailable */
    }
    return [...pids];
  }
  try {
    const out = execText("lsof", ["-nP", `-iTCP:${targetPort}`, "-sTCP:LISTEN", "-t"]);
    for (const line of out.split(/\r?\n/)) {
      const pid = line.trim();
      if (/^\d+$/.test(pid) && pid !== String(process.pid)) pids.add(pid);
    }
  } catch {
    /* lsof optional */
  }
  return [...pids];
}

function stopServices({ port = DEFAULT_PORT } = {}) {
  const isWin = process.platform === "win32";
  appendLog(`stopping services (port=${port})`);
  if (isWin) {
    for (const pid of findListenersOnPort(port)) {
      try {
        execFileSync("taskkill", ["/F", "/PID", pid], { stdio: "ignore", timeout: 15_000, windowsHide: true });
        appendLog(`stopped web listener pid ${pid}`);
      } catch {
        /* already gone */
      }
    }
    for (const task of ["doramonitor-web", "doramonitor-daemon"]) {
      try {
        execFileSync("schtasks", ["/end", "/tn", task], { stdio: "ignore", timeout: 15_000, windowsHide: true });
      } catch {
        /* task not running */
      }
    }
    try {
      const daemonPid = Number.parseInt(fs.readFileSync(path.join(HOME_DIR, "daemon.pid"), "utf8").trim(), 10);
      if (Number.isFinite(daemonPid) && daemonPid > 0 && daemonPid !== process.pid) {
        try {
          execFileSync("taskkill", ["/F", "/PID", String(daemonPid)], { stdio: "ignore", timeout: 15_000, windowsHide: true });
        } catch {
          /* already gone */
        }
      }
    } catch {
      /* no pid file */
    }
  } else {
    let managedBySystemd = false;
    if (hasSystemdUnit("doramonitor-web.service") || hasSystemdUnit("doramonitor-daemon.service")) {
      try {
        sh("systemctl", ["--user", "stop", "doramonitor-web.service", "doramonitor-daemon.service"]);
        managedBySystemd = true;
      } catch {
        appendLog("systemctl stop skipped");
      }
    }
    if (!managedBySystemd) {
      try {
        const daemonPid = Number.parseInt(fs.readFileSync(path.join(HOME_DIR, "daemon.pid"), "utf8").trim(), 10);
        if (Number.isFinite(daemonPid) && daemonPid > 0 && daemonPid !== process.pid) {
          process.kill(daemonPid, "SIGTERM");
        }
      } catch {
        /* no running daemon */
      }
      for (const pidStr of findListenersOnPort(port)) {
        const pid = Number.parseInt(pidStr, 10);
        if (!Number.isFinite(pid) || pid <= 0) continue;
        try {
          // 仅终止确实是本项目的 Node 进程,绝不误杀端口上的其他应用。
          const cmd = fs.existsSync(`/proc/${pid}/cmdline`)
            ? fs.readFileSync(`/proc/${pid}/cmdline`, "utf8")
            : execText("ps", ["-p", String(pid), "-o", "args="]);
          if (/server\.js|doramonitor|ai-usage/.test(cmd)) {
            process.kill(pid, "SIGTERM");
            appendLog(`stopped web listener pid ${pid}`);
          }
        } catch {
          /* already gone */
        }
      }
    }
  }
}

function startViaCli({ port = DEFAULT_PORT, host = DEFAULT_HOST, rootDir } = {}) {
  const pkgDir = rootDir || path.join(__dirname, "..");
  const cli = path.join(pkgDir, "src", "doramonitor.js");
  const env = childEnv();
  try {
    sh(process.execPath, [cli, "daemon", "--background"], { env, timeout: 20_000 });
  } catch (err) {
    appendLog(`fallback daemon start failed: ${err.message}`);
  }
  try {
    sh(process.execPath, [cli, "web", "--background", "--no-open", "--host", host, "--port", String(port)], { env, timeout: 20_000 });
  } catch (err) {
    appendLog(`fallback web start failed: ${err.message}`);
  }
}

function startServices({ port = DEFAULT_PORT, host = DEFAULT_HOST, rootDir } = {}) {
  const isWin = process.platform === "win32";
  appendLog(`starting services (port=${port}, host=${host})`);
  if (isWin) {
    let webStarted = false;
    if (hasScheduledTask("doramonitor-daemon")) {
      try {
        sh("schtasks", ["/run", "/tn", "doramonitor-daemon"], { timeout: 15_000 });
      } catch (err) {
        appendLog(`schtasks /run doramonitor-daemon failed: ${err.message}`);
      }
    }
    if (hasScheduledTask("doramonitor-web")) {
      try {
        sh("schtasks", ["/run", "/tn", "doramonitor-web"], { timeout: 15_000 });
        webStarted = true;
      } catch (err) {
        appendLog(`schtasks /run doramonitor-web failed: ${err.message}`);
      }
    }
    if (!webStarted) {
      startViaCli({ port, host, rootDir });
    }
  } else {
    let restarted = false;
    if (hasSystemdUnit("doramonitor-web.service") || hasSystemdUnit("doramonitor-daemon.service")) {
      try {
        sh("systemctl", ["--user", "restart", "doramonitor-daemon.service", "doramonitor-web.service"]);
        restarted = true;
      } catch (err) {
        appendLog(`systemctl restart failed: ${err.message}`);
      }
    }
    if (!restarted) {
      startViaCli({ port, host, rootDir });
    }
  }
}

/** Resolve current branch and tracking upstream without hardcoding `origin/main`. */
function resolveGitUpstream(repoDir, runGit = (args) => execText("git", args, { cwd: repoDir })) {
  let branch = "";
  try {
    branch = String(runGit(["symbolic-ref", "--short", "-q", "HEAD"]) || "").trim();
  } catch {
    branch = "";
  }
  if (!branch) {
    throw new Error("当前处于游离 HEAD 状态,已中止更新(请先切回主分支)");
  }
  try {
    const tracked = String(runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]) || "").trim();
    const slash = tracked.indexOf("/");
    if (slash > 0 && slash < tracked.length - 1) {
      return {
        branch,
        upstream: tracked,
        remote: tracked.slice(0, slash),
        remoteBranch: tracked.slice(slash + 1),
      };
    }
  } catch {
    /* no configured upstream */
  }
  if (branch === "main" || branch === "master") {
    return { branch, upstream: `origin/${branch}`, remote: "origin", remoteBranch: branch };
  }
  throw new Error(`当前分支 ${branch} 未配置跟踪上游,已中止更新`);
}

/**
 * Non-destructive pre-flight for source mode BEFORE stopping services:
 * dirty tree, detached HEAD, offline fetch, or diverged tree abort without
 * interrupting the running dashboard.
 */
function preflightSourceUpdate(repoDir, runGit = (args) => execText("git", args, { cwd: repoDir })) {
  let porcelain = "";
  try {
    porcelain = String(runGit(["status", "--porcelain", "--untracked-files=no"]) || "");
  } catch (err) {
    throw new Error(`git status 失败:${err.message}`);
  }
  if (porcelain.trim()) {
    throw new Error("本地有未提交修改,已中止更新(请先提交或暂存)");
  }
  const target = resolveGitUpstream(repoDir, runGit);
  runGit(["fetch", target.remote, target.remoteBranch]);

  let canFastForward = true;
  try {
    runGit(["merge-base", "--is-ancestor", "HEAD", target.upstream]);
  } catch {
    canFastForward = false;
  }
  let needsHardReset = false;
  if (!canFastForward) {
    let diff = "";
    try {
      diff = String(runGit(["diff", "--stat", "HEAD", target.upstream]) || "");
    } catch (err) {
      throw new Error(`git diff 失败:${err.message}`);
    }
    if (diff.trim()) {
      throw new Error(`本地分支与 ${target.upstream} 存在实际代码差异,已中止更新(请手动处理)`);
    }
    needsHardReset = true;
  }
  return { ...target, needsHardReset };
}

async function waitHealthy({ port = DEFAULT_PORT, host = DEFAULT_HOST, timeoutMs = 60_000 } = {}) {
  const healthUrl = `http://${resolveHealthHost(host)}:${port}/api/health`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

async function run() {
  const { port, host } = parseRunArgs();
  const { mode, repoDir } = detectMode();
  const pkgRoot = repoDir || path.join(__dirname, "..");
  const fromVersion = currentVersion(pkgRoot);
  const status = {
    phase: "running",
    progress: 5,
    mode,
    fromVersion,
    toVersion: null,
    startedAt: new Date().toISOString(),
    error: null,
    port,
    host,
  };
  writeStatus(status);
  appendLog(`update started (mode=${mode}, from=${fromVersion}, port=${port}, host=${host})`);
  let servicesStopped = false;
  try {
    let sourcePlan = null;
    if (mode === "source") {
      status.phase = "fetching";
      status.progress = 15;
      writeStatus(status);
      appendLog("git preflight + fetch");
      sourcePlan = preflightSourceUpdate(repoDir, (args) => sh("git", args, { cwd: repoDir }));
    }

    stopServices({ port });
    servicesStopped = true;
    status.progress = 30;
    writeStatus(status);

    let updatedPkgRoot = pkgRoot;
    if (mode === "source") {
      const git = (args) => sh("git", args, { cwd: repoDir });
      if (sourcePlan.needsHardReset) {
        appendLog(`diverged but identical tree → moving HEAD to ${sourcePlan.upstream}`);
        git(["reset", "--hard", sourcePlan.upstream]);
      } else {
        git(["merge", "--ff-only", sourcePlan.upstream]);
      }
      status.phase = "installing";
      status.progress = 55;
      writeStatus(status);
      appendLog("npm install");
      sh("npm", ["install", "--no-audit", "--no-fund"], { cwd: repoDir, timeout: 15 * 60_000, env: childEnv() });
      status.phase = "building";
      status.progress = 75;
      writeStatus(status);
      appendLog("npm run build");
      sh("npm", ["run", "build"], { cwd: repoDir, timeout: 10 * 60_000, env: childEnv() });
    } else {
      status.phase = "installing";
      status.progress = 50;
      writeStatus(status);
      const prefix = npmPrefixForPackage(pkgRoot);
      const npmArgs = prefix
        ? ["install", "-g", "--prefix", prefix, "doramonitor@latest", "--no-audit", "--no-fund"]
        : ["install", "-g", "doramonitor@latest", "--no-audit", "--no-fund"];
      appendLog(`npm ${npmArgs.join(" ")}`);
      sh("npm", npmArgs, { timeout: 15 * 60_000, env: childEnv() });
      if (prefix) {
        updatedPkgRoot = process.platform === "win32"
          ? path.join(prefix, "node_modules", "doramonitor")
          : path.join(prefix, "lib", "node_modules", "doramonitor");
      }
    }

    status.phase = "restarting";
    status.progress = 90;
    status.toVersion = currentVersion(updatedPkgRoot);
    writeStatus(status);
    startServices({ port, host, rootDir: updatedPkgRoot });

    appendLog(`waiting for health (${resolveHealthHost(host)}:${port})`);
    const healthy = await waitHealthy({ port, host });
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
    // 若已停过服务则尽力拉起,避免看板停摆;预检阶段失败时服务未停,无需重拉。
    if (servicesStopped) {
      try {
        startServices({ port, host, rootDir: pkgRoot });
      } catch {
        /* ignore */
      }
    }
  }
}

module.exports = {
  currentVersion,
  readVersionFromDisk,
  detectMode,
  npmPrefixForPackage,
  parseRunArgs,
  resolveHealthHost,
  resolveGitUpstream,
  preflightSourceUpdate,
  isActivePhase,
  ACTIVE_PHASES,
  spawnApply,
  readStatus,
  writeStatus,
  STATUS_FILE,
  LOG_FILE,
  STALE_MS,
};

if (require.main === module) {
  if (process.argv.includes("--run")) {
    run();
  } else {
    console.log(JSON.stringify(readStatus()));
  }
}
