# fix-daemon.ps1 — 把 ai-usage-daemon 计划任务换成隐藏窗口启动
# 执行后登录自启不再弹出黑色命令行窗口
$ErrorActionPreference = "Stop"

$InstallDir = "$env:USERPROFILE\ai-usage-monitor"
$Node = "$env:LOCALAPPDATA\ai-usage-node\node.exe"

if (-not (Test-Path $Node)) { throw "node not found: $Node" }

$vbs = "$InstallDir\daemon-hidden.vbs"
$inner = '""{0}"" ""{1}\src\ai-usage.js"" daemon' -f $Node, $InstallDir
$line = 'CreateObject("Wscript.Shell").Run "{0}", 0, False' -f $inner
Set-Content -Path $vbs -Value $line -Encoding ASCII

$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\wscript.exe" -Argument "`"$vbs`""
Register-ScheduledTask -TaskName "ai-usage-daemon" -Action $action -Trigger (New-ScheduledTaskTrigger -AtLogOn) -Force | Out-Null
Stop-ScheduledTask -TaskName "ai-usage-daemon" -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName "ai-usage-daemon"

Write-Host ""
Write-Host "Done - daemon now runs hidden (no console window)." -ForegroundColor Green
Write-Host "Verify sync state file:"
Get-Content "$env:USERPROFILE\.ai-usage-monitor\sync.state" -ErrorAction SilentlyContinue
