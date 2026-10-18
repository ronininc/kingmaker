#!/usr/bin/env bash
# deploy.sh — Platform dispatcher for Coral TPU Detection Skill
#
# This script is the entry point defined in SKILL.md. It detects the OS and
# delegates to the appropriate platform-specific installer:
#
#   deploy-macos.sh   — macOS arm64 (Apple Silicon) and x86_64
#   deploy-linux.sh   — Linux (Debian/Ubuntu via apt, others via pyenv)
#   deploy.bat        — Windows (invoked separately by Aegis on Windows)
#
# DO NOT add platform-specific logic here. Keep this file as a dispatcher only.
#
# Exit codes mirror the sub-scripts:
#   0 = success
#   1 = fatal error
#   2 = partial success (no TPU detected, CPU fallback)

set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"

log()  { echo "[coral-tpu-deploy] $*" >&2; }
emit() { echo "$1"; }

PLATFORM="$(uname -s)"
ARCH="$(uname -m)"
log "Detected platform: $PLATFORM ($ARCH)"

# ─── Shared: TPU probe + completion (called by sub-scripts after venv is built)
# Sub-scripts source this file's final stage, or we let them handle it inline.
# The dispatcher just delegates and passes exit codes through.

case "$PLATFORM" in
    Darwin)
        chmod +x "$SKILL_DIR/deploy-macos.sh"
        exec "$SKILL_DIR/deploy-macos.sh" "$@"
        ;;
    Linux)
        chmod +x "$SKILL_DIR/deploy-linux.sh"
        exec "$SKILL_DIR/deploy-linux.sh" "$@"
        ;;
    *)
        emit "{\"event\": \"error\", \"stage\": \"platform\", \"message\": \"Unsupported platform: $PLATFORM — use deploy.bat on Windows\"}"
        log "ERROR: Unsupported platform '$PLATFORM'. On Windows, Aegis calls deploy.bat directly."
        exit 1
        ;;
esac
