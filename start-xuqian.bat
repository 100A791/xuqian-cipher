@echo off
setlocal EnableExtensions
rem ============================================================
rem  XUQIAN Cipher Station - one-click launcher (Windows)
rem
rem  Double-click this file:
rem    1. checks node / pnpm and installs dependencies if missing
rem    2. starts the dev server in its own window
rem    3. waits until http://127.0.0.1:5188/ answers
rem    4. opens the browser
rem
rem  Closing the "XUQIAN dev server" window stops the server.
rem
rem  Keep this file PURE ASCII. Mixing non-ASCII comments with "chcp"
rem  made cmd.exe mis-parse rem lines in the previous script, and a
rem  Chinese-named .cmd launched through explorer.exe failed outright.
rem
rem  Debug switches (optional):
rem    XQ_NO_BROWSER=1   do not open a browser (useful for automation)
rem    XQ_NO_WINDOW=1    start the server window minimized
rem ============================================================

rem  Start in the folder that contains this file (works from any cwd).
cd /d "%~dp0"
set "PORT=5188"
set "SITE=http://127.0.0.1:%PORT%/"

rem  The server window re-invokes this same file with --server, so all
rem  environment checks and diagnostics live in one place.
if /i "%~1"=="--server" goto server

rem ---- 1. already running? just open the browser -----------------
netstat -ano | findstr ":%PORT% " | findstr LISTENING >nul 2>nul
if not errorlevel 1 goto already

rem ---- 2. environment checks --------------------------------------
where node >nul 2>nul
if errorlevel 1 goto nonode

rem  Require Node 20.19+ (this project uses modern WebCrypto/Worker APIs).
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>20||(a===20&&b>=19)?0:1)" >nul 2>nul
if errorlevel 1 goto oldnode

where pnpm >nul 2>nul
if not errorlevel 1 goto checkdeps

rem  pnpm is the documented package manager; corepack ships with Node.
where corepack >nul 2>nul
if errorlevel 1 goto nopnpm
echo [i] pnpm not found on PATH, trying corepack ...
call corepack enable >nul 2>nul
where pnpm >nul 2>nul
if errorlevel 1 goto nopnpm

:checkdeps
rem  After moving to a new machine node_modules disappears entirely and
rem  "pnpm dev" fails with confusing errors. Install first.
if not exist "node_modules\vite\package.json" goto install
goto launch

:install
echo [i] dependencies missing - installing (needs network, 1-2 minutes) ...
echo.
call pnpm install
if errorlevel 1 goto installfail
echo.
echo [OK] dependencies installed.
echo.

:launch
echo [i] starting dev server in a separate window ...
set "MIN="
if "%XQ_NO_WINDOW%"=="1" set "MIN=/min"
start "XUQIAN dev server" %MIN% /d "%~dp0" cmd /k call "%~f0" --server
echo [i] waiting for %SITE% ...
echo.

rem  Poll until the page answers. curl.exe ships with Windows 10 1803+.
where curl >nul 2>nul
if errorlevel 1 goto fallbackwait
for /l %%i in (1,1,120) do (
  rem  -f fails on HTTP >= 400 (a proxy 502 must NOT count as "up and running")
  rem  --noproxy keeps the check local even when a system proxy is configured
  curl -sf --noproxy "*" -o NUL --max-time 2 %SITE% >nul 2>nul
  if not errorlevel 1 goto open
  ping -n 2 127.0.0.1 >nul
)
goto waittimeout

:fallbackwait
ping -n 7 127.0.0.1 >nul

:open
if "%XQ_NO_BROWSER%"=="1" goto reported
start "" "%SITE%"

:reported
echo [OK] server is running.
echo      site  %SITE%
echo      docs  %SITE%docs/index.html
echo.
echo      Close the "XUQIAN dev server" window to stop it.
ping -n 4 127.0.0.1 >nul
exit /b 0

:already
echo [OK] dev server is already running.
echo      site  %SITE%
echo      docs  %SITE%docs/index.html
if "%XQ_NO_BROWSER%"=="1" exit /b 0
start "" "%SITE%"
exit /b 0

rem ============================================================
rem  Server mode (runs inside the "XUQIAN dev server" window)
rem ============================================================
:server
title XUQIAN dev server
echo ============================================================
echo  XUQIAN dev server
echo  site  %SITE%
echo  docs  %SITE%docs/index.html
echo.
echo  Keep this window open. Closing it stops the server.
echo ============================================================
echo.
call pnpm dev
if errorlevel 1 goto devfailed
echo.
echo server stopped.
rem  exit (not exit /b) also closes this cmd window
exit 0

rem ---- failure diagnostics --------------------------------------
:devfailed
echo.
echo [X] "pnpm dev" exited with an error (see the lines above).
echo.
echo     The first step of "pnpm dev" is "node scripts/sync-docs.mjs".
echo     If you see a native crash code (3221226505 / 0xC0000409) or a
echo     silent exit there, the Node build in use is the problem - not
echo     the project files. Check both of these:
echo.
echo         node --version              (first on PATH)
echo         pnpm exec node --version    (what pnpm actually runs)
echo.
echo     This project is verified on Node 20.19+ / 24. If either command
echo     reports an older version, install Node 24 and put it first on PATH.
echo.
pause
exit 1

:waittimeout
echo.
echo [X] the server did not answer at %SITE% within 120 seconds.
echo     Check the "XUQIAN dev server" window for the actual error.
echo.
pause
exit /b 1

:nonode
echo [X] Node.js was not found on PATH.
echo     Install Node.js 20.19+ (24 recommended): https://nodejs.org/
echo     Then close this window and double-click this file again.
echo.
pause
exit /b 1

:oldnode
echo [X] Node.js is too old.
node --version
echo     This project needs Node 20.19 or newer (24 recommended).
echo     Install it from https://nodejs.org/ and put it first on PATH.
echo.
pause
exit /b 1

:nopnpm
echo [X] pnpm was not found and corepack could not provide it.
echo     Install pnpm, then run "pnpm install" in this folder:
echo         corepack enable
echo         corepack prepare pnpm@11.7.0 --activate
echo.
pause
exit /b 1

:installfail
echo.
echo [X] "pnpm install" failed.
echo     If it reports ERR_PNPM_IGNORED_BUILDS, make sure pnpm-workspace.yaml
echo     allows the build script:
echo         allowBuilds:
echo           esbuild: true
echo.
pause
exit /b 1
