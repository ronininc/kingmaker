#!/usr/bin/env bash
# deploy-linux.sh — Coral TPU driver installation for Linux
#
# Called by deploy.sh dispatcher. Do NOT add macOS or Windows logic here.
#
# Strategy: Lock to Python 3.9 (the last version Google ships pycoral wheels for).
#   1. Check for python3.9 natively
#   2. If missing, install via pyenv (works on any distro — no apt dependency)
#   3. Create isolated venv from python3.9
#   4. pip install pycoral from Google's wheel index
#
# For the Edge TPU runtime:
#   - Debian/Ubuntu: uses apt-get with modern signed-by keyring
#   - Other distros:  falls back to manual install instructions
#
# Exit codes:
#   0 = success
#   1 = fatal error
#   2 = partial success (no TPU detected, CPU fallback)

set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_PREFIX="[coral-tpu-linux]"

log()  { echo "$LOG_PREFIX $*" >&2; }
emit() { echo "$1"; }

ask_sudo() {
    local cmd="$1"
    local desc="$2"
    local manual="$3"

    emit "{\"event\": \"progress\", \"stage\": \"platform\", \"message\": \"Sudo required: $desc\"}"
    log "Attempting to run: $desc"

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
log "Linux ($ARCH): Installing Coral Edge TPU runtime..."
emit '{"event": "progress", "stage": "platform", "message": "Linux detected — installing Edge TPU runtime..."}'

# ─── Step 1: Edge TPU Runtime ────────────────────────────────────────────────
# Detect if this is a Debian/Ubuntu derivative (has apt-get)
if command -v apt-get &>/dev/null; then
    emit '{"event": "progress", "stage": "platform", "message": "Debian/Ubuntu detected — installing via apt-get..."}'

    MANUAL_APT="curl -sL https://packages.cloud.google.com/apt/doc/apt-key.gpg | sudo gpg --dearmor -o /usr/share/keyrings/coral-edgetpu-archive-keyring.gpg
echo \"deb [signed-by=/usr/share/keyrings/coral-edgetpu-archive-keyring.gpg] https://packages.cloud.google.com/apt coral-edgetpu-stable main\" | sudo tee /etc/apt/sources.list.d/coral-edgetpu.list
sudo apt-get update
sudo apt-get install -y libedgetpu1-max libusb-1.0-0"

    ask_sudo \
        "apt-get update && apt-get install -y --no-install-recommends curl gnupg && \
         curl -sL https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor -o /usr/share/keyrings/coral-edgetpu-archive-keyring.gpg && \
         echo 'deb [signed-by=/usr/share/keyrings/coral-edgetpu-archive-keyring.gpg] https://packages.cloud.google.com/apt coral-edgetpu-stable main' | tee /etc/apt/sources.list.d/coral-edgetpu.list && \
         apt-get update && \
         apt-get install -y libedgetpu1-max libusb-1.0-0" \
        "Install Google Coral Edge TPU runtime via apt-get" \
        "$MANUAL_APT"

elif command -v dnf &>/dev/null || command -v yum &>/dev/null; then
    # RHEL / Fedora / CentOS — no official Coral rpm package
    emit '{"event": "progress", "stage": "platform", "message": "RPM-based distro detected — manual libedgetpu install required..."}'
    echo ""
    echo -e "\033[1;33m[MANUAL SETUP]\033[0m RPM-based distros (Fedora/RHEL/CentOS) do not have official"
    echo "Google Coral APT packages. Please install libedgetpu manually from source:"
    echo ""
    echo -e "\033[1;36m  https://github.com/feranick/libedgetpu/releases\033[0m"
    echo ""
    echo "Once the .so file is installed to /usr/local/lib/, re-run this deployment."
    emit '{"event": "error", "stage": "platform", "message": "Manual libedgetpu install required for RPM-based distros"}'
    exit 1
else
    emit '{"event": "error", "stage": "platform", "message": "Unsupported Linux package manager. Install libedgetpu manually."}'
    exit 1
fi

# ─── Step 2: Find Python 3 ──────────────────────────────────────────────
# ai-edge-litert supports Python 3.9–3.13. No version pinning needed.
if ! command -v python3 &>/dev/null; then
    emit '{"event": "error", "stage": "python", "message": "Python 3 not found. Install via your package manager."}'
    exit 1
fi
PYTHON_CMD="python3"
log "Using Python: $($PYTHON_CMD --version)"

# ─── Step 3: Create isolated venv ────────────────────────────────────────────
VENV_DIR="$SKILL_DIR/venv"
emit '{"event": "progress", "stage": "build", "message": "Creating Python 3.9 virtual environment..."}'
"$PYTHON_CMD" -m venv "$VENV_DIR"

if [ ! -f "$VENV_DIR/bin/python" ]; then
    emit '{"event": "error", "stage": "build", "message": "Failed to create venv"}'
    exit 1
fi

"$VENV_DIR/bin/python" -m pip install --upgrade pip >/dev/null 2>&1 || true

# ─── Step 4: Install dependencies ──────────────────────────────────────────────
emit '{"event": "progress", "stage": "build", "message": "Installing ai-edge-litert and dependencies..."}'
if ! "$VENV_DIR/bin/python" -m pip install -r "$SKILL_DIR/requirements.txt"; then
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

log "Linux deployment complete."

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
