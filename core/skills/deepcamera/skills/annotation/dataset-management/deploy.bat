@echo off
REM deploy.bat — Bootstrapper for Annotation Data Management Skill (Windows)
REM Lightweight — no GPU needed, stdlib-only Python.

setlocal enabledelayedexpansion

set "SKILL_DIR=%~dp0"
if "%SKILL_DIR:~-1%"=="\" set "SKILL_DIR=%SKILL_DIR:~0,-1%"
set "VENV_DIR=%SKILL_DIR%\.venv"
set "LOG_PREFIX=[annotation-data-deploy]"

REM ─── Find Python ───────────────────────────────────────────────────────
set "PYTHON_CMD="
for %%V in (3.12 3.11 3.10 3.9) do (
    if not defined PYTHON_CMD (
        py -%%V --version >nul 2>&1
        if !errorlevel! equ 0 set "PYTHON_CMD=py -%%V"
    )
)
if not defined PYTHON_CMD (
    python3 --version >nul 2>&1
    if !errorlevel! equ 0 set "PYTHON_CMD=python3"
)
if not defined PYTHON_CMD (
    python --version >nul 2>&1
    if !errorlevel! equ 0 set "PYTHON_CMD=python"
)
if not defined PYTHON_CMD (
    echo %LOG_PREFIX% ERROR: No Python found>&2
    echo {"event": "error", "stage": "python", "message": "No Python found"}
    exit /b 1
)

for /f "tokens=*" %%A in ('!PYTHON_CMD! --version 2^>^&1') do set "PY_VERSION=%%A"
echo %LOG_PREFIX% Using Python: %PYTHON_CMD% (%PY_VERSION%)>&2
echo {"event": "progress", "stage": "python", "message": "Found %PY_VERSION%"}

REM ─── Create venv ───────────────────────────────────────────────────────
if not exist "%VENV_DIR%\Scripts\python.exe" (
    %PYTHON_CMD% -m venv "%VENV_DIR%"
)

echo {"event": "progress", "stage": "venv", "message": "Virtual environment ready"}

REM ─── Verify ────────────────────────────────────────────────────────────
"%VENV_DIR%\Scripts\python.exe" -c "import json, pathlib; print('Annotation data skill ready')" 2>&1

echo {"event": "complete", "backend": "cpu", "message": "Annotation data skill installed"}
echo %LOG_PREFIX% Done!>&2

endlocal
exit /b 0
