cd /d "%~dp0"
taskkill /F /IM node.exe >nul 2>&1
timeout /t 2 /nobreak >nul
start cmd /c "node server.js 2>&1 | out-file -encoding utf8 server.log -append && exit"
echo Restarting...
timeout /t 3 /nobreak >nul
type server.log
