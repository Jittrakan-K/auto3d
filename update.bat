@echo off
rem Downloads the newest AUTO DESIGN 3D from GitHub into this folder.
rem Keeps .venv, .env and output. No GitHub Desktop needed.
setlocal
cd /d "%~dp0"
title AUTO DESIGN 3D update
if exist "output\app.pid" (
  set /p PID=<"output\app.pid"
  taskkill /pid %PID% /f >nul 2>&1
  del "output\app.pid" >nul 2>&1
)
echo Downloading the newest version...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "$z=Join-Path $env:TEMP 'auto3d-main.zip'; $d=Join-Path $env:TEMP 'auto3d-update';" ^
  "[Net.ServicePointManager]::SecurityProtocol='Tls12';" ^
  "Invoke-WebRequest 'https://github.com/Jittrakan-K/auto3d/archive/refs/heads/main.zip' -OutFile $z -UseBasicParsing;" ^
  "if (Test-Path $d) { Remove-Item $d -Recurse -Force }; Expand-Archive $z $d -Force;" ^
  "robocopy (Join-Path $d 'auto3d-main') '%~dp0.' /E /XD .venv output .git /XF .env /NFL /NDL /NJH /NJS /NP | Out-Null;" ^
  "if ($LASTEXITCODE -ge 8) { throw 'copy failed' }"
if errorlevel 1 goto failed
if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" -m pip install -q -r requirements.txt
  if errorlevel 1 goto failed
  call "%~dp0setup_web_link.bat" quiet
  echo.
  echo Updated. You can close this window.
) else (
  echo.
  echo Files updated. Now double-click install.bat once to finish setup.
)
pause
exit /b 0
:failed
echo.
echo Update failed. Copy the error above and send it to Claude.
pause
exit /b 1
