@echo off
chcp 65001 >nul

echo ════════════════════════════════════════
echo        校墙 - 上传部署到服务器
echo ════════════════════════════════════════
echo.

cd /d "%~dp0"

:: 检测 SSH 密钥
if exist "ssh_key_new" (
    set SSH_KEY=ssh_key_new
) else if exist "ssh_key" (
    set SSH_KEY=ssh_key
) else (
    echo [✗] 未找到 SSH 密钥文件 (ssh_key / ssh_key_new)
    pause
    exit /b 1
)

:: 检测依赖
if not exist "node_modules\ssh2" (
    echo [✗] 缺少 ssh2 依赖，请先运行: npm install
    pause
    exit /b 1
)

echo [1/3] 正在连接到服务器 152.32.226.134 ...
echo.

node upload.js

if %errorlevel% neq 0 (
    echo.
    echo [✗] 上传失败，请检查网络或服务器状态
) else (
    echo.
    echo [✓] 上传完成，服务器已重启！
)

echo.
pause
