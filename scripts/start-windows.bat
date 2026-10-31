@echo off
setlocal
set "ROOT=%~dp0.."
set "NODE=node"
if exist "%LOCALAPPDATA%\doramonitor-node\node.exe" set "NODE=%LOCALAPPDATA%\doramonitor-node\node.exe"
"%NODE%" "%ROOT%\src\doramonitor.js" daemon --background
"%NODE%" "%ROOT%\src\doramonitor.js" web --background --no-open
endlocal
