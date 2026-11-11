@echo off
rem Opened by the web page through the autodesign3d:// link. Starts the local app
rem without a window. If it is already running, the new copy exits by itself.
cd /d "%~dp0"
if not exist ".venv\Scripts\pythonw.exe" exit /b 1
set "AUTODESIGN_NO_BROWSER=1"
start "" ".venv\Scripts\pythonw.exe" -m app.main
exit /b 0
