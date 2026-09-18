# register-autostart.ps1 — 注册登录自启（ai-usage-daemon + ai-usage-web）
# 经 VBS 隐藏窗口启动，登录后无黑色命令行窗口；无需管理员权限。
# 重复执行安全（-Force 覆盖旧任务）。
$ErrorActionPreference = "Stop"

$InstallDir = "D:\ai-usage-monitor"
if (-not (Test-Path "$InstallDir\daemon-hidden.vbs")) {
  throw "未找到 $InstallDir\daemon-hidden.vbs — 请在 ai-usage-monitor 仓库根目录执行"
}

$wscript = "$env:SystemRoot\System32\wscript.exe"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

$actions = @{
  "ai-usage-daemon" = "$InstallDir\daemon-hidden.vbs"
  "ai-usage-web"    = "$InstallDir\web-hidden.vbs"
}
foreach ($name in $actions.Keys) {
  $vbs = $actions[$name]
  if (-not (Test-Path $vbs)) { Write-Host "跳过 $name（缺少 $vbs）" -ForegroundColor Yellow; continue }
  $act = New-ScheduledTaskAction -Execute $wscript -Argument "`"$vbs`""
  Register-ScheduledTask -TaskName $name -Action $act -Trigger $trigger -Force | Out-Null
  Write-Host "已注册 $name -> $vbs" -ForegroundColor Green
}

Write-Host ""
Write-Host "验证：Get-ScheduledTask | Where-Object { `$_.TaskName -like 'ai-usage*' }" -ForegroundColor Cyan
Write-Host "移除：Unregister-ScheduledTask -TaskName ai-usage-daemon,ai-usage-web -Confirm:`$false" -ForegroundColor Cyan
