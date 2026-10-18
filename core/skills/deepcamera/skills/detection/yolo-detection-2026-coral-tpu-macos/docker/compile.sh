#!/usr/bin/env bash
# compile.sh — Build and run the Coral EdgeTPU model compiler Docker image.
#
# Converts yolo26n.pt → TFLite INT8 → yolo26n_edgetpu.tflite
# Output lands in ../models/ (tracked in the git repo).
#
# Usage:
#   bash docker/compile.sh                    # 320×320 nano (default)
#   bash docker/compile.sh --size 640         # 640×640 nano
#   bash docker/compile.sh --model yolo26s    # small model
#
# Requirements:
#   - Docker with buildx / multi-platform support
#   - Internet access (downloads yolo26n.pt from ultralytics on first run)
#
# On Apple Silicon or Windows, Docker Desktop handles linux/amd64 emulation
# via Rosetta / QEMU automatically. First run will be slower (emulation).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MODELS_DIR="$SKILL_DIR/models"
IMAGE_NAME="coral-tpu-compiler"

# ── Parse args (pass-through to compile_model.py) ────────────────────────────
COMPILE_ARGS=("$@")
if [[ ${#COMPILE_ARGS[@]} -eq 0 ]]; then
    COMPILE_ARGS=(--model yolo26n --size 320 --output /compile/output)
fi

log() { echo "[compile.sh] $*" >&2; }

log "Skill dir : $SKILL_DIR"
log "Models out: $MODELS_DIR"
log "Args      : ${COMPILE_ARGS[*]}"

# ── Ensure models dir exists ──────────────────────────────────────────────────
mkdir -p "$MODELS_DIR"

# ── Build image (linux/amd64 required for edgetpu_compiler) ──────────────────
log "Building Docker image: $IMAGE_NAME (linux/amd64)..."
docker build \
    --platform linux/amd64 \
    --tag "$IMAGE_NAME:latest" \
    --file "$SCRIPT_DIR/Dockerfile" \
    "$SKILL_DIR"

log "Build complete. Running model compiler..."

# ── Run compiler, mount models/ as output volume ──────────────────────────────
docker run --rm \
    --platform linux/amd64 \
    --name coral-tpu-compile-run \
    -v "$MODELS_DIR:/compile/output" \
    "$IMAGE_NAME:latest" \
    "${COMPILE_ARGS[@]}"

echo ""
log "✓ Compilation complete. Output files in: $MODELS_DIR"
log ""
log "Files produced:"
ls -lh "$MODELS_DIR"/*.tflite 2>/dev/null || log "  (no .tflite files yet — check compile output above)"

echo ""
log "Next steps:"
log "  1. Verify the model:  ls -lh $MODELS_DIR/*_edgetpu.tflite"
log "  2. Commit to git:     git -C '$SKILL_DIR' add models/*.tflite && git commit -m 'feat(coral-tpu): add compiled yolo26n edgetpu model'"
log "  3. Run deploy.bat on your Windows machine to install the skill."
