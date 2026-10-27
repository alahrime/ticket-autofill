@echo off
cd /d "%~dp0"
rem Read-only: watches InvoMax and logs what changes to probe\. Never clicks, types or saves.
python probe.py watch
