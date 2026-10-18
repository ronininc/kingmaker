@echo off
REM HomeSafe-Bench deployment script (Windows)
REM Runs npm install to fetch openai SDK dependency

cd /d "%~dp0"

where npm >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: npm not found. Install Node.js from https://nodejs.org and retry.
    exit /b 1
)

npm install
if %errorlevel% neq 0 (
    echo ERROR: npm install failed
    exit /b 1
)

echo HomeSafe-Bench dependencies installed
exit /b 0
