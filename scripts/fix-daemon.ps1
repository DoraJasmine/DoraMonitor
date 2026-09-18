# fix-daemon.ps1 — 把 doramonitor-daemon 计划任务换成隐藏窗口启动
# 执行后登录自启不再弹出黑色命令行窗口
$ErrorActionPreference = "Stop"

$InstallDir = Split-Path -Parent $PSScriptRoot
$Node = @(
    "$env:ProgramFiles\nodejs\node.exe",
    "${env:ProgramFiles(x86)}\nodejs\node.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $Node) { $cmd = Get-Command node -ErrorAction SilentlyContinue; if ($cmd) { $Node = $cmd.Source } }
if (-not $Node) { throw "node not found" }

$vbs = "$InstallDir\daemon-hidden.vbs"
$inner = '""{0}"" ""{1}\src\doramonitor.js"" daemon' -f $Node, $InstallDir
$line = 'CreateObject("Wscript.Shell").Run "{0}", 0, False' -f $inner
Set-Content -Path $vbs -Value $line -Encoding ASCII

$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\wscript.exe" -Argument "`"$vbs`""
$registered = $false
try {
    Register-ScheduledTask -TaskName "doramonitor-daemon" -Action $action -Trigger (New-ScheduledTaskTrigger -AtLogOn) -Force -ErrorAction Stop | Out-Null
    Stop-ScheduledTask -TaskName "doramonitor-daemon" -ErrorAction SilentlyContinue
    Start-ScheduledTask -TaskName "doramonitor-daemon"
    $registered = $true
} catch {
    # No admin rights — fall back to the per-user Startup folder (no admin needed).
    $startup = [Environment]::GetFolderPath("Startup")
    Copy-Item -Path $vbs -Destination (Join-Path $startup "doramonitor-daemon.vbs") -Force
    Start-Process -FilePath "$env:SystemRoot\System32\wscript.exe" -ArgumentList "`"$vbs`"" -WindowStyle Hidden
    Write-Host "Scheduled task needs admin; installed autostart in Startup folder instead: $startup" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Done - daemon now runs hidden (no console window)." -ForegroundColor Green
Write-Host "Verify sync state file:"
Get-Content "$env:USERPROFILE\.doramonitor\sync.state" -ErrorAction SilentlyContinue
