#!/usr/bin/env node
"use strict";

/**
 * ai-usage — unified command line entry.
 *
 *   ai-usage                 start the web dashboard (default)
 *   ai-usage web [options]   same, with explicit options
 *   ai-usage status [opts]   one-line usage summary (for shell prompt)
 *   ai-usage daemon [opts]   background daemon writing a tmux cache file
 *   ai-usage stop            stop the daemon
 *   ai-usage tools           list detected tools and data sources
 *
 * Status/daemon options: --tool <id|all> --range <today|7d|30d|month|all>
 *   --style <plain|tmux> --plan-price <n> --currency <sym> --interval <sec>
 *   --status-file <path>
 * Web options: --port <n> --host <addr> --no-open
 */

const pkg = require("../package.json");

function printHelp() {
  console.log(`ai-usage v${pkg.version} — AI coding tools usage monitor

Usage:
  ai-usage [web] [options]     启动 Web 仪表盘（默认命令）
  ai-usage status [options]    输出单行用量状态
  ai-usage daemon [options]    后台守护进程，定时写状态缓存
  ai-usage stop                停止后台守护进程
  ai-usage sync                上传本机用量并拉取其他设备
  ai-usage tools               列出检测到的工具与数据源
  ai-usage -v | --version      显示版本
  ai-usage -h | --help         显示本帮助

Web options:
  --port <n>       监听端口 (默认 3847)
  --host <addr>    监听地址 (默认 127.0.0.1)
  --no-open        不自动打开浏览器

Status / daemon options:
  --tool <id|all>      过滤工具: kimi-code | zcode | qoder-cn | qoder-cn-cli | all
  --range <range>      today | 7d | 30d | month | all (默认 month)
  --style <s>          plain | tmux
  --plan-price <n>     套餐价格（杠杆计算；默认读 ~/.kimi-code/kimi-status.toml）
  --currency <sym>     货币符号（默认读全局设置）
  --interval <sec>     daemon 刷新间隔 (默认 30)
  --status-file <path> daemon 缓存文件 (默认 ~/.ai-usage-monitor/status.cache)

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
  const opts = { port: 3847, host: "127.0.0.1", open: true };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--port" || a === "-p") opts.port = Number(rest[++i]) || opts.port;
    else if (a === "--host") opts.host = rest[++i] || opts.host;
    else if (a === "--no-open") opts.open = false;
  }
  const http = require("http");
  const { createServer } = require("./server");
  const { listProviders } = require("./providers");
  const server = createServer(null);
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`端口 ${opts.port} 已被占用（可能已在运行）。换端口: ai-usage web --port 3848`);
      process.exit(1);
    }
    throw err;
  });
  server.listen(opts.port, opts.host, () => {
    const url = `http://${opts.host}:${opts.port}/`;
    console.log(`AI Usage Monitor v${pkg.version}`);
    console.log(`  URL:   ${url}`);
    const tools = listProviders()
      .map((t) => `${t.label}${t.available ? "" : "(未检测到)"}`)
      .join(", ");
    console.log(`  Tools: ${tools}`);
    console.log(`  Ctrl+C 退出`);
    if (opts.open) openBrowser(url);
  });
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
    console.log("同步未启用。在 ~/.ai-usage-monitor/config.json 中配置 sync 段后重试。");
    process.exit(1);
  }
  const { records } = collect({ force: true });
  console.log("同步中…");
  const r = await runSync(records, settings);
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
  const { listProviders } = require("./providers");
  const rows = listProviders();
  if (!rows.length) {
    console.log("未注册任何 provider");
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
      console.log(`ai-usage v${pkg.version}`);
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

main();
