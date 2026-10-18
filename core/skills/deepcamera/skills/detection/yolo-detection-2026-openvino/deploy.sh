#!/usr/bin/env bash
# deploy.sh — Docker-based bootstrapper for OpenVINO Detection Skill
#
# Builds the Docker image locally and verifies device availability.
# Called by Aegis skill-runtime-manager during installation.
#
# Exit codes:
#   0 = success (hardware accelerator detected)
#   1 = fatal error (Docker not found)
#   2 = partial success (no accelerator detected, CPU fallback)

set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"
IMAGE_NAME="aegis-openvino-detect"
IMAGE_TAG="latest"
LOG_PREFIX="[openvino-deploy]"

log()  { echo "$LOG_PREFIX $*" >&2; }
emit() { echo "$1"; }  # JSON to stdout for Aegis to parse

# ─── Step 1: Check Docker ────────────────────────────────────────────────────

find_docker() {
    for cmd in docker podman; do
        if command -v "$cmd" &>/dev/null; then
            echo "$cmd"
            return 0
        fi
    done
    return 1
}

DOCKER_CMD=$(find_docker) || {
    log "ERROR: Docker (or Podman) not found. Install Docker Desktop 4.35+ and retry."
    emit '{"event": "error", "stage": "docker", "message": "Docker not found. Install Docker Desktop 4.35+"}'
    exit 1
}

# Verify Docker is running
if ! "$DOCKER_CMD" info &>/dev/null; then
    log "ERROR: Docker daemon is not running. Start Docker Desktop and retry."
    emit '{"event": "error", "stage": "docker", "message": "Docker daemon not running"}'
    exit 1
fi

DOCKER_VER=$("$DOCKER_CMD" version --format '{{.Server.Version}}' 2>/dev/null || echo "unknown")
log "Using $DOCKER_CMD (version: $DOCKER_VER)"
emit "{\"event\": \"progress\", \"stage\": \"docker\", \"message\": \"Docker ready ($DOCKER_VER)\"}"

# ─── Step 2: Detect platform for device access ──────────────────────────────

PLATFORM="$(uname -s)"
ARCH="$(uname -m)"
DEVICE_FLAGS=""

case "$PLATFORM" in
    Linux)
        # Pass Intel GPU and USB devices
        [ -d /dev/dri ] && DEVICE_FLAGS="--device /dev/dri"
        [ -d /dev/bus/usb ] && DEVICE_FLAGS="$DEVICE_FLAGS --device /dev/bus/usb"
        [ -z "$DEVICE_FLAGS" ] && DEVICE_FLAGS="--privileged"
        log "Platform: Linux ($ARCH) — devices: $DEVICE_FLAGS"
        ;;
    Darwin)
        log "Platform: macOS ($ARCH) — Docker Desktop USB/IP for NCS2, CPU fallback available"
        DEVICE_FLAGS="--privileged"
        ;;
    MINGW*|MSYS*|CYGWIN*)
        log "Platform: Windows — Docker Desktop USB/IP"
        DEVICE_FLAGS="--privileged"
        ;;
    *)
        log "Platform: Unknown ($PLATFORM) — attempting with --privileged"
        DEVICE_FLAGS="--privileged"
        ;;
esac

emit "{\"event\": \"progress\", \"stage\": \"platform\", \"message\": \"Platform: $PLATFORM/$ARCH\"}"

# ─── Step 3: Build Docker image ─────────────────────────────────────────────

log "Building Docker image: $IMAGE_NAME:$IMAGE_TAG ..."
emit '{"event": "progress", "stage": "build", "message": "Building Docker image (this may take a few minutes)..."}'

if "$DOCKER_CMD" build -t "$IMAGE_NAME:$IMAGE_TAG" "$SKILL_DIR" 2>&1 | while read -r line; do
    log "$line"
done; then
    log "Docker image built successfully"
    emit '{"event": "progress", "stage": "build", "message": "Docker image ready"}'
else
    log "ERROR: Docker build failed"
    emit '{"event": "error", "stage": "build", "message": "Docker image build failed"}'
    exit 1
fi

# ─── Step 4: Probe for OpenVINO devices ─────────────────────────────────────

log "Probing OpenVINO devices..."
emit '{"event": "progress", "stage": "probe", "message": "Checking OpenVINO devices..."}'

ACCEL_FOUND=false
PROBE_OUTPUT=$("$DOCKER_CMD" run --rm $DEVICE_FLAGS \
    "$IMAGE_NAME:$IMAGE_TAG" python3 scripts/device_probe.py 2>/dev/null) || true

if echo "$PROBE_OUTPUT" | grep -q '"accelerator_found": true'; then
    ACCEL_FOUND=true
    log "Hardware accelerator detected (GPU/NCS2)"
    emit '{"event": "progress", "stage": "probe", "message": "Hardware accelerator detected (GPU/NCS2)"}'
else
    log "WARNING: No accelerator detected — skill will run in CPU fallback mode"
    emit '{"event": "progress", "stage": "probe", "message": "No GPU/NCS2 detected — CPU fallback available"}'
fi

# ─── Step 5: Build run command ───────────────────────────────────────────────

# The run command Aegis will use to launch the skill
# stdin/stdout pipe (-i), auto-remove (--rm), shared volume
RUN_CMD="$DOCKER_CMD run -i --rm $DEVICE_FLAGS"
RUN_CMD="$RUN_CMD -v /tmp/aegis_detection:/tmp/aegis_detection"
RUN_CMD="$RUN_CMD --env AEGIS_SKILL_ID --env AEGIS_SKILL_PARAMS --env PYTHONUNBUFFERED=1"
RUN_CMD="$RUN_CMD $IMAGE_NAME:$IMAGE_TAG"

log "Runtime command: $RUN_CMD"

# ─── Step 6: Complete ────────────────────────────────────────────────────────

if [ "$ACCEL_FOUND" = true ]; then
    emit "{\"event\": \"complete\", \"status\": \"success\", \"accelerator_found\": true, \"run_command\": \"$RUN_CMD\", \"message\": \"OpenVINO skill installed — hardware accelerator ready\"}"
    log "Done! Hardware accelerator ready."
    exit 0
else
    emit "{\"event\": \"complete\", \"status\": \"partial\", \"accelerator_found\": false, \"run_command\": \"$RUN_CMD\", \"message\": \"OpenVINO skill installed — no accelerator detected (CPU fallback)\"}"
    log "Done with warning: no accelerator detected. Connect Intel GPU/NCS2 and restart."
    exit 2
fi
