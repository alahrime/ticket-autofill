@echo off
cd /d "%~dp0"
rem NOT read-only: runs one InvoMax recipe per Run click (dry run is on by default). Logs to probe\.
rem Stop: hold Esc or push the mouse into the top-left corner of the screen.
start "" pythonw probe.py trial
