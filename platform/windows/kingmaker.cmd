@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Kingmaker needs Node 24 or newer. No runtime is downloaded automatically. 1>&2
  exit /b 78
)
node "%~dp0portable-verify.mjs" verify "%~dp0." windows >nul
if errorlevel 1 exit /b 78
node "%~dp0engine\lib\kingmaker.mjs" %*
exit /b %errorlevel%
