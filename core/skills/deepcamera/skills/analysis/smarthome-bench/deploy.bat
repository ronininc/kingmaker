@echo off
REM SmartHome-Bench deployment script (Windows)
REM Called by Aegis deployment agent during skill installation

setlocal enabledelayedexpansion

set "SKILL_DIR=%~dp0"
if "%SKILL_DIR:~-1%"=="\" set "SKILL_DIR=%SKILL_DIR:~0,-1%"
echo Deploying SmartHome-Bench from: %SKILL_DIR%

REM ── Check system dependencies ────────────────────────────────────────────────

echo Checking system dependencies...

where yt-dlp >nul 2>&1
if %errorlevel% neq 0 (
    echo WARNING: yt-dlp not found. Attempting install via pip...
    where pip >nul 2>&1
    if !errorlevel! equ 0 (
        pip install yt-dlp
    ) else (
        where pip3 >nul 2>&1
        if !errorlevel! equ 0 (
            pip3 install yt-dlp
        ) else (
            echo ERROR: Cannot install yt-dlp automatically. Please install manually:
            echo   pip install yt-dlp
            echo   OR download from https://github.com/yt-dlp/yt-dlp/releases
            exit /b 1
        )
    )
)

REM Verify yt-dlp is now available
where yt-dlp >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: yt-dlp installation failed
    exit /b 1
)
for /f "tokens=*" %%V in ('yt-dlp --version 2^>nul') do echo   yt-dlp: %%V

where ffmpeg >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: ffmpeg not found. Please install manually:
    echo   winget install ffmpeg
    echo   OR download from https://ffmpeg.org/download.html
    exit /b 1
)
for /f "tokens=1-3" %%A in ('ffmpeg -version 2^>^&1') do (
    if "%%A"=="ffmpeg" echo   ffmpeg: %%B %%C
    goto :ffmpeg_done
)
:ffmpeg_done

REM ── Install npm dependencies ─────────────────────────────────────────────────

echo Installing npm dependencies...

where npm >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: npm not found. Install Node.js from https://nodejs.org and retry.
    exit /b 1
)

cd /d "%SKILL_DIR%"
npm install --production
if %errorlevel% neq 0 (
    echo ERROR: npm install failed
    exit /b 1
)

echo SmartHome-Bench deployed successfully

endlocal
exit /b 0
