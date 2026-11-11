@echo off
rem Lets the AUTO DESIGN 3D web page start this app with one click (autodesign3d:// link).
rem Writes only to your own user settings, no administrator rights needed.
cd /d "%~dp0"
set "LAUNCH=%~dp0launch.bat"
reg add "HKCU\Software\Classes\autodesign3d" /ve /d "URL:AUTO DESIGN 3D" /f >nul
reg add "HKCU\Software\Classes\autodesign3d" /v "URL Protocol" /d "" /f >nul
reg add "HKCU\Software\Classes\autodesign3d\DefaultIcon" /ve /d "%SystemRoot%\System32\shell32.dll,12" /f >nul
reg add "HKCU\Software\Classes\autodesign3d\shell\open\command" /ve /d "\"%LAUNCH%\" \"%%1\"" /f >nul
if errorlevel 1 (
  echo Could not register the web link.
  if not "%~1"=="quiet" pause
  exit /b 1
)
echo The web page can now start AUTO DESIGN 3D on this computer.
if not "%~1"=="quiet" pause
exit /b 0
