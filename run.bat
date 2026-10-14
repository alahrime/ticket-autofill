@echo off
cd /d "%~dp0"
tasklist | find /i "ollama" >nul || start "" /min ollama serve
start "" pythonw app.py
