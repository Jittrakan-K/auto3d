@echo off
cd /d "%~dp0"
title AUTO DESIGN 3D SOLIDWORKS test
if not exist ".venv\Scripts\python.exe" (
  echo Run install.bat first.
  pause
  exit /b 1
)
".venv\Scripts\python.exe" -m app.sw_selftest
echo.
echo Results are saved in sw_test_log.txt
pause
