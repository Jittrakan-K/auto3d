@echo off
cd /d "%~dp0"
title AUTO DESIGN 3D
if not exist ".venv\Scripts\python.exe" (
  echo Run install.bat first.
  pause
  exit /b 1
)
echo AUTO DESIGN 3D is starting. Keep this window open while you use it.
".venv\Scripts\python.exe" -m app.main
pause
