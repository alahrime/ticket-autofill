@echo off
rem One click (re)starts everything the phones need:
rem   the shop tickets server (127.0.0.1:8081: /admin, /tech): the TypeScript server in shop-web
rem     (shop-web\apps\api\dist\main.js, kept running by shop-web\tools\run-shop.cmd in a minimised window),
rem   the phone page and the Cloudflare tunnel (phone.py --tunnel, for shop. and inspect.japaneseautoservice1.com), and Ollama.
rem   start-shop.bat python   starts the old Python server (pythonw shop.py) instead: the one-step rollback.
rem Any copy already running (Python or TypeScript) is stopped first, so this is also how to restart after an update or a password reset.
rem The first run each day also saves a copy of tickets.db as tickets-backup-YYYY-MM-DD.db (kept on this PC, git-ignored).
rem It never touches the Ticket Autofill window (app.py) or InvoMax.
rem Put a shortcut to this file in shell:startup to start it all when the PC boots.
cd /d "%~dp0"
if not "%~1"=="" if /i not "%~1"=="python" (
  echo start-shop.bat: unknown option "%~1". Use start-shop.bat for the shop server, or start-shop.bat python for the old Python one.
  echo Nothing was stopped or started.
  pause
  exit /b 2
)
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell"
rem this folder, for the stop step: only the TypeScript server started from here is stopped
set "START_SHOP_DIR=%~dp0"

rem Stop: first the restart loop (so it can't start node again), then the servers and the tunnel.
rem An "admin <name>" password reset running in a console is left alone.
%PS% -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -match '/[ck]\s+\x22*[^\x22]*shop-web\\tools\\run-shop\.cmd(\x22|\s|$)' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
%PS% -NoProfile -Command "$main = ($env:START_SHOP_DIR + 'shop-web\apps\api\dist\main.js').ToLower(); Get-CimInstance Win32_Process | Where-Object { ($_.Name -like 'python*.exe' -and $_.CommandLine -match '\b(shop|phone)\.py\b' -and $_.CommandLine -notmatch '\bshop\.py admin\b') -or ($_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine.ToLower().Contains($main) -and $_.CommandLine -notmatch 'main\.js\W+admin\b') -or ($_.Name -eq 'cloudflared.exe' -and $_.CommandLine -match 'inspection\.yml') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
timeout /t 2 /nobreak >nul
rem Then wait (up to about 10 s) until nothing listens on port 8081: the old server's socket can linger a moment.
for /l %%i in (1,1,10) do (
  netstat -ano -p tcp | findstr /r /c:":8081 .*LISTENING" >nul || goto port_free
  ping -n 2 127.0.0.1 >nul
)
:port_free

rem Today's date and the time, the same on any Windows language setting.
set "today="
set "now="
for /f "tokens=1,2" %%a in ('%PS% -NoProfile -Command "(Get-Date).ToString('yyyy-MM-dd HH:mm:ss', [Globalization.CultureInfo]::InvariantCulture)"') do set "today=%%a" & set "now=%%b"
if defined today if exist tickets.db if not exist "tickets-backup-%today%.db" call :backup

tasklist | find /i "ollama" >nul || start "" /min ollama serve

rem The shop server. If the TypeScript server isn't built yet (see README), the Python one keeps the shop up.
if /i "%~1"=="python" (
  start "" pythonw shop.py
) else if exist shop-web\apps\api\dist\main.js (
  start "Shop server" /min cmd /c shop-web\tools\run-shop.cmd
) else (
  >>shop.log echo %today% %now% start-shop: shop-web\apps\api\dist\main.js is missing, so the Python server was started
  start "" pythonw shop.py
)
start "" pythonw phone.py --tunnel
exit /b 0

:backup
rem The day's copy, with SQLite's own backup (a consistent copy even if the Shop tickets window has the file
rem open), checked, written to a .tmp and renamed only when it all worked. A failure is logged; the shop still starts.
del "tickets-backup-%today%.tmp" 2>nul
python -I -c "import sqlite3, sys; src = sqlite3.connect('file:tickets.db?mode=ro', uri=True); dst = sqlite3.connect(sys.argv[1]); src.backup(dst); ok = dst.execute('PRAGMA quick_check').fetchone()[0] == 'ok'; dst.close(); src.close(); sys.exit(0 if ok else 1)" "tickets-backup-%today%.tmp"
if errorlevel 1 goto backup_failed
move /y "tickets-backup-%today%.tmp" "tickets-backup-%today%.db" >nul
if errorlevel 1 goto backup_failed
exit /b 0
:backup_failed
del "tickets-backup-%today%.tmp" 2>nul
>>shop.log echo %today% %now% start-shop: the copy of tickets.db failed; starting the shop anyway
exit /b 0
