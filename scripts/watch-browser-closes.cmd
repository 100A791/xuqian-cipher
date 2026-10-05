@echo off
rem Read-only watcher: records who makes msedge disappear. Never starts/closes a browser.
rem Log: %TEMP%\xuqian-browser-watch.log   Stop it: taskkill /IM powershell.exe is NOT used - close via the log note.
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0watch-browser-closes.ps1"
