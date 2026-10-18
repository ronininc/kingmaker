@echo off
REM deploy.bat — Zero-assumption bootstrapper for YOLO 2026 Detection Skill (Windows)
REM
REM Probes the system for Python, GPU backends, and installs the minimum
REM viable stack. Called by Aegis skill-runtime-manager during installation.
REM
REM Uses skills\lib\env_config.py for hardware detection and model optimization.
REM
REM Exit codes:
REM   0  = success
REM   1  = fatal error (no Python found)
REM   2  = partial success (CPU-only fallback)

setlocal enabledelayedexpansion

set "SKILL_DIR=%~dp0"
REM Remove trailing backslash
if "%SKILL_DIR:~-1%"=="\" set "SKILL_DIR=%SKILL_DIR:~0,-1%"
set "VENV_DIR=%SKILL_DIR%\.venv"
set "LOG_PREFIX=[YOLO-2026-deploy]"

REM Resolve lib dir (two levels up + lib)
set "LIB_DIR="
if exist "%SKILL_DIR%\..\..\lib\env_config.py" (
    pushd "%SKILL_DIR%\..\..\lib"
    set "LIB_DIR=!CD!"
    popd
)

REM ─── Step 1: Find Python ───────────────────────────────────────────────────

echo %LOG_PREFIX% Searching for Python...>&2

set "PYTHON_CMD="

REM Try the Windows Python launcher (py.exe) first — ships with python.org installer
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
        REM Verify version >= 3.9
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

REM ─── Step 2.5: Bundle env_config.py alongside detect.py ────────────────────

if defined LIB_DIR (
    if exist "%LIB_DIR%\env_config.py" (
        copy /Y "%LIB_DIR%\env_config.py" "%SKILL_DIR%\scripts\env_config.py" >nul 2>&1
        echo %LOG_PREFIX% Bundled env_config.py into scripts\>&2
    )
)

REM ─── Step 3: Detect hardware via env_config ────────────────────────────────

set "BACKEND=cpu"

REM Find env_config.py — bundled copy or repo lib\
set "ENV_CONFIG_DIR="
if exist "%SKILL_DIR%\scripts\env_config.py" (
    set "ENV_CONFIG_DIR=%SKILL_DIR%\scripts"
) else if defined LIB_DIR (
    if exist "%LIB_DIR%\env_config.py" (
        set "ENV_CONFIG_DIR=%LIB_DIR%"
    )
)

if defined ENV_CONFIG_DIR (
    echo %LOG_PREFIX% Detecting hardware via env_config.py...>&2

    REM Run env_config detection via Python (temp file avoids for /f quoting issues)
    set "ENV_CONFIG_DIR=!ENV_CONFIG_DIR!"
    set "_TMPBACK=%TEMP%\_aegis_detect_backend.txt"
    "%VPYTHON%" -c "import sys,os; sys.path.insert(0, os.environ['ENV_CONFIG_DIR']); from env_config import HardwareEnv; env = HardwareEnv.detect(); print(env.backend)" > "!_TMPBACK!" 2>nul
    if exist "!_TMPBACK!" (
        set /p DETECTED_BACKEND=<"!_TMPBACK!"
        del "!_TMPBACK!" 2>nul
    )

    REM Validate backend value (Windows: only cuda, intel, cpu are realistic)
    if "!DETECTED_BACKEND!"=="cuda" (
        set "BACKEND=cuda"
    ) else if "!DETECTED_BACKEND!"=="intel" (
        set "BACKEND=intel"
    ) else if "!DETECTED_BACKEND!"=="cpu" (
        set "BACKEND=cpu"
    ) else (
        echo %LOG_PREFIX% env_config returned '!DETECTED_BACKEND!', falling back to heuristic>&2
        set "BACKEND=cpu"
    )

    echo %LOG_PREFIX% env_config detected backend: !BACKEND!>&2
) else (
    echo %LOG_PREFIX% env_config.py not found, using heuristic detection...>&2

    REM Fallback: inline GPU detection via nvidia-smi
    where nvidia-smi >nul 2>&1
    if !errorlevel! equ 0 (
        for /f "tokens=*" %%G in ('nvidia-smi --query-gpu^=driver_version --format^=csv^,noheader 2^>nul') do (
            if not "%%G"=="" (
                set "BACKEND=cuda"
                echo %LOG_PREFIX% Detected NVIDIA GPU ^(driver: %%G^)>&2
            )
        )
    )
)

echo {"event": "progress", "stage": "gpu", "backend": "!BACKEND!", "message": "Compute backend: !BACKEND!"}

REM ─── Step 4: Install requirements ──────────────────────────────────────────

set "REQ_FILE=%SKILL_DIR%\requirements_!BACKEND!.txt"

if not exist "!REQ_FILE!" (
    echo %LOG_PREFIX% WARNING: !REQ_FILE! not found, falling back to CPU>&2
    set "REQ_FILE=%SKILL_DIR%\requirements_cpu.txt"
    set "BACKEND=cpu"
)

echo %LOG_PREFIX% Installing dependencies from !REQ_FILE! ...>&2
echo {"event": "progress", "stage": "install", "message": "Installing !BACKEND! dependencies..."}

if "!BACKEND!"=="cuda" (
    REM CUDA on Windows: install torch with CUDA index, then remaining deps
    "%PIP%" install torch torchvision --index-url https://download.pytorch.org/whl/cu124 -q 2>&1 | findstr /V "^$" >nul
    if !errorlevel! neq 0 (
        echo %LOG_PREFIX% WARNING: CUDA torch install failed, trying cu121...>&2
        "%PIP%" install torch torchvision --index-url https://download.pytorch.org/whl/cu121 -q 2>&1 | findstr /V "^$" >nul
    )
    REM Install remaining requirements (ultralytics, etc.)
    "%PIP%" install -r "!REQ_FILE!" -q 2>&1 | findstr /V "^$" >nul
) else (
    "%PIP%" install -r "!REQ_FILE!" -q 2>&1 | findstr /V "^$" >nul
)

REM ─── Step 5: Pre-convert model to optimized format ─────────────────────────

if "!BACKEND!" neq "cpu" (
    echo %LOG_PREFIX% Pre-converting model to optimized format for !BACKEND!...>&2
    echo {"event": "progress", "stage": "optimize", "message": "Converting model for !BACKEND! (~30-120s)..."}

    "%VPYTHON%" -c "import sys,os; sys.path.insert(0, os.environ['ENV_CONFIG_DIR']); from env_config import HardwareEnv; env = HardwareEnv.detect(); from ultralytics import YOLO; model = YOLO('yolo26n.pt'); result = env.export_model(model, 'yolo26n'); print(f'Optimized model exported: {result}' if result else 'Export skipped or failed')" 2>&1

    if !errorlevel! equ 0 (
        echo {"event": "progress", "stage": "optimize", "message": "Model optimization complete"}
    ) else (
        echo %LOG_PREFIX% WARNING: Model optimization failed, will use PyTorch at runtime>&2
        echo {"event": "progress", "stage": "optimize", "message": "Optimization failed — PyTorch fallback"}
    )
) else if exist "%SKILL_DIR%\requirements_cpu.txt" (
    echo %LOG_PREFIX% Pre-converting model to ONNX for CPU...>&2
    echo {"event": "progress", "stage": "optimize", "message": "Converting model for cpu (~30-120s)..."}

    "%VPYTHON%" -c "import sys,os; sys.path.insert(0, os.environ['ENV_CONFIG_DIR']); from env_config import HardwareEnv; env = HardwareEnv.detect(); from ultralytics import YOLO; model = YOLO('yolo26n.pt'); result = env.export_model(model, 'yolo26n'); print(f'Optimized model exported: {result}' if result else 'Export skipped or failed')" 2>&1

    if !errorlevel! equ 0 (
        echo {"event": "progress", "stage": "optimize", "message": "Model optimization complete"}
    ) else (
        echo %LOG_PREFIX% WARNING: Model optimization failed, will use PyTorch at runtime>&2
        echo {"event": "progress", "stage": "optimize", "message": "Optimization failed — PyTorch fallback"}
    )
)

REM ─── Step 6: Verify installation ───────────────────────────────────────────

echo %LOG_PREFIX% Verifying installation...>&2
"%VPYTHON%" -c "import sys,os,json; sys.path.insert(0, os.environ['ENV_CONFIG_DIR']); from env_config import HardwareEnv; env = HardwareEnv.detect(); print(json.dumps(env.to_dict(), indent=2))" 2>&1

echo {"event": "complete", "backend": "!BACKEND!", "message": "YOLO 2026 skill installed (!BACKEND! backend)"}
echo %LOG_PREFIX% Done! Backend: !BACKEND!>&2

endlocal
exit /b 0
