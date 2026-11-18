@echo off
cd /d "%~dp0.."
curl -s -o nul --max-time 2 http://127.0.0.1:3100/api/status && exit /b 0
"C:\Program Files\nodejs\node.exe" src\bridge.js >> state\bridge.out 2>&1
