@echo off
rem Keeps the TypeScript shop server running: start-shop.bat starts this in a minimised window ("Shop server").
rem If the server stops (an uncaught error makes it log "error <Class>" and exit 1), this writes a line in
rem shop.log and starts it again: after 5 seconds, doubling after each quick failure up to 5 minutes, and back
rem to 5 seconds once a run has lasted over a minute. Exit 3 means the port is taken: right after start-shop.bat
rem stops the old server its socket may linger a moment, so this tries twice more, 10 seconds apart (a line in
rem shop.log each time); if it is still taken after the third try, another copy is serving: this window stops.
rem Close this window (or run start-shop.bat) to stop it; start-shop.bat stops this loop first, then node.
cd /d "%~dp0..\.."
rem password hashing uses up to 4 of Node's threads: give it 8, so hashing never holds up reading files
set UV_THREADPOOL_SIZE=8
rem the real shop: the files in this folder (found by walking up to shop.py) and port 8081, whatever was set before
set "SHOP_ROOT="
set "SHOP_PORT="
set "NODE=%ProgramFiles%\nodejs\node.exe"
if not exist "%NODE%" set "NODE=node"
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell"
set wait=5
set taken=0

:loop
call :clock
set "started=%secs%"
"%NODE%" "%CD%\shop-web\apps\api\dist\main.js"
set code=%errorlevel%
call :clock
set ran=0
if defined started if defined secs set /a ran=secs-started
if %ran% gtr 60 set wait=5
if %ran% gtr 60 set taken=0
if "%code%"=="3" goto port_taken
>>shop.log echo %now% run-shop: the server stopped (exit %code%) after %ran% s; starting it again in %wait% s
%PS% -NoProfile -Command "Start-Sleep -Seconds %wait%" || ping -n 6 127.0.0.1 >nul
if %ran% leq 60 set /a wait*=2
if %wait% gtr 300 set wait=300
goto loop

:port_taken
set /a taken+=1
if %taken% geq 3 (
  >>shop.log echo %now% run-shop: the shop server is already running on the port; this window stops
  exit /b 3
)
>>shop.log echo %now% run-shop: the port is taken (try %taken% of 3); trying again in 10 s
%PS% -NoProfile -Command "Start-Sleep -Seconds 10" || ping -n 11 127.0.0.1 >nul
goto loop

:clock
rem secs = seconds since 1970 and now = the local time for shop.log; both empty if PowerShell fails
set "secs="
set "now="
for /f "tokens=1-3" %%a in ('%PS% -NoProfile -Command "$d = Get-Date; @(([DateTimeOffset]$d).ToUnixTimeSeconds(), $d.ToString('yyyy-MM-dd HH:mm:ss', [Globalization.CultureInfo]::InvariantCulture)) -join [char]32"') do set "secs=%%a" & set "now=%%b %%c"
exit /b
