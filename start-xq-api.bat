@echo off
setlocal
cd /d "%~dp0"
set "NODE24=C:\Users\xuqian\AppData\Local\Programs\nodejs\node.exe"
if exist "%NODE24%" (
  set "NODEEXE=%NODE24%"
) else (
  set "NODEEXE=node"
)
echo ============================================================
echo  XUQIAN local API  -  http://127.0.0.1:5190
echo  Node: %NODEEXE%
echo  Token file: %TEMP%\xuqian-api-token.json
echo  Close this window to stop the service.
echo ============================================================
echo.
"%NODEEXE%" scripts\xq-api.mjs
echo.
echo [xq-api] stopped. Press any key to close.
pause >nul