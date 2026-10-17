@echo off
rem ============================================================
rem  Compatibility shim.
rem  The real one-click launcher is start-xuqian.bat (it also opens
rem  the browser and shows diagnostics). This file stays so existing
rem  shortcuts or notes pointing at the .cmd keep working.
rem ============================================================
call "%~dp0start-xuqian.bat" %*
