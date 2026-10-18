#!/usr/bin/env bash
# deploy.sh — Bootstrapper for Annotation Data Management Skill
# Lightweight — no GPU needed, stdlib-only Python.

set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_DIR="$SKILL_DIR/.venv"
LOG_PREFIX="[annotation-data-deploy]"

log()  { echo "$LOG_PREFIX $*" >&2; }
emit() { echo "$1"; }

# ─── Find Python ──────────────────────────────────────────────────────────
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
    log "ERROR: No Python >=3.9 found."
    emit '{"event": "error", "stage": "python", "message": "No Python >=3.9 found"}'
    exit 1
}

log "Using Python: $PYTHON_CMD ($($PYTHON_CMD --version 2>&1))"
emit "{\"event\": \"progress\", \"stage\": \"python\", \"message\": \"Found $($PYTHON_CMD --version 2>&1)\"}"

# ─── Create venv ──────────────────────────────────────────────────────────
if [ ! -d "$VENV_DIR" ]; then
    "$PYTHON_CMD" -m venv "$VENV_DIR"
fi

emit '{"event": "progress", "stage": "venv", "message": "Virtual environment ready"}'

# ─── Verify ───────────────────────────────────────────────────────────────
"$VENV_DIR/bin/python" -c "import json, pathlib; print('Annotation data skill ready')" 2>&1 | while read -r line; do log "$line"; done

emit '{"event": "complete", "backend": "cpu", "message": "Annotation data skill installed"}'
log "Done!"
