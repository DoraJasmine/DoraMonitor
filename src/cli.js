#!/usr/bin/env node
"use strict";

/**
 * Status line CLI — one compact line for shell prompts and tmux/psmux bars.
 *
 * Examples:
 *   node src/cli.js                          # plain text, all tools
 *   node src/cli.js --style tmux             # tmux #{...} color styles
 *   node src/cli.js --tool kimi-code         # single tool
 *
 * Daemon mode rewrites a cache file every interval so tmux can read it with
 * zero rendering lag:
 *   node src/cli.js daemon --interval 30
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { collect } = require("./collect");
const { toolMeta } = require("./tools/base");
const { daemonPidFile, processIsRunning } = require("./daemon-liveness");
const { loadSettings, toDisplay } = require("./settings");

const DEFAULT_STATUS_FILE = path.join(".doramonitor", "status.cache");

function parseArgs(argv) {
  const opts = {
    tool: "all",
    style: "plain", // plain | tmux
    planPrice: null,
    currencySymbol: null,
    range: "month",
    interval: 30,
    statusFile: null,
    help: false,
    mode: "once",
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "daemon") opts.mode = "daemon";
    else if (a === "--tool") opts.tool = argv[++i];
    else if (a === "--style") opts.style = argv[++i];
    else if (a === "--local") opts.local = true;
    else if (a === "--plan-price") opts.planPrice = Number(argv[++i]);
    else if (a === "--currency") opts.currencySymbol = argv[++i];
    else if (a === "--range") opts.range = argv[++i];
    else if (a === "--interval") opts.interval = Math.max(5, Number(argv[++i]) || 30);
    else if (a === "--status-file") opts.statusFile = argv[++i];
    else if (a === "--help" || a === "-h") opts.help = true;
  }
  return opts;
}

/**
 * Optional plan price for the leverage metric, read from a kimi-status-style
 * config when present (~/.kimi-code/kimi-status.toml): plan_price, currency.
 */
function loadPlanConfig() {
  try {
    const p = path.join(os.homedir(), ".kimi-code", "kimi-status.toml");
    if (!fs.existsSync(p)) return {};
    const text = fs.readFileSync(p, "utf8");
    const pick = (key) => {
      const m = text.match(new RegExp(`^\\s*${key}\\s*=\\s*"?([^"\\n#]+)"?`, "m"));
      return m ? m[1].trim() : null;
    };
    const price = Number(pick("plan_price"));
    const symbol = pick("currency_symbol");
    return {
      planPrice: Number.isFinite(price) && price > 0 ? price : null,
      currencySymbol: symbol || null,
    };
  } catch {
    return {};
  }
}

function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return String(Math.round(v));
}

/** Range start in ms. month = current calendar month. */
function rangeStart(range, now = new Date()) {
  if (range === "all") return 0;
  if (range === "today") {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  if (range === "month") {
    const d = new Date(now.getFullYear(), now.getMonth(), 1);
    return d.getTime();
  }
  const days = range === "7d" ? 7 : 30;
  return now.getTime() - days * 24 * 3600 * 1000;
}

/** Aggregated per-tool totals since rangeStart. */
function toolTotals(records, range) {
  const start = rangeStart(range);
  const byTool = new Map();
  for (const r of records) {
    if (start && (!r.time || r.time < start)) continue;
    const id = r.tool || "unknown";
    if (!byTool.has(id)) {
      byTool.set(id, { tokens: 0, requests: 0, costCny: 0, credits: 0, cacheRead: 0, input: 0 });
    }
    const t = byTool.get(id);
    t.tokens += r.inputOther + r.output + r.inputCacheRead + r.inputCacheCreation;
    t.requests += 1;
    t.costCny += r.costCny || 0;
    t.credits += r.credits || 0;
    t.cacheRead += r.inputCacheRead;
    t.input += r.inputOther + r.inputCacheRead + r.inputCacheCreation;
  }
  return byTool;
}

const SHORT_LABEL = {
  "kimi-code": "K",
  zcode: "Z",
  "qoder-cn": "Q",
  "qoder-cn-cli": "QC",
  "claude-code": "CC",
  dsh: "dsh",
};

function renderLine(totals, opts) {
  const parts = [];
  let kimiCost = 0;
  let input = 0;
  let cacheRead = 0;

  for (const [id, t] of totals) {
    if (id === "kimi-code") {
      kimiCost = t.costCny;
      input = t.input;
      cacheRead = t.cacheRead;
    }
    const label = SHORT_LABEL[id] || id;
    const bits = [];
    if (t.tokens > 0) bits.push(fmtTokens(t.tokens));
    if (t.costCny > 0) bits.push(`${opts.currencySymbol}${t.costCny.toFixed(2)}`);
    if (t.credits > 0) bits.push(`${t.credits.toFixed(0)}cr`);
    if (!bits.length) continue;
    parts.push(`${label}:${bits.join(" ")}`);
  }

  let line = parts.join(" | ") || "no data";

  // Leverage — kimi only, when a plan price is configured.
  if (opts.planPrice && kimiCost > 0) {
    const leverage = (kimiCost / opts.planPrice).toFixed(2) + "x";
    line += ` (${leverage})`;
  }
  if (input > 0) {
    line += ` 命中:${((cacheRead / input) * 100).toFixed(1)}%`;
  }

  if (opts.style === "tmux") {
    const ratio = opts.planPrice && kimiCost > 0 ? kimiCost / opts.planPrice : 0;
    let fg = "green";
    if (ratio >= 1) fg = "red";
    else if (ratio >= 0.7) fg = "colour208";
    else if (ratio >= 0.3) fg = "yellow";
    return `#[fg=${fg}]${line}#[default]`;
  }
  return line;
}

function renderOnce(opts) {
  const plan = loadPlanConfig();
  const settings = loadSettings();
  // Precedence: CLI flag > settings > kimi-status.toml > default
  const currencySymbol =
    opts.currencySymbol || settings.currencySymbol || plan.currencySymbol || "$";
  const planPrice = opts.planPrice ?? plan.planPrice ?? null;
  const { records } = collect();
  // Sync enabled → the status line shows the merged view like the dashboard.
  // --local opts out; peers come from the on-disk cache (never blocks).
  let allRecords = records;
  if (settings.sync && settings.sync.enabled && !opts.local) {
    const { peerRecordsCached } = require("./sync");
    allRecords = [...records, ...peerRecordsCached()];
  }
  const totals = toolTotals(allRecords, opts.range);
  // Costs are computed in CNY internally; convert once for display/leverage.
  for (const t of totals.values()) {
    t.costCny = toDisplay(t.costCny, settings);
  }
  const effOpts = { ...opts, planPrice, currencySymbol };
  if (opts.tool !== "all") {
    const only = totals.get(opts.tool);
    return renderLine(only ? [[opts.tool, only]] : [], effOpts);
  }
  return renderLine(totals, effOpts);
}

function atomicWrite(target, content) {
  const { mkdirSync, writeFileSync, renameSync } = fs;
  mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, target);
}

function runDaemon(opts) {
  const pf = daemonPidFile();
  // Single-instance guard: a stale pid file (dead process) is replaced.
  if (fs.existsSync(pf)) {
    const prev = parseInt(fs.readFileSync(pf, "utf8").trim(), 10);
    if (processIsRunning(prev) && prev !== process.pid) {
      console.log(`DoraMonitor daemon 已在运行 (pid ${prev})`);
      process.exit(0);
    }
  }

  const target = opts.statusFile
    ? path.resolve(opts.statusFile)
    : path.join(os.homedir(), DEFAULT_STATUS_FILE);

  const tick = () => {
    try {
      const line = renderOnce(opts);
      atomicWrite(target, line + "\n");
    } catch {
      // never crash the daemon; tmux keeps the previous cache line
    }
  };

  fs.mkdirSync(path.dirname(pf), { recursive: true });
  fs.writeFileSync(pf, String(process.pid), "utf8");
  const stopQuotaSampler = require("./quota-sampler").startQuotaSampler(null);
  const heartbeat = setInterval(() => {
    try {
      const now = new Date();
      fs.utimesSync(pf, now, now);
    } catch {
      // The next heartbeat retries; Web eventually resumes if the daemon is gone.
    }
  }, 15_000);
  heartbeat.unref();
  const cleanup = () => {
    clearInterval(heartbeat);
    stopQuotaSampler();
    try {
      if (fs.readFileSync(pf, "utf8").trim() === String(process.pid)) {
        fs.unlinkSync(pf);
      }
    } catch {
      // pid file already gone
    }
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  tick();

  // Periodic cross-device sync (non-blocking; failures never break status).
  const { loadSettings } = require("./settings");
  let lastSync = 0;
  let lastBridgeRun = 0;
  const maybeSync = () => {
    const syncCfg = loadSettings().sync || {};
    const syncEvery = Math.max(60, Number(syncCfg.syncInterval) || 300) * 1000;
    if (!syncCfg.enabled) return;
    if (Date.now() - lastSync < syncEvery) return;
    lastSync = Date.now();
    // Async chain off the hot path; failures never break status rendering.
    Promise.resolve()
      .then(() => {
        const { collect } = require("./collect");
        const { runSync: run } = require("./sync");
        // No force: with short sync intervals the stamp probe keeps unchanged
        // tools on their caches, so a 60s cadence stays cheap while the
        // summary is still built from the full cached records.
        return Promise.all([
          Promise.resolve(collect()),
          Promise.resolve(loadSettings()),
          Promise.resolve(run),
        ]);
      })
      .then(([collected, settings, run]) => run(
        collected.records,
        settings,
        collected.byTool.get("codex")?.quota
      ))
      .then((syncResult) => {
        // Bridge the freshly pulled multi-device usage into CC Switch when
        // enabled. Auto-pauses on ccs-ssh-sync conflicts (visible in status).
        try {
          const ccCfg = loadSettings().ccSwitch || {};
          if (ccCfg.enabled) {
            lastBridgeRun = Date.now(); // the post-sync write resets the timer
            const { runBridge } = require("./ccswitch-bridge");
            runBridge();
          }
        } catch (e) {
          console.error(`ccswitch 桥接失败: ${e && e.message ? e.message : e}`);
        }
        return syncResult;
      })
      .catch((e) => {
        // sync must never break status rendering; log for journalctl
        console.error(`sync 失败: ${e && e.message ? e.message : e}`);
      });
  };
  maybeSync();
  setInterval(maybeSync, 60_000);

  // CC Switch bridge: its own cadence (ccSwitch.interval, default 60s) so a
  // write never has to wait for the next multi-device sync round. The
  // post-sync hook above refreshes lastBridgeRun, so a sync-round write and
  // the timer never double-write (runBridge is idempotent anyway).
  const maybeBridge = () => {
    try {
      const ccCfg = loadSettings().ccSwitch || {};
      if (!ccCfg.enabled) return;
      const every = Math.max(30, Number(ccCfg.interval) || 60) * 1000;
      if (Date.now() - lastBridgeRun < every) return;
      lastBridgeRun = Date.now();
      const { runBridge } = require("./ccswitch-bridge");
      runBridge();
    } catch (e) {
      console.error(`ccswitch 桥接失败: ${e && e.message ? e.message : e}`);
    }
  };
  setInterval(maybeBridge, 30_000);

  // Local usage scan cadence (scan.interval, default 30s): a 5s scheduler
  // re-reads the setting each beat, so changes on the settings page apply
  // without a daemon restart. The collect call itself is incremental
  // (stamp probe + 15s TTL cache), so short intervals stay cheap.
  let lastTickAt = Date.now();
  setInterval(() => {
    let scanEvery = 30;
    try {
      scanEvery = Math.max(10, Number(loadSettings().scan && loadSettings().scan.interval) || 30);
    } catch {
      /* keep default cadence when settings are unreadable */
    }
    if (Date.now() - lastTickAt >= scanEvery * 1000) {
      lastTickAt = Date.now();
      tick();
    }
  }, 5000);
  console.log(`DoraMonitor daemon: pid ${process.pid}，每 ${opts.interval}s 写入 ${target}；每 60s 采样额度并检查同步设置`);
}

/** Stop a running daemon via its pid file. Returns exit code. */
function stopDaemon() {
  const pf = daemonPidFile();
  if (!fs.existsSync(pf)) {
    console.log("DoraMonitor daemon 未运行");
    return 0;
  }
  const pid = parseInt(fs.readFileSync(pf, "utf8").trim(), 10);
  if (!processIsRunning(pid)) {
    fs.unlinkSync(pf);
    console.log("DoraMonitor daemon 进程已不存在，清理 PID 文件");
    return 0;
  }
  try {
    process.kill(pid, "SIGTERM");
    console.log(`DoraMonitor daemon 已停止 (pid ${pid})`);
  } catch (err) {
    console.error(`停止失败: ${err.message}`);
    return 1;
  }
  try {
    fs.unlinkSync(pf);
  } catch {
    // cleaned up by the daemon itself
  }
  return 0;
}

function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    console.log(`DoraMonitor status line

Usage:
  node src/cli.js [options]              render once to stdout
  node src/cli.js daemon [options]       daemon: write cache file on interval

Options:
  --tool <id|all>       filter tool (default: all)
  --range <range>       today | 7d | 30d | month | all (default: month)
  --style <s>           plain | tmux (default: plain)
  --plan-price <n>      plan price for kimi leverage (default: from kimi-status.toml)
  --currency <sym>      currency symbol (default: from kimi-status.toml or $)
  --interval <sec>      daemon interval (default: 30)
  --status-file <path>  daemon cache file (default: ~/.doramonitor/status.cache)`);
    process.exit(0);
  }
  if (opts.mode === "daemon") {
    runDaemon(opts);
    return;
  }
  process.stdout.write(renderOnce(opts) + "\n");
}

if (require.main === module) {
  main();
}

module.exports = { renderOnce, toolTotals, rangeStart, parseArgs, runDaemon, stopDaemon };
