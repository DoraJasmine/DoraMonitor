"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.join(__dirname, "..");

test("Linux installer parses and documents its options", (t) => {
  const script = path.join("scripts", "install-linux.sh");
  const syntax = spawnSync("bash", ["-n", script], { cwd: root, encoding: "utf8" });
  if (syntax.error && syntax.error.code === "ENOENT") return t.skip("bash is unavailable");
  assert.equal(syntax.status, 0, syntax.stderr);
  const help = spawnSync("bash", [script, "--help"], { cwd: root, encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--with-web/);
  assert.match(help.stdout, /--start/);
  assert.match(help.stdout, /without sudo/);
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
