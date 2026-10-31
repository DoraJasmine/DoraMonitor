#!/usr/bin/env node
"use strict";

/**
 * doramonitor — unified command line entry.
 *
 *   doramonitor                 start the web dashboard (default)
 *   doramonitor web [options]   same, with explicit options
 *   doramonitor status [opts]   one-line usage summary (for shell prompt)
 *   doramonitor daemon [opts]   background daemon writing a tmux cache file
 *   doramonitor stop            stop the daemon
 *   doramonitor tools           list detected tools and data sources
 *
 * Status/daemon options: --tool <id|all> --range <today|7d|30d|month|all>
 *   --style <plain|tmux> --plan-price <n> --currency <sym> --interval <sec>
 *   --status-file <path>
 * Web options: --port <n> --host <addr> --no-open
 */

const pkg = require("../package.json");

function printHelp() {
  console.log(`doramonitor v${pkg.version} — AI coding tools usage monitor

Usage:
  doramonitor [web] [options]     启动 Web 仪表盘（默认命令）
  doramonitor status [options]    输出单行用量状态
  doramonitor daemon [options]    后台守护进程，定时写状态缓存
  doramonitor stop                停止后台守护进程
  doramonitor sync                上传本机用量并拉取其他设备
  doramonitor tools               列出检测到的工具与数据源
  doramonitor -v | --version      显示版本
  doramonitor -h | --help         显示本帮助

Web options:
  --port <n>       监听端口 (默认 3847)
  --host <addr>    监听地址 (默认 127.0.0.1)
  --no-open        不自动打开浏览器

Status / daemon options:
  --tool <id|all>      过滤工具: kimi-code | zcode | qoder-cn | qoder-cn-cli | codex | claude-code | dsh | all
  --range <range>      today | 7d | 30d | month | all (默认 month)
  --style <s>          plain | tmux
  --plan-price <n>     套餐价格（杠杆计算；默认读 ~/.kimi-code/kimi-status.toml）
  --currency <sym>     货币符号（默认读全局设置）
  --interval <sec>     daemon 刷新间隔 (默认 30)
  --status-file <path> daemon 缓存文件 (默认 ~/.doramonitor/status.cache)

Privacy: 只读取模型名、时间与 token 计数；不读取提示词、代码与凭据。`);
}

function parseSub(argv) {
  const known = new Set(["web", "status", "daemon", "stop", "tools", "sync"]);
  for (const a of argv) {
    if (a === "-h" || a === "--help") return { sub: "help", rest: argv };
    if (a === "-v" || a === "--version") return { sub: "version", rest: argv };
    if (!a.startsWith("-")) {
      return known.has(a)
        ? { sub: a, rest: argv.filter((x) => x !== a) }
        : { sub: "web", rest: argv };
    }
  }
  return { sub: "web", rest: argv };
}

function openBrowser(url) {
  const { exec } = require("child_process");
  const cmd =
    process.platform === "win32"
      ? `start "" "${url}"`
      : process.platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

function cmdWeb(rest) {
  const opts = { port: 3847, host: "127.0.0.1", open: true, background: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--port" || a === "-p") opts.port = Number(rest[++i]) || opts.port;
    else if (a === "--host") opts.host = rest[++i] || opts.host;
    else if (a === "--no-open") opts.open = false;
    else if (a === "--background" || a === "-d") opts.background = true;
  }
  if (opts.background) {
    detachWebServer(opts);
    return;
  }
  const { createServer, urlHost } = require("./server");
  const { listTools } = require("./tools");
  const server = createServer(null, opts.host);
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`端口 ${opts.port} 已被占用（可能已在运行）。换端口: doramonitor web --port 3848`);
      process.exit(1);
    }
    throw err;
  });
  server.listen(opts.port, opts.host, () => {
    const url = `http://${urlHost(opts.host)}:${opts.port}/`;
    console.log(`DoraMonitor v${pkg.version}`);
    console.log(`  URL:   ${url}`);
    const tools = listTools()
      .map((t) => `${t.label}${t.available ? "" : "(未检测到)"}`)
      .join(", ");
    console.log(`  Tools: ${tools}`);
    console.log(`  Ctrl+C 退出`);
    if (opts.open) openBrowser(url);
  });
}

/**
 * Start the web server detached from this terminal, with NO console window.
 *
 * Windows: hand off to wscript.exe running a tiny VBScript, which is the only
 * way to launch a node process with no visible console — `start /min` still
 * flashes a window and dies with the parent terminal. The VBScript is written
 * to a temp file per launch so it never lands in the repo.
 *
 * POSIX: plain detached spawn with stdio ignored.
 *
 * The parent returns immediately after confirming the port accepts
 * connections, so `doramonitor web -d` behaves like a real service start.
 */
async function detachWebServer(opts) {
  const path = require("path");
  const serverJs = path.join(__dirname, "server.js");
  const argv = [
    serverJs,
    "--host",
    opts.host,
    "--port",
    String(opts.port),
    "--no-open",
  ];

  const already = await isDoraMonitorHealthy(opts.host, opts.port);
  if (already) {
    console.log(`DoraMonitor 已在 http://${urlHostLocal(opts.host)}:${opts.port}/ 运行`);
    return;
  }

  launchDetached(argv);

  waitForHealth(opts.host, opts.port, 12_000, (ok) => {
    const url = `http://${urlHostLocal(opts.host)}:${opts.port}/`;
    if (ok) {
      console.log(`DoraMonitor v${pkg.version} 已在后台启动`);
      console.log(`  URL: ${url}`);
      if (opts.open) openBrowser(url);
    } else {
      console.error(`后台启动失败：${url} 没有响应（查看日志或换端口重试）`);
      process.exitCode = 1;
    }
  });
}

/**
 * Spawn the server with no console window and no parent tie.
 * Windows needs wscript.exe: `start /min` still flashes a console and the
 * child dies with the terminal.
 */
function launchDetached(argv) {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const { spawn } = require("child_process");

  if (process.platform === "win32") {
    const vbs = path.join(os.tmpdir(), `doramonitor-web-${process.pid}-${Date.now()}.vbs`);
    // Build exactly the command line wscript should run:
    //   "C:\Program Files\nodejs\node.exe" "D:\...\server.js" --host 127.0.0.1 --port 3847 --no-open
    // Inside a VBScript string literal every embedded quote doubles.
    const cmdline = [`"${process.execPath}"`, `"${argv[0]}"`, ...argv.slice(1)].join(" ");
    const literal = cmdline.replace(/"/g, '""');
    fs.writeFileSync(
      vbs,
      `CreateObject("Wscript.Shell").Run "${literal}", 0, False\r\n`,
      "ascii"
    );
    const wscript = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "wscript.exe");
    spawn(wscript, [vbs], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    setTimeout(() => fs.unlink(vbs, () => {}), 5000).unref();
    return;
  }
  const child = spawn(process.execPath, argv, { detached: true, stdio: "ignore" });
  child.unref();
}

/** Address a human can click (wildcard binds are not valid URL hosts). */
function urlHostLocal(host) {
  if (!host || host === "::" || host === "0.0.0.0") return "127.0.0.1";
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function isDoraMonitorHealthy(host, port) {
  const target = !host || host === "::" || host === "0.0.0.0" ? "127.0.0.1" : host;
  return new Promise((resolve) => {
    const req = require("http").get({ host: target, port, path: "/api/health", timeout: 1000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        if (body.length < 1024) body += chunk;
      });
      res.on("end", () => {
        try {
          resolve(res.statusCode === 200 && JSON.parse(body).ok === true);
        } catch {
          resolve(false);
        }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
  });
}

function waitForHealth(host, port, timeoutMs, done) {
  const started = Date.now();
  const attempt = () => {
    isDoraMonitorHealthy(host, port).then((ok) => {
      if (ok) return done(true);
      if (Date.now() - started >= timeoutMs) return done(false);
      setTimeout(attempt, 250);
    });
  };
  attempt();
}

function cmdStatus(rest) {
  const cli = require("./cli");
  const opts = cli.parseArgs(rest);
  process.stdout.write(cli.renderOnce(opts) + "\n");
}

function cmdDaemon(rest) {
  const cli = require("./cli");
  cli.runDaemon(cli.parseArgs(rest));
}

async function cmdSync() {
  const { collect } = require("./collect");
  const { runSync, syncEnabled } = require("./sync");
  const { loadSettings } = require("./settings");
  const settings = loadSettings();
  if (!syncEnabled(settings)) {
    console.log("同步未启用。在 ~/.doramonitor/config.json 中配置 sync 段后重试。");
    process.exit(1);
  }
  const collected = collect({ force: true });
  console.log("同步中…");
  const r = await runSync(collected.records, settings, collected.byTool.get("codex")?.quota);
  if (r.uploaded) console.log("  本机用量已上传");
  else console.log(`  上传失败: ${r.uploadError || "未知错误"}`);
  if (r.downloaded) console.log(`  已拉取 ${r.peers.length} 台设备`);
  else if (r.fromCache) console.log(`  在线拉取失败，使用缓存 ${r.peers.length} 台设备`);
  for (const p of r.peers) {
    const days = Object.keys(p.days || {}).length;
    console.log(`  · ${p.device}（${days} 天数据）`);
  }
}

function cmdTools() {
  const { listTools } = require("./tools");
  const rows = listTools();
  if (!rows.length) {
    console.log("未注册任何工具");
    return;
  }
  const width = Math.max(...rows.map((r) => r.label.length)) + 2;
  for (const r of rows) {
    const state = r.available ? "ok" : "未检测到";
    const note = r.creditsOnly ? "（仅 credits 计费）" : "";
    console.log(`${r.label.padEnd(width)} ${state.padEnd(10)} ${r.id}${note}`);
    console.log(`${" ".repeat(width)} 数据: ${r.home || "—"}`);
  }
}

function main() {
  const argv = process.argv.slice(2);
  const { sub, rest } = parseSub(argv);
  switch (sub) {
    case "help":
      printHelp();
      break;
    case "version":
      console.log(`doramonitor v${pkg.version}`);
      break;
    case "web":
      cmdWeb(rest);
      break;
    case "status":
      cmdStatus(rest);
      break;
    case "daemon":
      cmdDaemon(rest);
      break;
    case "stop":
      process.exit(require("./cli").stopDaemon());
      break;
    case "tools":
      cmdTools();
      break;
    case "sync":
      cmdSync();
      break;
    default:
      printHelp();
      process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { isDoraMonitorHealthy };
