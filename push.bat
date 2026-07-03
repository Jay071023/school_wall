@echo off
chcp 65001 >nul
echo ========================================
echo   嘉二校园墙 - Git 推送工具
echo ========================================
echo.

cd /d "%~dp0"

echo [1/3] git add .
git add -A

echo.
echo [2/3] 输入提交信息（输入q退出）:
set /p msg=
if "%msg%"=="q" goto end

git commit -m "%msg%"

echo.
echo [3/3] git push gitee main
git push gitee main

if errorlevel 1 (
    echo.
    echo [错误] 推送失败，请检查网络或凭据
    echo 如果凭据过期，运行: git config --global credential.helper store
    echo 然后重新输入用户名和密码
    pause
    exit /b 1
)

echo.
echo [成功] 推送完成！
echo.

:end
pause
