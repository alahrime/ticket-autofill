@echo off
rem Shop tickets on https://shop.japaneseautoservice1.com: /checkin (customer iPad), /tech (mechanics), /admin (owner).
rem Listens on 127.0.0.1:8081 only; the public link comes through the tunnel that phone.bat runs, so run both. Log in shop.log.
cd /d "%~dp0"
start "" pythonw shop.py
