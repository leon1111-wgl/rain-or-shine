@echo off
setlocal
cd /d "%~dp0"
if not exist "app\runtime\node.exe" (
  echo Unzip the whole package first, then open GET-WEATHER.cmd again.
  pause
  exit /b 1
)
"app\runtime\node.exe" "app\tools\get-weather-evidence.mjs" %*
set "app_exit=%errorlevel%"
if "%~1"=="" pause
exit /b %app_exit%
