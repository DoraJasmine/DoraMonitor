#!/usr/bin/env node
"use strict";

const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");

function parseArgs(argv) {
  const opts = { install: true, start: false, background: false, host: "127.0.0.1", port: 3847, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--skip-install") opts.install = false;
    else if (arg === "--start") opts.start = true;
    else if (arg === "--background") opts.background = true;
    else if (arg === "--host") opts.host = argv[++i] || "";
    else if (arg === "--port" || arg === "-p") opts.port = Number(argv[++i]);
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (opts.start && opts.background) throw new Error("--start and --background cannot be used together");
  if (!opts.host) throw new Error("--host requires a value");
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) throw new Error("--port must be an integer from 1 to 65535");
  return opts;
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit", windowsHide: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

function runNpm(args) {
  if (process.platform === "win32") {
    const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    if (require("fs").existsSync(npmCli)) return run(process.execPath, [npmCli, ...args]);
    return run(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `npm ${args.join(" ")}`]);
  }
  return run("npm", args);
}

function main(argv) {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 18) throw new Error(`Node.js 18 or newer is required; current version is ${process.version}`);
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(`DoraMonitor source deployment

Usage: npm run deploy -- [options]

  --skip-install       Reuse node_modules instead of running npm ci
  --start              Start in the foreground after building
  --background         Start detached after building
  --host <address>     Listen address (default 127.0.0.1)
  --port, -p <port>    Listen port (default 3847)
  -h, --help           Show this help

The server never opens a browser when started by this script.`);
    return;
  }
  if (opts.install) runNpm(["ci"]);
  runNpm(["run", "build"]);
  if (opts.start) run(process.execPath, [path.join(ROOT, "src", "server.js"), "--host", opts.host, "--port", String(opts.port), "--no-open"]);
  if (opts.background) run(process.execPath, [path.join(ROOT, "src", "doramonitor.js"), "web", "--background", "--host", opts.host, "--port", String(opts.port), "--no-open"]);
  if (!opts.start && !opts.background) console.log("\nDeployment complete. Start with: doramonitor web --no-open");
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`Deployment failed: ${error.message || error}`);
    process.exit(1);
  }
}

module.exports = { parseArgs };
