@echo off
cd /d "%~dp0"
taskkill /F /IM node.exe >nul 2>&1
start /B cmd /c "node server.js"
echo Server starting...
