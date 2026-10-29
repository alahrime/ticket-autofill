@echo off
rem Shop tickets: desk iPad (/desk) and mechanic phones (/tech) on the shop Wi-Fi at http://<this PC>:8081.
rem Online through the inspection tunnel once the owner adds the shop hostname (see README). Log in shop.log.
cd /d "%~dp0"
start "" pythonw shop.py
