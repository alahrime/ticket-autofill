@echo off
rem One click (re)starts everything the phones need:
rem   the shop tickets server (127.0.0.1:8081: /admin, /tech): the TypeScript server in shop-web
rem     (shop-web\apps\api\dist\main.js, kept running by shop-web\tools\run-shop.cmd in a minimised window),
rem   the phone page and the Cloudflare tunnel (phone.py --tunnel, for shop. and inspect.japaneseautoservice1.com), and Ollama.
rem   start-shop.bat python   starts the old Python server (pythonw shop.py) instead: the one-step rollback.
rem Any copy already running (Python or TypeScript) is stopped first, so this is also how to restart after an update or a password reset.
rem Once a day it first copies tickets.db to tickets-backup-YYYY-MM-DD.db (kept on this PC, git-ignored).
rem It never touches the Ticket Autofill window (app.py) or InvoMax.
rem Put a shortcut to this file in shell:startup to start it all when the PC boots.
cd /d "%~dp0"

rem Stop: first the restart loop (so it can't start node again), then the servers and the tunnel.
rem An "admin <name>" password reset running in a console is left alone.
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -match 'run-shop\.cmd' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { ($_.Name -like 'python*.exe' -and $_.CommandLine -match '\b(shop|phone)\.py\b' -and $_.CommandLine -notmatch '\bshop\.py admin\b') -or ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'shop-web.apps.api.dist.main\.js' -and $_.CommandLine -notmatch 'main\.js\W+admin\b') -or ($_.Name -eq 'cloudflared.exe' -and $_.CommandLine -match 'inspection\.yml') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
timeout /t 2 /nobreak >nul

rem The day's safety copy, taken while no server has tickets.db open; skipped if today's copy is already there.
set "today="
set "now="
for /f "tokens=1,2" %%a in ('powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm:ss'"') do set "today=%%a" & set "now=%%b"
if defined today if exist tickets.db if not exist "tickets-backup-%today%.db" copy /b tickets.db "tickets-backup-%today%.db" >nul

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
