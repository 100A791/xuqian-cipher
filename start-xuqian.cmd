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
rem  through explorer.exe fails. This file is the single entry point;
rem  the old Chinese-named duplicate was removed (see CHANGELOG.md).
rem ============================================================
cd /d "%~dp0"
title XUQIAN dev server

rem ---- already running? just open the browser -------------------
netstat -ano | findstr ":5188 " | findstr LISTENING >nul 2>nul
if not errorlevel 1 goto already

rem ---- environment self-heal ------------------------------------
rem  After moving to a new machine (or a reset environment) node_modules
rem  disappears entirely and "pnpm dev" fails with confusing errors.
rem  Install dependencies first so double-click keeps working.
where node >nul 2>nul
if errorlevel 1 goto nonode

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
echo [OK] dependencies installed.
echo.
goto start

:start
echo starting XUQIAN dev server, please wait ~8s ...
echo      site  http://127.0.0.1:5188/
echo      docs  http://127.0.0.1:5188/docs/index.html
echo.
call pnpm dev
if errorlevel 1 goto devfailed
echo.
echo server stopped.
exit /b 0

:already
echo [OK] already running
echo      site  http://127.0.0.1:5188/
echo      docs  http://127.0.0.1:5188/docs/index.html
start "" "http://127.0.0.1:5188/"
exit /b 0

rem ---- failure diagnostics --------------------------------------
rem  "pnpm dev" and "pnpm build" both begin with "node scripts/sync-docs.mjs".
rem  Some Node builds crash on that script *silently* - no output of its own,
rem  and pnpm only prints a cryptic line such as
rem      [ELIFECYCLE] Command failed with exit code 3221226505.
rem  3221226505 is 0xC0000409, a native crash, not a normal script error.
rem  Observed on Node 22.22.x; Node 24 runs the same script fine.
rem  We do NOT pre-check this, because the Node that pnpm uses may differ
rem  from the one on PATH - guessing wrong would block a working setup.
:devfailed
echo.
echo [X] "pnpm dev" exited with an error (see the lines above).
echo.
echo     Most likely cause on this project: the very first step is
echo     "node scripts/sync-docs.mjs", and the Node build in use crashed on it.
echo     A crash code like 3221226505 (0xC0000409) or a silent exit 127
echo     both point at that, not at your project files.
echo.
echo         node --version        (what is currently first on PATH)
echo         pnpm exec node --version   (what pnpm actually runs scripts with)
echo.
echo     This project is verified on Node 24. If either command reports
echo     22.22.x, install Node 24 and put it first on PATH, then retry.
echo.
pause
exit /b 1

:nonode
echo [X] "node" not found on PATH. Install Node.js first (24 recommended).
pause
exit /b 1

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
