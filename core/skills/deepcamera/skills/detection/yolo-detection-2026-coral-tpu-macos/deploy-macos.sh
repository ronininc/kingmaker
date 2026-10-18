#!/usr/bin/env bash
# deploy-macos.sh — Coral TPU driver installation for macOS (arm64 + x86_64)
#
# Called by deploy.sh dispatcher. Do NOT add Linux or Windows logic here.
#
# Exit codes:
#   0 = success
#   1 = fatal error
#   2 = partial success (no TPU detected, CPU fallback)

set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_PREFIX="[coral-tpu-macos]"

log()  { echo "$LOG_PREFIX $*" >&2; }
emit() { echo "$1"; }

ask_sudo() {
    local cmd="$1"
    local desc="$2"
    local manual="$3"

    emit "{\"event\": \"progress\", \"stage\": \"platform\", \"message\": \"Sudo required: $desc\"}"
    log "Attempting to run: $desc"

    # Fast path: passwordless sudo or cached ticket
    if sudo -n true 2>/dev/null; then
        eval "sudo bash -c \"$cmd\""
        return $?
    fi

    if eval "sudo bash -c \"$cmd\""; then
        return 0
    else
        echo ""
        echo -e "\033[1;31m[ERROR]\033[0m Sudo command failed or user aborted the prompt."
        echo "Please execute the following instructions manually in a terminal:"
        echo ""
        echo -e "\033[1;36m$manual\033[0m"
        echo ""
        echo "Once completed, re-run this deployment."
        emit '{"event": "error", "stage": "platform", "message": "Manual OS setup required (sudo failed)"}'
        exit 1
    fi
}

ARCH="$(uname -m)"
log "macOS ($ARCH): Installing libusb and Edge TPU driver..."
emit '{"event": "progress", "stage": "platform", "message": "macOS detected — installing Edge TPU runtime..."}'

# ─── libusb (no sudo required via brew) ──────────────────────────────────────
if command -v brew &>/dev/null; then
    brew install libusb || true
else
    log "WARNING: Homebrew not found. libusb may need to be installed via MacPorts or manually."
fi

# ─── Edge TPU driver ─────────────────────────────────────────────────────────
if [ "$ARCH" = "arm64" ]; then
    # Apple Silicon — community fork from feranick/libedgetpu (no Rosetta needed)
    MANUAL_INSTALL="curl -sSLO https://github.com/feranick/libedgetpu/releases/download/16.0TF2.19.1-1/libedgetpu-16.0-tf2.19.1-1_MacOS_Silicon.zip
unzip -q -o libedgetpu-16.0-tf2.19.1-1_MacOS_Silicon.zip
sudo mkdir -p /usr/local/lib /opt/homebrew/lib
sudo cp libedgetpu-16.0-tf2.19.1-1_MacOS_Silicon/direct/darwin_arm64/libedgetpu.1.dylib /usr/local/lib/
sudo cp libedgetpu-16.0-tf2.19.1-1_MacOS_Silicon/direct/darwin_arm64/libedgetpu.1.dylib /opt/homebrew/lib/
rm -rf libedgetpu*"

    emit '{"event": "progress", "stage": "platform", "message": "Downloading Apple Silicon arm64 driver (feranick/libedgetpu)..."}'
    TMP_DIR=$(mktemp -d)
    cd "$TMP_DIR"
    curl -sSLO https://github.com/feranick/libedgetpu/releases/download/16.0TF2.19.1-1/libedgetpu-16.0-tf2.19.1-1_MacOS_Silicon.zip
    unzip -q -o libedgetpu-16.0-tf2.19.1-1_MacOS_Silicon.zip
    ask_sudo \
        "mkdir -p /usr/local/lib /opt/homebrew/lib && cp libedgetpu-16.0-tf2.19.1-1_MacOS_Silicon/direct/darwin_arm64/libedgetpu.1.dylib /usr/local/lib/ && cp libedgetpu-16.0-tf2.19.1-1_MacOS_Silicon/direct/darwin_arm64/libedgetpu.1.dylib /opt/homebrew/lib/" \
        "Install libedgetpu.1.dylib to /usr/local/lib and /opt/homebrew/lib" \
        "$MANUAL_INSTALL"
    cd "$SKILL_DIR"
    rm -rf "$TMP_DIR"
else
    # Intel x86_64 macOS — official Google runtime
    MANUAL_INSTALL="curl -LO https://github.com/google-coral/libedgetpu/releases/download/release-grouper/edgetpu_runtime_20221024.zip
unzip edgetpu_runtime_20221024.zip
cd edgetpu_runtime
sudo bash install.sh"

    emit '{"event": "progress", "stage": "platform", "message": "Downloading official Google x86_64 macOS Edge TPU runtime..."}'
    TMP_DIR=$(mktemp -d)
    cd "$TMP_DIR"
    curl -sSLO https://github.com/google-coral/libedgetpu/releases/download/release-grouper/edgetpu_runtime_20221024.zip
    unzip -q -o edgetpu_runtime_20221024.zip
    cd edgetpu_runtime
    ask_sudo "bash install.sh </dev/null" "Execute official Google Coral install.sh" "$MANUAL_INSTALL"
    cd "$SKILL_DIR"
    rm -rf "$TMP_DIR"
fi

# ─── Python venv + dependencies ─────────────────────────────────────────────
# ai-edge-litert (the inference engine) supports Python 3.9-3.13.
# No need to pin to Python 3.9 — use whatever python3 is available.
PYTHON_CMD="python3"
if ! command -v python3 &>/dev/null; then
    emit '{"event": "error", "stage": "python", "message": "Python 3 not found. Install via: brew install python"}'
    exit 1
fi
log "Using Python: $($PYTHON_CMD --version)"

VENV_DIR="$SKILL_DIR/venv"
emit '{"event": "progress", "stage": "build", "message": "Creating Python virtual environment..."}'
"$PYTHON_CMD" -m venv "$VENV_DIR"

"$VENV_DIR/bin/python" -m pip install --upgrade pip >/dev/null 2>&1 || true

emit '{"event": "progress", "stage": "build", "message": "Installing dependencies (ai-edge-litert, numpy, Pillow)..."}'
if ! "$VENV_DIR/bin/python" -m pip install --extra-index-url https://google-coral.github.io/py-repo/ -r "$SKILL_DIR/requirements.txt"; then
    emit '{"event": "error", "stage": "build", "message": "pip install requirements failed"}'
    exit 1
fi

# ─── Download Pre-compiled Models ───────────────────────────────────────────
emit '{"event": "progress", "stage": "build", "message": "Downloading Edge TPU models..."}'
mkdir -p "$SKILL_DIR/models"
cd "$SKILL_DIR/models"
curl -sSLO "https://github.com/google-coral/edgetpu/raw/master/test_data/ssd_mobilenet_v2_coco_quant_postprocess.tflite"
curl -sSLO "https://github.com/google-coral/edgetpu/raw/master/test_data/ssd_mobilenet_v2_coco_quant_postprocess_edgetpu.tflite"
cd "$SKILL_DIR"

log "macOS deployment complete."

# ─── Probe for Edge TPU devices ──────────────────────────────────────────────
log "Probing for Edge TPU devices..."
emit '{"event": "progress", "stage": "probe", "message": "Checking for physical Edge TPU..."}'

TPU_FOUND=false
PROBE_OUTPUT=$("$VENV_DIR/bin/python" "$SKILL_DIR/scripts/tpu_probe.py" 2>/dev/null) || true

if echo "$PROBE_OUTPUT" | grep -q '"available": true'; then
    TPU_COUNT=$(echo "$PROBE_OUTPUT" | "$VENV_DIR/bin/python" -c "import sys,json; print(json.load(sys.stdin)['count'])" 2>/dev/null || echo "?")
    TPU_FOUND=true
    emit "{\"event\": \"progress\", \"stage\": \"probe\", \"message\": \"Found $TPU_COUNT Edge TPU device(s)\"}"
else
    emit '{"event": "progress", "stage": "probe", "message": "No Edge TPU detected — CPU fallback available"}'
fi

if [ "$TPU_FOUND" = true ]; then
    emit "{\"event\": \"complete\", \"status\": \"success\", \"tpu_found\": true, \"message\": \"Coral TPU skill installed — Edge TPU ready\"}"
    exit 0
else
    emit "{\"event\": \"complete\", \"status\": \"partial\", \"tpu_found\": false, \"message\": \"Coral TPU skill installed — no TPU detected (CPU fallback)\"}"
    exit 2
fi
