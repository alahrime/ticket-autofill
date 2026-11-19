@echo off
rem Keeps the TypeScript shop server running: start-shop.bat starts this in a minimised window.
rem The server keeps going after a stray error (it logs "error <Class>" in shop.log), but Node advises a restart,
rem so if node ever stops, this waits 5 seconds, writes a line in shop.log and starts it again.
rem Close this window (or run start-shop.bat) to stop it; start-shop.bat stops this loop first, then node.
cd /d "%~dp0..\.."
rem password hashing uses up to 4 of Node's threads: give it 8, so hashing never holds up reading files
set UV_THREADPOOL_SIZE=8
rem the real shop: the files in this folder (found by walking up to shop.py) and port 8081, whatever was set before
set "SHOP_ROOT="
set "SHOP_PORT="
rem in case node isn't on this window's PATH (the installer puts it here)
set "PATH=%PATH%;%ProgramFiles%\nodejs"
:loop
node shop-web\apps\api\dist\main.js
set code=%errorlevel%
rem wait 5 seconds, then the time for the log line (one PowerShell call does both)
set "now="
for /f "delims=" %%t in ('powershell -NoProfile -Command "Start-Sleep -Seconds 5; Get-Date -Format 'yyyy-MM-dd HH:mm:ss'"') do set "now=%%t"
>>shop.log echo %now% run-shop: the server stopped (exit %code%); starting it again
goto loop
