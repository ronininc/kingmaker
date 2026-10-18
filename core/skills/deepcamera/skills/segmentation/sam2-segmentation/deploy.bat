@echo off
REM deploy.bat — Bootstrapper for SAM2 Segmentation Skill (Windows)
REM
REM Creates venv, installs dependencies, downloads model checkpoint.
REM Called by Aegis skill-runtime-manager during installation.
REM
REM Exit codes:
REM   0  = success
REM   1  = fatal error

setlocal enabledelayedexpansion

set "SKILL_DIR=%~dp0"
REM Remove trailing backslash
if "%SKILL_DIR:~-1%"=="\" set "SKILL_DIR=%SKILL_DIR:~0,-1%"
set "VENV_DIR=%SKILL_DIR%\.venv"
set "MODELS_DIR=%SKILL_DIR%\models"
set "LOG_PREFIX=[SAM2-deploy]"

REM ─── Step 1: Find Python ───────────────────────────────────────────────────

echo %LOG_PREFIX% Searching for Python...>&2

set "PYTHON_CMD="

REM Try the Windows Python launcher (py.exe) first
for %%V in (3.12 3.11 3.10 3.9) do (
    if not defined PYTHON_CMD (
        py -%%V --version >nul 2>&1
        if !errorlevel! equ 0 (
            set "PYTHON_CMD=py -%%V"
        )
    )
)

REM Fallback: bare python3 / python on PATH
if not defined PYTHON_CMD (
    python3 --version >nul 2>&1
    if !errorlevel! equ 0 (
        for /f "tokens=2 delims= " %%A in ('python3 --version 2^>^&1') do set "_pyver=%%A"
        for /f "tokens=1,2 delims=." %%A in ("!_pyver!") do (
            if %%A geq 3 if %%B geq 9 set "PYTHON_CMD=python3"
        )
    )
)

if not defined PYTHON_CMD (
    python --version >nul 2>&1
    if !errorlevel! equ 0 (
        for /f "tokens=2 delims= " %%A in ('python --version 2^>^&1') do set "_pyver=%%A"
        for /f "tokens=1,2 delims=." %%A in ("!_pyver!") do (
            if %%A geq 3 if %%B geq 9 set "PYTHON_CMD=python"
        )
    )
)

if not defined PYTHON_CMD (
    echo %LOG_PREFIX% ERROR: No Python ^>=3.9 found. Install Python 3.9+ and retry.>&2
    echo {"event": "error", "stage": "python", "message": "No Python >=3.9 found"}
    exit /b 1
)

for /f "tokens=*" %%A in ('!PYTHON_CMD! --version 2^>^&1') do set "PY_VERSION=%%A"
echo %LOG_PREFIX% Using Python: %PYTHON_CMD% (%PY_VERSION%)>&2
echo {"event": "progress", "stage": "python", "message": "Found %PY_VERSION%"}

REM ─── Step 2: Create virtual environment ────────────────────────────────────

if not exist "%VENV_DIR%\Scripts\python.exe" (
    echo %LOG_PREFIX% Creating virtual environment...>&2
    %PYTHON_CMD% -m venv "%VENV_DIR%"
    if !errorlevel! neq 0 (
        echo %LOG_PREFIX% ERROR: Failed to create virtual environment>&2
        echo {"event": "error", "stage": "venv", "message": "Failed to create venv"}
        exit /b 1
    )
)

set "PIP=%VENV_DIR%\Scripts\pip.exe"
set "VPYTHON=%VENV_DIR%\Scripts\python.exe"

"%PIP%" install --upgrade pip -q >nul 2>&1

echo {"event": "progress", "stage": "venv", "message": "Virtual environment ready"}

REM ─── Step 3: Detect GPU and install dependencies ───────────────────────────

set "BACKEND=cpu"

REM Check for NVIDIA GPU
where nvidia-smi >nul 2>&1
if !errorlevel! equ 0 (
    for /f "tokens=*" %%G in ('nvidia-smi --query-gpu^=driver_version --format^=csv^,noheader 2^>nul') do (
        if not "%%G"=="" (
            set "BACKEND=cuda"
            echo %LOG_PREFIX% Detected NVIDIA GPU ^(driver: %%G^)>&2
        )
    )
)

echo {"event": "progress", "stage": "gpu", "backend": "!BACKEND!", "message": "Compute backend: !BACKEND!"}

echo %LOG_PREFIX% Installing dependencies...>&2
echo {"event": "progress", "stage": "install", "message": "Installing SAM2 dependencies..."}

REM Install PyTorch first (platform-specific)
if "!BACKEND!"=="cuda" (
    "%PIP%" install torch torchvision --index-url https://download.pytorch.org/whl/cu124 -q 2>&1 | findstr /V "^$" >nul
    if !errorlevel! neq 0 (
        echo %LOG_PREFIX% WARNING: cu124 failed, trying cu121...>&2
        "%PIP%" install torch torchvision --index-url https://download.pytorch.org/whl/cu121 -q 2>&1 | findstr /V "^$" >nul
    )
) else (
    "%PIP%" install torch torchvision --index-url https://download.pytorch.org/whl/cpu -q 2>&1 | findstr /V "^$" >nul
)

REM Install remaining deps
"%PIP%" install -r "%SKILL_DIR%\requirements.txt" -q 2>&1 | findstr /V "^$" >nul

echo {"event": "progress", "stage": "install", "message": "Dependencies installed"}

REM ─── Step 4: Download default model checkpoint ────────────────────────────

if not exist "%MODELS_DIR%" mkdir "%MODELS_DIR%"

set "CHECKPOINT_FILE=%MODELS_DIR%\sam2-small.pt"
set "CHECKPOINT_URL=https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_small.pt"

if not exist "%CHECKPOINT_FILE%" (
    echo %LOG_PREFIX% Downloading SAM2 model checkpoint...>&2
    echo {"event": "progress", "stage": "model", "message": "Downloading SAM2 model (~180MB)..."}

    REM Try PowerShell download (available on all modern Windows)
    powershell -NoProfile -Command "Invoke-WebRequest -Uri '%CHECKPOINT_URL%' -OutFile '%CHECKPOINT_FILE%'" 2>&1

    if exist "%CHECKPOINT_FILE%" (
        echo %LOG_PREFIX% Model downloaded: %CHECKPOINT_FILE%>&2
        echo {"event": "progress", "stage": "model", "message": "Model downloaded"}
    ) else (
        echo %LOG_PREFIX% ERROR: Model download failed>&2
        echo {"event": "error", "stage": "model", "message": "Model download failed"}
        exit /b 1
    )
) else (
    echo %LOG_PREFIX% Model checkpoint already exists>&2
    echo {"event": "progress", "stage": "model", "message": "Model already downloaded"}
)

REM ─── Step 5: Verify installation ───────────────────────────────────────────

echo %LOG_PREFIX% Verifying installation...>&2
"%VPYTHON%" -c "import torch, numpy, cv2; print(f'PyTorch {torch.__version__}'); print(f'CUDA: {torch.cuda.get_device_name(0)}' if torch.cuda.is_available() else 'Device: CPU')" 2>&1

echo {"event": "complete", "backend": "!BACKEND!", "message": "SAM2 segmentation skill installed (!BACKEND! backend)"}
echo %LOG_PREFIX% Done! Backend: !BACKEND!>&2

endlocal
exit /b 0
