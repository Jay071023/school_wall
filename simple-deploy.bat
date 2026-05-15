@echo off
chcp 65001 >nul
echo ================================================
echo 上传头像压缩功能到服务器
echo ================================================

setlocal enabledelayedexpansion

set "HOST=152.32.226.134"
set "USER=root"
set "KEY_FILE=ssh_key_new"
set "LOCAL_FILE=profile-update\edit-profile.html"
set "REMOTE_PATH=/www/wwwroot/wall.jay23.cn/campus-wall/profile-update/edit-profile.html"

echo.
echo 📤 读取本地文件...
powershell -Command "[Convert]::ToBase64String([IO.File]::ReadAllBytes('%LOCAL_FILE%'))" > temp_base64.txt

echo.
echo 📡 上传到服务器...
set /p BASE64_CONTENT=<temp_base64.txt

plink -i %KEY_FILE% %USER%@%HOST% "mkdir -p /www/wwwroot/wall.jay23.cn/campus-wall/profile-update"

echo %BASE64_CONTENT% | plink -i %KEY_FILE% %USER%@%HOST% "cat > /tmp/edit-profile.html.b64 && echo %BASE64_CONTENT% | base64 -d > %REMOTE_PATH%"

echo.
echo 🔄 重启服务...
plink -i %KEY_FILE% %USER%@%HOST% "pm2 restart campus-wall"

echo.
echo 🧹 清理临时文件...
plink -i %KEY_FILE% %USER%@%HOST% "rm -f /tmp/edit-profile.html.b64"
del temp_base64.txt

echo.
echo ================================================
echo ✅ 部署完成!
echo 网站: https://wall.jay23.cn/edit-profile
echo ================================================
pause
