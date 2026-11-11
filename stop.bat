@echo off
rem Stops the AUTO DESIGN 3D app that the web page started in the background.
cd /d "%~dp0"
if not exist "output\app.pid" (
  echo AUTO DESIGN 3D is not running.
  pause
  exit /b 0
)
set /p PID=<"output\app.pid"
taskkill /pid %PID% /f >nul 2>&1 && echo AUTO DESIGN 3D stopped. || echo AUTO DESIGN 3D was not running.
del "output\app.pid" >nul 2>&1
pause
