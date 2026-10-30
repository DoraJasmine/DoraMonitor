param(
  [switch]$WithWeb,
  [switch]$Start
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Info($Message) { Write-Host "==> $Message" -ForegroundColor Cyan }

$Node = $null
$SystemNode = Get-Command node -ErrorAction SilentlyContinue
if ($SystemNode) {
  $Major = & $SystemNode.Source -p "Number(process.versions.node.split('.')[0])"
  if ([int]$Major -ge 18) { $Node = $SystemNode.Source }
}

if (-not $Node) {
  $NodeDir = "$env:LOCALAPPDATA\doramonitor-node"
  $Node = "$NodeDir\node.exe"
  if (-not (Test-Path $Node)) {
    $NodeVersion = "v22.17.0"
    $Archive = "$env:TEMP\node-$NodeVersion-win-x64.zip"
    Info "Downloading Node.js $NodeVersion"
    Invoke-WebRequest "https://nodejs.org/dist/$NodeVersion/node-$NodeVersion-win-x64.zip" -OutFile $Archive -UseBasicParsing
    Expand-Archive $Archive -DestinationPath $env:LOCALAPPDATA -Force
    if (Test-Path $NodeDir) { Remove-Item $NodeDir -Recurse -Force }
    Rename-Item "$env:LOCALAPPDATA\node-$NodeVersion-win-x64" $NodeDir
    Remove-Item $Archive -Force
  }
}

$NodeDir = Split-Path -Parent $Node
$env:Path = "$NodeDir;$env:Path"
$Npm = "$NodeDir\npm.cmd"
if (-not (Test-Path $Npm)) { throw "npm.cmd was not found next to $Node" }

Info "Installing DoraMonitor from npm"
& $Npm install -g doramonitor
if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
$GlobalRoot = (& $Npm root -g).Trim()
$PackageDir = Join-Path $GlobalRoot "doramonitor"
if (-not (Test-Path "$PackageDir\src\doramonitor.js")) { throw "DoraMonitor package was not found in $GlobalRoot" }

$Command = "$NodeDir\doramonitor.cmd"
if (-not (Test-Path $Command)) { $Command = (Get-Command doramonitor -ErrorAction Stop).Source }
& $Command --version

if ($WithWeb) {
  Info "Registering hidden logon tasks"
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$PackageDir\scripts\register-autostart.ps1"
}
if ($Start) {
  Info "Starting the dashboard without a console window"
  & $Command web --background --no-open
}

Write-Host ""
Write-Host "DoraMonitor installed successfully." -ForegroundColor Green
Write-Host "Run: doramonitor"
Write-Host "Background: doramonitor web --background --no-open"
Write-Host "Dashboard: http://127.0.0.1:3847"
