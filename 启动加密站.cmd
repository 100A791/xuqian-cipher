@echo off
chcp 65001 >nul
cd /d "%~dp0"
title XUQIAN 加密站 — 关闭本窗口即停止服务

netstat -ano | findstr ":5188 " | findstr LISTENING >nul
if not errorlevel 1 (
  echo [OK] 服务已在运行
  echo.
  echo   主站   http://127.0.0.1:5188/
  echo   文档   http://127.0.0.1:5188/docs/index.html
  start "" "http://127.0.0.1:5188/"
  timeout /t 3 >nul
  exit /b 0
)

echo 正在启动 XUQIAN 加密站，约 5~8 秒后可用：
echo.
echo   主站   http://127.0.0.1:5188/
echo   文档   http://127.0.0.1:5188/docs/index.html
echo.
echo   关闭本窗口 = 停止服务
echo ------------------------------------------------------------------
echo.

call pnpm dev

echo.
echo 服务已停止。按任意键关闭窗口。
pause >nul
