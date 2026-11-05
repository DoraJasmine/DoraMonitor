"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.join(__dirname, "..");

test("Linux installer parses and documents its options", (t) => {
  const script = "scripts/install-linux.sh";
  const syntax = spawnSync("bash", ["-n", script], { cwd: root, encoding: "utf8" });
  if (syntax.error && syntax.error.code === "ENOENT") return t.skip("bash is unavailable");
  assert.equal(syntax.status, 0, syntax.stderr);
  const help = spawnSync("bash", [script, "--help"], { cwd: root, encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--with-web/);
  assert.match(help.stdout, /--start/);
  assert.match(help.stdout, /without sudo/);
});

test("Windows launcher guards the server instead of starting an unguarded process", () => {
  const script = require("fs").readFileSync(path.join(root, "scripts", "start-windows.bat"), "utf8");
  // Preferred path: register the scheduled tasks, then launch through them.
  assert.match(script, /register-autostart\.ps1/);
  assert.match(script, /schtasks \/run \/tn doramonitor-web/);
  // Fallback path: when Task Scheduler is unreachable (register exits 2) the
  // loop guard must take over — an unguarded one-shot server is the bug this
  // script exists to prevent.
  assert.match(script, /errorlevel 2 goto fallback/);
  assert.match(script, /keep-alive\.cmd/);
  // Both paths must free 3847 first, or the new instance hits EADDRINUSE and
  // the guard restarts it on a tight loop.
  assert.match(script, /:freepot/);
  assert.match(script, /Get-NetTCPConnection -LocalPort 3847/);
});

test("Windows keep-alive guard restarts the server after any exit", () => {
  const script = require("fs").readFileSync(path.join(root, "scripts", "keep-alive.cmd"), "utf8");
  assert.match(script, /^:loop$/m);
  assert.match(script, /src\\server\.js/);
  assert.match(script, /goto loop/);
});

test("autostart registration reports failure instead of claiming success", () => {
  const script = require("fs").readFileSync(path.join(root, "scripts", "register-autostart.ps1"), "utf8");
  // Register-ScheduledTask must not have its error swallowed by `| Out-Null`:
  // a false "已注册" line is what left the server unguarded in the first place.
  assert.match(script, /-ErrorAction Stop/);
  assert.match(script, /exit 2/);
  assert.doesNotMatch(script, /Register-ScheduledTask[^\n]*-Force \| Out-Null(?![\s\S]{0,80}-ErrorAction)/);
});

test("Windows installer has valid PowerShell syntax", (t) => {
  if (process.platform !== "win32") return t.skip("PowerShell parser test runs on Windows");
  const script = path.join(root, "scripts", "install-windows.ps1");
  const check = spawnSync("powershell.exe", [
    "-NoProfile",
    "-Command",
    `$errors = $null; [System.Management.Automation.Language.Parser]::ParseFile('${script.replace(/'/g, "''")}', [ref]$null, [ref]$errors) > $null; if ($errors.Count) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }`,
  ], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
});
