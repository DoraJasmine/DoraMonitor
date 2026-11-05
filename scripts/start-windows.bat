@echo off
rem start-windows.bat - start DoraMonitor WITH a guard.
rem
rem Preferred: register the hidden-window scheduled tasks (single source of
rem truth: register-autostart.ps1) and launch through them, so a crashed web
rem server is relaunched within a minute.
rem
rem Fallback: when Task Scheduler is unreachable (restricted session, service
rem stopped, policy), register-autostart.ps1 exits 2 and we run keep-alive.cmd
rem instead - a loop that restarts the server 5s after it exits. Either way the
rem server must never be left as an unguarded one-shot process.
rem
rem Why the port dance: a previously started, unguarded node instance still
rem holds 127.0.0.1:3847. A second instance would hit EADDRINUSE and the guard
rem would restart it forever on a short loop.
setlocal
set "ROOT=%~dp0.."

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0register-autostart.ps1" -Force
if errorlevel 2 goto fallback
if errorlevel 1 (
  echo [error] registration failed - see the message above.
  exit /b 1
)

call :freepot
schtasks /run /tn doramonitor-daemon >nul 2>&1
schtasks /run /tn doramonitor-web >nul 2>&1

echo.
echo DoraMonitor started under Task Scheduler ^(auto-restart within 1 min^).
echo   web: http://127.0.0.1:3847
echo Stop: schtasks /end /tn doramonitor-web ^& schtasks /end /tn doramonitor-daemon
echo.
goto :eof

:fallback
echo.
echo [!] Task Scheduler unavailable - using the keep-alive loop guard instead.
call :freepot
start "" /b cmd /c ""%~dp0keep-alive.cmd""
echo   web: http://127.0.0.1:3847  ^(restarted 5s after any exit^)
echo Stop: taskkill /f /im node.exe  ^(or end the keep-alive.cmd process^)
echo.
goto :eof

:freepot
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$c = Get-NetTCPConnection -LocalPort 3847 -State Listen -ErrorAction SilentlyContinue; if ($c) { $c | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }; Start-Sleep -Seconds 2 }" 2>nul
exit /b 0
