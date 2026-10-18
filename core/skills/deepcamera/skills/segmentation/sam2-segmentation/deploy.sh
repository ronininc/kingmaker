#!/usr/bin/env bash
# deploy.sh — Bootstrapper for SAM2 Segmentation Skill
#
# Creates venv, installs dependencies, downloads model checkpoint.
# Called by Aegis skill-runtime-manager during installation.
#
# Exit codes:
#   0  = success
#   1  = fatal error

set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_DIR="$SKILL_DIR/.venv"
MODELS_DIR="$SKILL_DIR/models"
LOG_PREFIX="[SAM2-deploy]"

log()  { echo "$LOG_PREFIX $*" >&2; }
emit() { echo "$1"; }  # JSON to stdout for Aegis to parse

# ─── Step 1: Find Python ──────────────────────────────────────────────────

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

# ─── Step 2: Create virtual environment ──────────────────────────────────

if [ ! -d "$VENV_DIR" ]; then
    log "Creating virtual environment..."
    "$PYTHON_CMD" -m venv "$VENV_DIR"
fi

# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"
PIP="$VENV_DIR/bin/pip"

"$PIP" install --upgrade pip -q 2>/dev/null || true

emit '{"event": "progress", "stage": "venv", "message": "Virtual environment ready"}'

# ─── Step 3: Detect hardware and install deps ───────────────────────────

BACKEND="cpu"
if [ "$(uname)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ]; then
    BACKEND="mps"
    log "Detected Apple Silicon (MPS)"
elif command -v nvidia-smi &>/dev/null; then
    BACKEND="cuda"
    log "Detected NVIDIA GPU (CUDA)"
fi

emit "{\"event\": \"progress\", \"stage\": \"gpu\", \"backend\": \"$BACKEND\", \"message\": \"Compute backend: $BACKEND\"}"

log "Installing dependencies..."
emit '{"event": "progress", "stage": "install", "message": "Installing SAM2 dependencies..."}'

# Install PyTorch first (platform-specific)
if [ "$BACKEND" = "cuda" ]; then
    "$PIP" install torch torchvision --index-url https://download.pytorch.org/whl/cu124 -q 2>&1 | tail -3 >&2
elif [ "$BACKEND" = "mps" ]; then
    "$PIP" install torch torchvision -q 2>&1 | tail -3 >&2
else
    "$PIP" install torch torchvision --index-url https://download.pytorch.org/whl/cpu -q 2>&1 | tail -3 >&2
fi

# Install remaining deps
"$PIP" install -r "$SKILL_DIR/requirements.txt" -q 2>&1 | tail -5 >&2

emit '{"event": "progress", "stage": "install", "message": "Dependencies installed"}'

# ─── Step 4: Download default model checkpoint ─────────────────────────

DEFAULT_MODEL="sam2.1-hiera-small"
CHECKPOINT_URL="https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_small.pt"
CHECKPOINT_FILE="$MODELS_DIR/sam2-small.pt"

mkdir -p "$MODELS_DIR"

if [ ! -f "$CHECKPOINT_FILE" ]; then
    log "Downloading SAM2 model checkpoint ($DEFAULT_MODEL)..."
    emit '{"event": "progress", "stage": "model", "message": "Downloading SAM2 model (~180MB)..."}'

    if command -v curl &>/dev/null; then
        curl -L -o "$CHECKPOINT_FILE" "$CHECKPOINT_URL" 2>&1 | tail -1 >&2
    elif command -v wget &>/dev/null; then
        wget -O "$CHECKPOINT_FILE" "$CHECKPOINT_URL" 2>&1 | tail -1 >&2
    else
        log "ERROR: Neither curl nor wget found. Cannot download model."
        emit '{"event": "error", "stage": "model", "message": "No download tool available"}'
        exit 1
    fi

    if [ -f "$CHECKPOINT_FILE" ]; then
        SIZE=$(du -h "$CHECKPOINT_FILE" | cut -f1)
        log "Model downloaded: $CHECKPOINT_FILE ($SIZE)"
        emit "{\"event\": \"progress\", \"stage\": \"model\", \"message\": \"Model downloaded ($SIZE)\"}"
    else
        log "ERROR: Model download failed"
        emit '{"event": "error", "stage": "model", "message": "Model download failed"}'
        exit 1
    fi
else
    log "Model checkpoint already exists: $CHECKPOINT_FILE"
    emit '{"event": "progress", "stage": "model", "message": "Model already downloaded"}'
fi

# ─── Step 5: Verify installation ──────────────────────────────────────────

log "Verifying installation..."
"$VENV_DIR/bin/python" -c "
import torch
import numpy
import cv2
print(f'PyTorch {torch.__version__}')
print(f'NumPy {numpy.__version__}')
print(f'OpenCV {cv2.__version__}')
if torch.cuda.is_available():
    print(f'CUDA: {torch.cuda.get_device_name(0)}')
elif hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():
    print('MPS: Apple Silicon')
else:
    print('Device: CPU')
" 2>&1 | while read -r line; do log "$line"; done

emit "{\"event\": \"complete\", \"backend\": \"$BACKEND\", \"message\": \"SAM2 segmentation skill installed ($BACKEND backend)\"}"
log "Done! Backend: $BACKEND"
