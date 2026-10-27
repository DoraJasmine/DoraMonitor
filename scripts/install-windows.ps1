# doramonitor Windows 一键安装
# 打包方式（Ubuntu 侧维护者参考）：
#   git ls-files > /tmp/fl.txt
#   tar czf doramonitor-win.tar.gz -T /tmp/fl.txt dist node_modules/smol-toml
# dist/ 是 Web UI 构建产物；node_modules/smol-toml 是唯一运行时第三方依赖。

# 在 Windows PowerShell 中执行：
#   powershell -ExecutionPolicy Bypass -File .\install-windows.ps1 -WithWeb
# 可选参数：
#   -Server http://100.92.91.42:8765   Ubuntu 下载地址（Tailscale）
#   -SyncHost 100.92.91.42             同步目标（Ubuntu 的 Tailscale IP）
#   -DeviceName windows-pc             仪表盘上显示的设备名
#   -WithWeb                           同时注册 Web 仪表盘自启

param(
  [string]$Server = "http://100.92.91.42:8765",
  [string]$SyncHost = "100.92.91.42",
  [string]$SyncUser = "zxt",
  [string]$DeviceName = "windows-pc",
  [switch]$WithWeb
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$InstallDir = "$env:USERPROFILE\DoraMonitor"
$NodeDir = "$env:LOCALAPPDATA\doramonitor-node"
$NodeVer = "v22.17.0"

# Windows 10+ 自带 OpenSSH 客户端
if (Test-Path "$env:SystemRoot\System32\OpenSSH") {
  $env:Path += ";$env:SystemRoot\System32\OpenSSH"
}

function Info($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

# ---------- 1. 便携版 Node ----------
if (Test-Path "$NodeDir\node.exe") {
  Info "Node already installed: $NodeDir"
} else {
  Info "Downloading Node $NodeVer (win-x64)..."
  $zip = "$env:TEMP\node-$NodeVer.zip"
  try {
    Invoke-WebRequest "$Server/node-$NodeVer-win-x64.zip" -OutFile $zip -TimeoutSec 120 -UseBasicParsing
  } catch {
    Info "local server unavailable, falling back to nodejs.org..."
    Invoke-WebRequest "https://nodejs.org/dist/$NodeVer/node-$NodeVer-win-x64.zip" -OutFile $zip -UseBasicParsing
  }
  Info "Extracting Node..."
  Expand-Archive $zip -DestinationPath $env:LOCALAPPDATA -Force
  if (Test-Path $NodeDir) { Remove-Item $NodeDir -Recurse -Force }
  Rename-Item "$env:LOCALAPPDATA\node-$NodeVer-win-x64" $NodeDir
  Remove-Item $zip -Force
}
$Node = "$NodeDir\node.exe"

# ---------- 2. 下载并解压应用 ----------
Info "Downloading doramonitor..."
$tarGz = "$env:TEMP\doramonitor-win.tar.gz"
Invoke-WebRequest "$Server/doramonitor-win.tar.gz" -OutFile $tarGz -UseBasicParsing
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
tar -xzf $tarGz -C $InstallDir
Remove-Item $tarGz -Force
Info "Installed to $InstallDir"

# ---------- 3. 同步配置 ----------
Info "Writing sync config..."
$cfgDir = "$env:USERPROFILE\.doramonitor"
New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
$cfg = [ordered]@{
  currency = "CNY"
  currencySymbol = [string][char]0xA5
  fxRate = 7.2
  customPrices = @()
  sync = [ordered]@{
    enabled = $true
    backend = "ssh"
    deviceName = $DeviceName
    syncInterval = 300
    ssh = [ordered]@{
      host = $SyncHost
      user = $SyncUser
      port = 22
      remotePath = "~/.kimi-status-sync"
      identityFile = ""
    }
  }
}
$json = ConvertTo-Json $cfg -Depth 6
[IO.File]::WriteAllText("$cfgDir\config.json", $json, (New-Object System.Text.UTF8Encoding $false))

# ---------- 4. SSH 免密 ----------
Info "Setting up SSH key (enter $SyncUser password once if asked)..."
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.ssh" | Out-Null
$key = "$env:USERPROFILE\.ssh\id_ed25519"
if (-not (Test-Path $key)) {
  # Win32-OpenSSH quirks: -N '""' means an EMPTY passphrase
  ssh-keygen -t ed25519 -N '""' -f $key -q
}
Get-Content "$key.pub" | ssh "$SyncUser@$SyncHost" "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys"
if ($LASTEXITCODE -ne 0) { throw "SSH public key push failed" }

# ---------- 5. 首次同步 ----------
Info "First sync..."
& $Node "$InstallDir\src\doramonitor.js" sync

# ---------- 6. 登录自启（Register-ScheduledTask，无需管理员） ----------
# daemon 通过 VBS 启动器隐藏运行，避免登录时弹出常驻黑窗口
Info "Registering logon scheduled tasks..."
$trigger = New-ScheduledTaskTrigger -AtLogOn
$vbs = "$InstallDir\daemon-hidden.vbs"
$inner = '""{0}"" ""{1}\src\doramonitor.js"" daemon' -f $Node, $InstallDir
$line = 'CreateObject("Wscript.Shell").Run "{0}", 0, False' -f $inner
Set-Content -Path $vbs -Value $line -Encoding ASCII
$daemonAction = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\wscript.exe" -Argument "`"$vbs`""
Register-ScheduledTask -TaskName "doramonitor-daemon" -Action $daemonAction -Trigger $trigger -Force | Out-Null
if ($WithWeb) {
  $webVbs = "$InstallDir\web-hidden.vbs"
  $webLine = ('CreateObject("Wscript.Shell").Run """{0}"" ""{1}\src\server.js"" --host 127.0.0.1 --port 3847 --no-open", 0, True' -f $Node, $InstallDir) + "`r`n" + 'WScript.Quit 1'
  Set-Content -Path $webVbs -Value $webLine -Encoding ASCII
  $webAction = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\wscript.exe" -Argument "`"$webVbs`""
  $webSettings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
  Register-ScheduledTask -TaskName "doramonitor-web" -Action $webAction -Trigger $trigger -Settings $webSettings -Force | Out-Null
}

# ---------- 7. PATH 垫片：任意 PowerShell 直接敲 doramonitor ----------
Info "Adding doramonitor to PATH (WindowsApps shim)..."
$shimDir = "$env:LOCALAPPDATA\Microsoft\WindowsApps"
New-Item -ItemType Directory -Force -Path $shimDir | Out-Null
$shim = "$shimDir\doramonitor.cmd"
$shimContent = "@echo off`r`n" + ('"{0}" "{1}\src\doramonitor.js" %*' -f $Node, $InstallDir) + "`r`n"
$shimContent | Out-File -FilePath $shim -Encoding ascii

Write-Host ""
Write-Host "Done!" -ForegroundColor Green
Write-Host "  App:      $InstallDir"
Write-Host "  Status:   & `"$Node`" `"$InstallDir\src\doramonitor.js`" status"
if ($WithWeb) {
  Write-Host "  Dashboard: http://127.0.0.1:3847 (starts at logon; or run now:)"
  Write-Host '             Start-Process "$env:LOCALAPPDATA\doramonitor-node\node.exe" -ArgumentList "$env:USERPROFILE\DoraMonitor\src\server.js --host :: --port 3847"'
}
Write-Host "  The Ubuntu dashboard will show a windows-pc device tab within ~5 min."
