@echo off
rem Phone page only (no InvoMax window), online at https://inspect.japaneseautoservice1.com.
rem phone.py runs the Cloudflare tunnel itself (no window) and restarts it if it stops; log in cloudflared.log.
cd /d "%~dp0"
tasklist | find /i "ollama" >nul || start "" /min ollama serve
start "" pythonw phone.py --tunnel
