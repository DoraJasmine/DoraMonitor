@echo off
rem keep-alive.cmd - restart the web server whenever it exits.
rem Fallback guard for when Task Scheduler is unavailable (headless session,
rem restricted account, or a machine where tasks cannot be registered).
setlocal
set "ROOT=%~dp0.."
set "NODE=node"
if exist "%LOCALAPPDATA%\doramonitor-node\node.exe" set "NODE=%LOCALAPPDATA%\doramonitor-node\node.exe"

:loop
"%NODE%" "%ROOT%\src\server.js" --host 127.0.0.1 --port 3847 --no-open
echo [%DATE% %TIME%] web exited with %ERRORLEVEL%, restarting in 5s...
timeout /t 5 /nobreak >nul
goto loop
