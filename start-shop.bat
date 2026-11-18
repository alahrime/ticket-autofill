@echo off
rem One click (re)starts everything the phones and iPads need:
rem   the shop tickets server (shop.py, 127.0.0.1:8081: /admin, /tech, /checkin),
rem   the phone page and the Cloudflare tunnel (phone.py --tunnel, for shop. and inspect.japaneseautoservice1.com), and Ollama.
rem Any copy already running is stopped first, so this is also how to restart after an update or a password reset.
rem It never touches the Ticket Autofill window (app.py) or InvoMax.
rem Put a shortcut to this file in shell:startup to start it all when the PC boots.
cd /d "%~dp0"
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { ($_.Name -like 'python*.exe' -and $_.CommandLine -match '\b(shop|phone)\.py\b' -and $_.CommandLine -notmatch '\bshop\.py admin\b') -or ($_.Name -eq 'cloudflared.exe' -and $_.CommandLine -match 'inspection\.yml') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
timeout /t 2 /nobreak >nul
tasklist | find /i "ollama" >nul || start "" /min ollama serve
start "" pythonw shop.py
start "" pythonw phone.py --tunnel
