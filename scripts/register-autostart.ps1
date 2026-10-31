# register-autostart.ps1 — 注册登录自启（doramonitor-daemon + doramonitor-web）
#
# - 自动定位安装目录（本脚本位于 <安装目录>\scripts\，全局 npm 安装、
#   git 克隆、任意盘符均可）
# - 自动探测 node.exe（便携版 / 系统 PATH）
# - 生成隐藏窗口启动器（daemon-hidden.vbs / web-hidden.vbs）和
#   start-doramonitor.bat 到安装目录根
# - 注册两个「用户登录时」触发的计划任务，无需管理员权限
# - 重复执行安全（-Force 覆盖旧任务与旧启动器）
$ErrorActionPreference = "Stop"

$InstallDir = Split-Path -Parent $PSScriptRoot
$Node = $null
$Candidates = @(
    "$env:LOCALAPPDATA\doramonitor-node\node.exe",
    "$env:LOCALAPPDATA\ai-usage-node\node.exe",
    "$env:ProgramFiles\nodejs\node.exe",
    "${env:ProgramFiles(x86)}\nodejs\node.exe"
)
$PathNode = Get-Command node -ErrorAction SilentlyContinue
if ($PathNode) { $Candidates += $PathNode.Source }
foreach ($Candidate in $Candidates) {
  if (-not (Test-Path $Candidate)) { continue }
  $Major = & $Candidate -p "Number(process.versions.node.split('.')[0])"
  if ([int]$Major -ge 18) { $Node = $Candidate; break }
}
if (-not $Node) { throw "未找到 Node.js 18+，请先安装支持版本的 Node.js" }

# --- 生成隐藏窗口启动器（ASCII + CRLF，与 install-windows.ps1 同款） ---
$launchers = @(
  @{ file = "daemon-hidden.vbs"; line = 'CreateObject("Wscript.Shell").Run """{0}"" ""{1}\src\doramonitor.js"" daemon", 0, False' -f $Node, $InstallDir },
  @{ file = "web-hidden.vbs";    line = ('CreateObject("Wscript.Shell").Run """{0}"" ""{1}\src\server.js"" --host 127.0.0.1 --port 3847 --no-open", 0, True' -f $Node, $InstallDir) + "`r`n" + 'WScript.Quit 1' },
  @{ file = "start-doramonitor.bat"; line = '@echo off' + "`r`n" + '"' + $Node + '" "' + $InstallDir + '\src\doramonitor.js" daemon --background' + "`r`n" + '"' + $Node + '" "' + $InstallDir + '\src\doramonitor.js" web --background --no-open' }
)
foreach ($l in $launchers) {
  Set-Content -Path (Join-Path $InstallDir $l.file) -Value $l.line -Encoding ASCII
  Write-Host "已生成 $($l.file)" -ForegroundColor Green
}

# --- 注册计划任务（登录触发，VBS 隐藏窗口） ---
$wscript = "$env:SystemRoot\System32\wscript.exe"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$tasks = @{
  "doramonitor-daemon" = "daemon-hidden.vbs"
  "doramonitor-web"    = "web-hidden.vbs"
}
foreach ($name in $tasks.Keys) {
  $vbs = Join-Path $InstallDir $tasks[$name]
  $act = New-ScheduledTaskAction -Execute $wscript -Argument "`"$vbs`""
  if ($name -eq "doramonitor-web") {
    # The VBS waits for Node and exits nonzero if it stops. Task Scheduler then
    # relaunches the web server; no default 72-hour execution limit applies.
    $settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
    Register-ScheduledTask -TaskName $name -Action $act -Trigger $trigger -Settings $settings -Force | Out-Null
  } else {
    Register-ScheduledTask -TaskName $name -Action $act -Trigger $trigger -Force | Out-Null
  }
  Write-Host "已注册计划任务 $name" -ForegroundColor Green
}

Write-Host ""
Write-Host "安装目录: $InstallDir" -ForegroundColor Cyan
Write-Host "下次登录自动启动 daemon + http://127.0.0.1:3847" -ForegroundColor Cyan
Write-Host "移除自启: powershell -Command ""Unregister-ScheduledTask -TaskName doramonitor-daemon,doramonitor-web -Confirm:`$false""" -ForegroundColor Cyan
