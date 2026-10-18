@echo off
setlocal enabledelayedexpansion
REM ═══════════════════════════════════════════════════════════════════
REM  Depth Estimation Skill — Windows Deployment (ONNX Runtime)
REM
REM  GPU detection cascade:
REM    1. nvidia-smi found → onnxruntime-gpu (CUDA + TensorRT EPs)
REM    2. Non-NVIDIA GPU found (WMI) → onnxruntime-directml
REM    3. No GPU → onnxruntime (CPU)
REM
REM  Then downloads ONNX model from HuggingFace.
REM ═══════════════════════════════════════════════════════════════════

echo [DepthDeploy] Starting depth-estimation skill deployment...
echo [DepthDeploy] Platform: Windows (%PROCESSOR_ARCHITECTURE%)

REM ── 1. Find Python ─────────────────────────────────────────────────
set "PYTHON_CMD="

REM Try py launcher first (most reliable on Windows)
py --version >nul 2>&1
if %ERRORLEVEL% equ 0 (
    set "PYTHON_CMD=py"
    goto :found_python
)

REM Try python (could be Python 3 on PATH)
python --version >nul 2>&1
if %ERRORLEVEL% equ 0 (
    set "PYTHON_CMD=python"
    goto :found_python
)

echo [DepthDeploy] ERROR: Python not found. Install Python 3.9+ from python.org
exit /b 1

:found_python
echo [DepthDeploy] Using Python: %PYTHON_CMD%
%PYTHON_CMD% --version

REM ── 2. Create venv ─────────────────────────────────────────────────
if not exist ".venv\Scripts\python.exe" (
    echo [DepthDeploy] Creating virtual environment...
    %PYTHON_CMD% -m venv .venv
    if %ERRORLEVEL% neq 0 (
        echo [DepthDeploy] ERROR: Failed to create venv
        exit /b 1
    )
)

set "VENV_PIP=.venv\Scripts\pip.exe"
set "VENV_PYTHON=.venv\Scripts\python.exe"

echo [DepthDeploy] Upgrading pip...
%VENV_PYTHON% -m pip install --upgrade pip >nul 2>&1

REM ── 3. Detect GPU ──────────────────────────────────────────────────
echo [DepthDeploy] Detecting GPU hardware...

set "GPU_BACKEND=cpu"
set "REQUIREMENTS_FILE=requirements_cpu.txt"

REM 3a. Check for NVIDIA GPU via nvidia-smi
nvidia-smi --query-gpu=name --format=csv,noheader,nounits >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo [DepthDeploy] NVIDIA GPU detected:
    nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits
    set "GPU_BACKEND=cuda"
    set "REQUIREMENTS_FILE=requirements_cuda.txt"
    goto :gpu_detected
)

REM 3b. Check for any GPU via WMI (AMD, Intel, Qualcomm)
for /f "tokens=*" %%G in ('powershell -NoProfile -Command "Get-CimInstance Win32_VideoController | Where-Object { $_.Name -notlike '*Microsoft*' -and $_.Name -notlike '*Remote*' } | Select-Object -ExpandProperty Name" 2^>nul') do (
    echo [DepthDeploy] GPU found: %%G
    set "GPU_BACKEND=directml"
    set "REQUIREMENTS_FILE=requirements_directml.txt"
)

:gpu_detected
echo [DepthDeploy] Selected backend: %GPU_BACKEND%
echo [DepthDeploy] Requirements: %REQUIREMENTS_FILE%

REM ── 4. Install dependencies ────────────────────────────────────────
if not exist "%REQUIREMENTS_FILE%" (
    echo [DepthDeploy] WARNING: %REQUIREMENTS_FILE% not found, falling back to requirements_cpu.txt
    set "REQUIREMENTS_FILE=requirements_cpu.txt"
)

echo [DepthDeploy] Installing %REQUIREMENTS_FILE%...
%VENV_PIP% install -r %REQUIREMENTS_FILE%
if %ERRORLEVEL% neq 0 (
    echo [DepthDeploy] WARNING: Install failed for %REQUIREMENTS_FILE%
    if not "%GPU_BACKEND%"=="cpu" (
        echo [DepthDeploy] Falling back to CPU requirements...
        %VENV_PIP% install -r requirements_cpu.txt
    )
)

REM ── 5. Download ONNX model ─────────────────────────────────────────
echo [DepthDeploy] Downloading ONNX model from HuggingFace...

set "MODELS_DIR=%USERPROFILE%\.aegis-ai\models\feature-extraction"
if not exist "%MODELS_DIR%" mkdir "%MODELS_DIR%"

if exist "%MODELS_DIR%\model.onnx" (
    echo [DepthDeploy] ONNX model already exists at %MODELS_DIR%\model.onnx
) else (
    %VENV_PYTHON% -c "from huggingface_hub import hf_hub_download; import shutil, os; p = hf_hub_download('onnx-community/depth-anything-v2-small', 'onnx/model.onnx'); d = os.path.join(os.path.expanduser('~'), '.aegis-ai', 'models', 'feature-extraction', 'model.onnx'); shutil.copy2(p, d); print(f'[DepthDeploy] Model copied to {d}')"
    if %ERRORLEVEL% equ 0 (
        echo [DepthDeploy] ONNX model downloaded successfully
    ) else (
        echo [DepthDeploy] WARNING: Model download failed — will retry on first run
    )
)

REM ── 6. Verify installation ─────────────────────────────────────────
echo [DepthDeploy] Verifying ONNX Runtime installation...

%VENV_PYTHON% -c "import onnxruntime as ort; eps = ort.get_available_providers(); print(f'[DepthDeploy] Available EPs: {eps}')"
if %ERRORLEVEL% neq 0 (
    echo [DepthDeploy] ERROR: ONNX Runtime import failed
    exit /b 1
)

REM Log detected execution providers
%VENV_PYTHON% -c "import onnxruntime as ort; eps = ort.get_available_providers(); cuda = 'CUDAExecutionProvider' in eps; trt = 'TensorrtExecutionProvider' in eps; dml = 'DmlExecutionProvider' in eps; print(f'[DepthDeploy] CUDA EP: {cuda}, TensorRT EP: {trt}, DirectML EP: {dml}')"

echo [DepthDeploy] Deployment complete (%GPU_BACKEND% backend)
exit /b 0
