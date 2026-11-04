@echo off
setlocal
where node.exe >nul 2>nul || (echo Kingmaker requires Node.js 22 or newer. 1>&2 & exit /b 2)
node.exe "%~dp0engine\lib\kingmaker.mjs" %*
exit /b %ERRORLEVEL%
