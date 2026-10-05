@echo off
rem ============================================================
rem  XUQIAN Cipher Station - local dev server
rem  site: http://127.0.0.1:5188/
rem  docs: http://127.0.0.1:5188/docs/index.html
rem  Closing this window stops the server.
rem
rem  NOTE: keep this file pure ASCII. Mixing non-ASCII comments with
rem  "chcp" made cmd.exe mis-parse the lines (rem lines were executed
rem  as commands and the port check stopped working).
rem  The filename is ASCII on purpose: launching a Chinese-named .cmd
rem  through explorer.exe fails.
rem ============================================================
cd /d "%~dp0"
title XUQIAN dev server

rem ---- already running? then do nothing -------------------------
netstat -ano | findstr ":5188 " | findstr LISTENING >nul 2>nul
if not errorlevel 1 goto already

rem ---- environment self-heal -----------------------------------
rem  After moving to a new machine (or a reset environment) node_modules
rem  disappears entirely and "pnpm dev" fails with confusing errors.
rem  Install dependencies first so double-click keeps working.
where pnpm >nul 2>nul
if errorlevel 1 goto nopnpm

if not exist "node_modules\vite\package.json" goto install
goto start

:install
echo [i] dependencies missing (common after moving machines) - installing...
echo     needs network, first run takes about 1-2 minutes.
echo.
call pnpm install
if errorlevel 1 goto installfail
echo.
echo [OK] dependencies installed, starting server.
echo.
goto start

:already
echo [OK] already running
echo      site  http://127.0.0.1:5188/
echo      docs  http://127.0.0.1:5188/docs/index.html
exit /b 0

:start
echo starting XUQIAN dev server, please wait ~8s ...
echo      site  http://127.0.0.1:5188/
echo      docs  http://127.0.0.1:5188/docs/index.html
echo.
call pnpm dev
echo.
echo server stopped.
exit /b 0

:nopnpm
echo [X] pnpm not found. Install Node.js and pnpm first.
echo     Then run "pnpm install" in this folder.
pause
exit /b 1

:installfail
echo.
echo [X] "pnpm install" failed.
echo     If it reports ERR_PNPM_IGNORED_BUILDS, make sure pnpm-workspace.yaml allows
echo     the build script:
echo         allowBuilds:
echo           esbuild: true
pause
exit /b 1
