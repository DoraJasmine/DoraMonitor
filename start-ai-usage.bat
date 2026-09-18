@echo off
cd /d D:\ai-usage-monitor
start "ai-usage" /min "C:\Program Files\nodejs\node.exe" src/server.js --no-open
