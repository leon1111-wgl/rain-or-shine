@echo off
setlocal
cd /d "%~dp0"
if not exist "app\runtime\node.exe" (
  echo Unzip the whole package first, then open START-WINDOWS.cmd again.
  pause
  exit /b 1
)
"app\runtime\node.exe" "app\launcher\serve.mjs" --report "launch-report.log" %*
set "app_exit=%errorlevel%"
if not "%app_exit%"=="0" (
  echo The app stopped. See the message above and READ_FIRST.html.
  pause
)
exit /b %app_exit%
