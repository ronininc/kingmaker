#!/bin/bash
# deploy.sh — Zero-assumption bootstrapper for Depth Estimation Skill
#
# Probes the system for Python, GPU backends, and installs the minimum
# viable stack. Called by Aegis skill-runtime-manager during installation.
#
# Uses skills/lib/env_config.py for hardware detection.
#
# Exit codes:
#   0  = success
#   1  = fatal error (no Python found)
#   2  = partial success (CPU-only fallback)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$SCRIPT_DIR/.venv"
LIB_DIR="$(cd "$SCRIPT_DIR/../../lib" 2>/dev/null && pwd || echo "")"
MODELS_DIR="$HOME/.aegis-ai/models/feature-extraction"
LOG_PREFIX="[Depth-deploy]"

log()  { echo "$LOG_PREFIX $*" >&2; }
emit() { echo "$1"; }  # JSON to stdout for Aegis to parse

# ─── Step 1: Find Python ────────────────────────────────────────────────────

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

PIP="$VENV_DIR/bin/pip"
VPYTHON="$VENV_DIR/bin/python"

"$PIP" install --upgrade pip -q 2>/dev/null || true

emit '{"event": "progress", "stage": "venv", "message": "Virtual environment ready"}'

# ─── Step 2.5: Bundle env_config.py alongside transform.py ──────────────────

if [ -n "$LIB_DIR" ] && [ -f "$LIB_DIR/env_config.py" ]; then
    cp "$LIB_DIR/env_config.py" "$SCRIPT_DIR/scripts/env_config.py"
    log "Bundled env_config.py into scripts/"
fi

# ─── Step 3: Detect hardware via env_config ──────────────────────────────────

BACKEND="cpu"

# Find env_config.py — bundled copy or repo lib/
ENV_CONFIG_DIR=""
if [ -f "$SCRIPT_DIR/scripts/env_config.py" ]; then
    ENV_CONFIG_DIR="$SCRIPT_DIR/scripts"
elif [ -n "$LIB_DIR" ] && [ -f "$LIB_DIR/env_config.py" ]; then
    ENV_CONFIG_DIR="$LIB_DIR"
fi

if [ -n "$ENV_CONFIG_DIR" ]; then
    log "Detecting hardware via env_config.py..."
    DETECT_OUTPUT=$("$VPYTHON" -c "
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
            log "env_config returned unexpected backend '$BACKEND', falling back to cpu"
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
    elif [ "$(uname)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ]; then
        BACKEND="mps"
        log "Detected Apple Silicon (MPS)"
    fi
fi

emit "{\"event\": \"progress\", \"stage\": \"gpu\", \"backend\": \"$BACKEND\", \"message\": \"Compute backend: $BACKEND\"}"

# ─── Step 4: Install requirements ────────────────────────────────────────────

if [ "$(uname -s)" = "Darwin" ]; then
    # macOS: CoreML backend — lightweight install
    log "macOS detected — installing CoreML + common dependencies"
    emit '{"event": "progress", "stage": "install", "message": "Installing CoreML dependencies..."}'

    "$PIP" install --quiet \
        "coremltools>=8.0" \
        "huggingface_hub>=0.20.0" \
        "numpy>=1.24.0" \
        "opencv-python-headless>=4.8.0" \
        "Pillow>=10.0.0" \
        "matplotlib>=3.7.0"

    log "CoreML dependencies installed"

    # Download CoreML model if not present
    COREML_VARIANT="DepthAnythingV2SmallF16"
    COREML_HF_REPO="apple/coreml-depth-anything-v2-small"
    MODEL_PATH="$MODELS_DIR/$COREML_VARIANT.mlpackage"

    if [ -d "$MODEL_PATH" ]; then
        log "CoreML model already present: $MODEL_PATH"
    else
        log "Downloading CoreML model: $COREML_VARIANT from $COREML_HF_REPO..."
        mkdir -p "$MODELS_DIR"
        "$VPYTHON" -c "
from huggingface_hub import snapshot_download
snapshot_download(
    '$COREML_HF_REPO',
    local_dir='$MODELS_DIR',
    allow_patterns=['$COREML_VARIANT.mlpackage/**'],
)
print('CoreML model downloaded')
"
    fi
else
    # Non-macOS: use per-backend requirements files
    REQ_FILE="$SCRIPT_DIR/requirements_${BACKEND}.txt"

    if [ ! -f "$REQ_FILE" ]; then
        log "WARNING: $REQ_FILE not found, falling back to CPU"
        REQ_FILE="$SCRIPT_DIR/requirements_cpu.txt"
        BACKEND="cpu"
    fi

    log "Installing dependencies from $REQ_FILE ..."
    emit "{\"event\": \"progress\", \"stage\": \"install\", \"message\": \"Installing $BACKEND dependencies...\"}"

    "$PIP" install -r "$REQ_FILE" -q 2>&1 | tail -5 >&2
fi

# ─── Step 5: Verify installation ────────────────────────────────────────────

log "Verifying installation..."

if [ "$(uname -s)" = "Darwin" ]; then
    "$VPYTHON" -c "
import coremltools, cv2, numpy, PIL
from pathlib import Path
model_path = Path('$MODEL_PATH') if '${MODEL_PATH:-}' else None
if model_path and model_path.exists():
    print(f'Verified: coremltools={coremltools.__version__}, model={model_path.name}')
else:
    print(f'Verified: coremltools={coremltools.__version__} (no model downloaded yet)')
"
else
    if [ -n "$ENV_CONFIG_DIR" ]; then
        "$VPYTHON" -c "
import sys, json
sys.path.insert(0, '$ENV_CONFIG_DIR')
from env_config import HardwareEnv
env = HardwareEnv.detect()
print(json.dumps(env.to_dict(), indent=2))
" 2>&1 | while read -r line; do log "$line"; done
    else
        "$VPYTHON" -c "
import torch, cv2, numpy, PIL
from depth_anything_v2.dpt import DepthAnythingV2
print(f'Verified: torch={torch.__version__}, CUDA={torch.cuda.is_available()}')
"
    fi
fi

emit "{\"event\": \"complete\", \"backend\": \"$BACKEND\", \"message\": \"Depth Estimation skill installed ($BACKEND backend)\"}"
log "Done! Backend: $BACKEND"
