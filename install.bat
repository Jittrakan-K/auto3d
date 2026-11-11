@echo off
setlocal
cd /d "%~dp0"
title AUTO DESIGN 3D setup
set "PY="
for %%V in (3.12 3.13 3.11 3.10) do if not defined PY py -%%V -c "pass" >nul 2>&1 && set "PY=py -%%V"
if not defined PY python -c "import sys; sys.exit(0 if (3,10)<=sys.version_info[:2]<=(3,13) else 1)" >nul 2>&1 && set "PY=python"
if defined PY goto have_python
echo Python 3.10 to 3.13 was not found. Installing Python 3.12...
winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements
set "LAUNCHER=%LOCALAPPDATA%\Programs\Python\Launcher\py.exe"
if exist "%LAUNCHER%" set "PY="%LAUNCHER%" -3.12"
if not defined PY py -3.12 -c "pass" >nul 2>&1 && set "PY=py -3.12"
if defined PY goto have_python
echo Could not install Python automatically.
echo Install Python 3.12 from python.org, then run install.bat again.
pause
exit /b 1
:have_python
echo Using %PY%
if not exist ".venv\Scripts\python.exe" %PY% -m venv .venv
if errorlevel 1 goto failed
".venv\Scripts\python.exe" -m pip install --upgrade pip
if errorlevel 1 goto failed
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 goto failed
call "%~dp0setup_web_link.bat" quiet
echo.
echo Setup finished. Double-click start.bat to open AUTO DESIGN 3D.
pause
exit /b 0
:failed
echo.
echo Setup failed. Copy the error above and send it to Claude.
pause
exit /b 1
