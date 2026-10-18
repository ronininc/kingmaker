#!/usr/bin/env bash
# deploy.sh — Zero-assumption bootstrapper for YOLO 2026 Detection Skill
#
# Probes the system for Python, GPU backends, and installs the minimum
# viable stack. Called by Aegis skill-runtime-manager during installation.
#
# Uses skills/lib/env_config.py for hardware detection and model optimization.
#
# Exit codes:
#   0  = success
#   1  = fatal error (no Python found and cannot install)
#   2  = partial success (CPU-only fallback)

set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_DIR="$SKILL_DIR/.venv"
LIB_DIR="$(cd "$SKILL_DIR/../../lib" 2>/dev/null && pwd || echo "")"
LOG_PREFIX="[YOLO-2026-deploy]"

log()  { echo "$LOG_PREFIX $*" >&2; }
emit() { echo "$1"; }  # JSON to stdout for Aegis to parse

# ─── Step 1: Find or install Python ─────────────────────────────────────────

find_python() {
    for cmd in python3.12 python3.11 python3.10 python3.9 python3; do
        if command -v "$cmd" &>/dev/null; then
            local ver
            ver="$("$cmd" --version 2>&1 | grep -oE '[0-9]+\.[0-9]+')"
            local major minor
            major=$(echo "$ver" | cut -d. -f1)
            minor=$(echo "$ver" | cut -d. -f2)
            if [ "$major" -ge 3 ] && [ "$minor" -ge 9 ]; then
                echo "$cmd"
                return 0
            fi
        fi
    done

    if command -v conda &>/dev/null; then
        log "No system Python >=3.9 found, but conda is available"
        log "Creating conda environment..."
        conda create -n aegis-yolo2026 python=3.11 -y >/dev/null 2>&1
        # shellcheck disable=SC1091
        eval "$(conda shell.bash hook 2>/dev/null)"
        conda activate aegis-yolo2026
        echo "python3"
        return 0
    fi

    if command -v pyenv &>/dev/null; then
        log "No system Python >=3.9 found, using pyenv..."
        pyenv install -s 3.11.9
        pyenv local 3.11.9
        echo "$(pyenv which python3)"
        return 0
    fi

    return 1
}

PYTHON_CMD=$(find_python) || {
    log "ERROR: No Python >=3.9 found. Install Python 3.9+ and retry."
    emit '{"event": "error", "stage": "python", "message": "No Python >=3.9 found"}'
    exit 1
}

log "Using Python: $PYTHON_CMD ($($PYTHON_CMD --version 2>&1))"
emit "{\"event\": \"progress\", \"stage\": \"python\", \"message\": \"Found $($PYTHON_CMD --version 2>&1)\"}"

# ─── Step 2: Create virtual environment ─────────────────────────────────────

if [ ! -d "$VENV_DIR" ]; then
    log "Creating virtual environment..."
    "$PYTHON_CMD" -m venv "$VENV_DIR"
fi

# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"
PIP="$VENV_DIR/bin/pip"

"$PIP" install --upgrade pip -q 2>/dev/null || true

emit '{"event": "progress", "stage": "venv", "message": "Virtual environment ready"}'

# ─── Step 2.5: Bundle env_config.py alongside detect.py ─────────────────────

if [ -n "$LIB_DIR" ] && [ -f "$LIB_DIR/env_config.py" ]; then
    cp "$LIB_DIR/env_config.py" "$SKILL_DIR/scripts/env_config.py"
    log "Bundled env_config.py into scripts/"
fi

# ─── Step 3: Detect hardware via env_config ─────────────────────────────────

BACKEND="cpu"

# Find env_config.py — bundled copy or repo lib/
ENV_CONFIG_DIR=""
if [ -f "$SKILL_DIR/scripts/env_config.py" ]; then
    ENV_CONFIG_DIR="$SKILL_DIR/scripts"
elif [ -n "$LIB_DIR" ] && [ -f "$LIB_DIR/env_config.py" ]; then
    ENV_CONFIG_DIR="$LIB_DIR"
fi

if [ -n "$ENV_CONFIG_DIR" ]; then
    log "Detecting hardware via env_config.py..."
    DETECT_OUTPUT=$("$VENV_DIR/bin/python" -c "
import sys
sys.path.insert(0, '$ENV_CONFIG_DIR')
from env_config import HardwareEnv
env = HardwareEnv.detect()
print(env.backend)
" 2>&1) || true

    # The last line of output is the backend name
    BACKEND=$(echo "$DETECT_OUTPUT" | tail -1)

    # Validate backend value
    case "$BACKEND" in
        cuda|rocm|mps|intel|cpu) ;;
        *)
            log "env_config returned unexpected backend '$BACKEND', falling back to heuristic"
            BACKEND="cpu"
            ;;
    esac

    log "env_config detected backend: $BACKEND"
else
    log "env_config.py not found, using heuristic detection..."

    # Fallback: inline GPU detection
    if command -v nvidia-smi &>/dev/null; then
        cuda_ver=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -1)
        if [ -n "$cuda_ver" ]; then
            BACKEND="cuda"
            log "Detected NVIDIA GPU (driver: $cuda_ver)"
        fi
    elif command -v amd-smi &>/dev/null || command -v rocm-smi &>/dev/null || [ -d "/opt/rocm" ]; then
        BACKEND="rocm"
        log "Detected AMD ROCm"
    elif [ "$(uname)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ]; then
        BACKEND="mps"
        log "Detected Apple Silicon (MPS)"
    fi
fi

emit "{\"event\": \"progress\", \"stage\": \"gpu\", \"backend\": \"$BACKEND\", \"message\": \"Compute backend: $BACKEND\"}"

# ─── Step 4: Install requirements ────────────────────────────────────────────

REQ_FILE="$SKILL_DIR/requirements_${BACKEND}.txt"

if [ ! -f "$REQ_FILE" ]; then
    log "WARNING: $REQ_FILE not found, falling back to CPU"
    REQ_FILE="$SKILL_DIR/requirements_cpu.txt"
    BACKEND="cpu"
fi

log "Installing dependencies from $REQ_FILE ..."
emit "{\"event\": \"progress\", \"stage\": \"install\", \"message\": \"Installing $BACKEND dependencies...\"}"

if [ "$BACKEND" = "rocm" ]; then
    # ROCm: detect installed version for correct PyTorch index URL
    ROCM_VER=""
    if [ -f /opt/rocm/.info/version ]; then
        ROCM_VER=$(head -1 /opt/rocm/.info/version | grep -oE '[0-9]+\.[0-9]+')
    elif command -v amd-smi &>/dev/null; then
        ROCM_VER=$(amd-smi version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+' | head -1)
    elif command -v rocminfo &>/dev/null; then
        ROCM_VER=$(rocminfo 2>/dev/null | grep -i "HSA Runtime" | grep -oE '[0-9]+\.[0-9]+' | head -1)
    fi
    ROCM_VER="${ROCM_VER:-6.2}"  # fallback if detection fails
    log "Detected ROCm version: $ROCM_VER"

    # Build list of ROCm versions to try (detected → step down → previous major)
    ROCM_MAJOR=$(echo "$ROCM_VER" | cut -d. -f1)
    ROCM_MINOR=$(echo "$ROCM_VER" | cut -d. -f2)
    ROCM_CANDIDATES="$ROCM_VER"
    m=$((ROCM_MINOR - 1))
    while [ "$m" -ge 0 ]; do
        ROCM_CANDIDATES="$ROCM_CANDIDATES ${ROCM_MAJOR}.${m}"
        m=$((m - 1))
    done
    # Also try previous major version (e.g., 6.4, 6.2 if on 7.x)
    prev_major=$((ROCM_MAJOR - 1))
    for pm in 4 3 2 1 0; do
        ROCM_CANDIDATES="$ROCM_CANDIDATES ${prev_major}.${pm}"
    done

    # Phase 1: Try each candidate until PyTorch installs successfully
    TORCH_INSTALLED=false
    for ver in $ROCM_CANDIDATES; do
        log "Trying PyTorch for ROCm $ver ..."
        if "$PIP" install torch torchvision --index-url "https://download.pytorch.org/whl/rocm${ver}" -q 2>&1; then
            log "Installed PyTorch with ROCm $ver support"
            TORCH_INSTALLED=true
            break
        fi
    done

    if [ "$TORCH_INSTALLED" = false ]; then
        log "WARNING: No PyTorch ROCm wheels found, installing CPU PyTorch from PyPI"
        "$PIP" install torch torchvision -q 2>&1 | tail -3 >&2
    fi

    # Phase 2: remaining packages (ultralytics, onnxruntime-rocm, etc.)
    "$PIP" install ultralytics onnxruntime-rocm 'onnx>=1.12.0,<2.0.0' 'onnxslim>=0.1.71' \
        'numpy>=1.24.0' 'opencv-python-headless>=4.8.0' 'Pillow>=10.0.0' -q 2>&1 | tail -3 >&2

    # Prevent ultralytics from auto-installing CPU onnxruntime during export
    export YOLO_AUTOINSTALL=0
else
    "$PIP" install -r "$REQ_FILE" -q 2>&1 | tail -5 >&2
fi

# ─── Step 5: Pre-convert model to optimized format ───────────────────────────

if [ "$BACKEND" != "cpu" ] || [ -f "$SKILL_DIR/requirements_cpu.txt" ]; then
    log "Pre-converting model to optimized format for $BACKEND..."
    emit "{\"event\": \"progress\", \"stage\": \"optimize\", \"message\": \"Converting model for $BACKEND (~30-120s)...\"}"

    "$VENV_DIR/bin/python" -c "
import sys
sys.path.insert(0, '$ENV_CONFIG_DIR')
from env_config import HardwareEnv
env = HardwareEnv.detect()

if env.framework_ok:
    from ultralytics import YOLO
    model = YOLO('yolo26n.pt')
    result = env.export_model(model, 'yolo26n')
    if result:
        print(f'Optimized model exported: {result}')
    else:
        print('Export skipped or failed — will use PyTorch at runtime')
else:
    print(f'Optimized runtime not available for {env.backend} — will use PyTorch')
" 2>&1 | while read -r line; do log "$line"; done

    if [ $? -eq 0 ]; then
        emit "{\"event\": \"progress\", \"stage\": \"optimize\", \"message\": \"Model optimization complete\"}"
    else
        log "WARNING: Model optimization failed, will use PyTorch at runtime"
        emit "{\"event\": \"progress\", \"stage\": \"optimize\", \"message\": \"Optimization failed — PyTorch fallback\"}"
    fi
fi

# ─── Step 6: Verify installation ────────────────────────────────────────────

log "Verifying installation..."
"$VENV_DIR/bin/python" -c "
import sys
sys.path.insert(0, '$ENV_CONFIG_DIR')
from env_config import HardwareEnv
import json

env = HardwareEnv.detect()
print(json.dumps(env.to_dict(), indent=2))
" 2>&1 | while read -r line; do log "$line"; done

emit "{\"event\": \"complete\", \"backend\": \"$BACKEND\", \"message\": \"YOLO 2026 skill installed ($BACKEND backend)\"}"
log "Done! Backend: $BACKEND"
