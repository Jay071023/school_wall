@echo off
chcp 65001 >nul

echo ========================================
echo        Upload to Server
echo ========================================
echo.

cd /d "%~dp0"

echo [1/3] Check environment...
if exist "ssh_key_new" (
    echo [OK] SSH key found: ssh_key_new
) else if exist "ssh_key" (
    echo [OK] SSH key found: ssh_key
) else (
    echo [ERROR] SSH key not found!
    pause
    exit /b 1
)

if not exist "node_modules\ssh2" (
    echo [ERROR] Need npm install first!
    pause
    exit /b 1
)

echo [2/3] Uploading...
node upload.js

echo [3/3] Done!
pause
