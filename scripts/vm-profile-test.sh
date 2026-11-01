#!/bin/bash
# Test a Kingmaker profile pack inside a macOS VM capped at that pack's memory (Apple Virtualization, via tart).
#
#   scripts/vm-profile-test.sh <8|16|24> [--keep]
#
# What it does: clones the stock macOS VM (no Homebrew: cirruslabs/macos-tahoe-vanilla, cloned once as "km-base"),
# sets its memory to the pack's class (8 GB → 8192 MB) and 8 CPU cores (a base M1–M4 has 8), shares this checkout
# (read-only) and this Mac's Ollama model store (read-only: the owner's models can't be changed or pruned) into it,
# installs the official Node and Ollama builds in the VM user's home (no Homebrew), then runs
#   kingmaker models setup --pack <class> --dry-run     (the pack's install plan on a Mac of that size)
#   kingmaker models bench --set <class>                (the pack's models, measured inside the VM)
# and writes the results to catalog/bench/vm/.
#
# What a VM can't prove (say it with every result): the VM's GPU is Apple's paravirtualized Metal device, not the chip's
# own GPU, so tok/s and load times are not a real M1–M4's; there is no Neural Engine passthrough, so Kokoro on the ANE
# and the voice runtime can't be tested; macOS in a VM still swaps to the VM's own disk, so a swap/freeze verdict holds
# only for that VM. The real 8 GB answer is the 8 GB M3 itself: docs/MAC-PROFILES.md, "Run it on the 8 GB M3".
set -euo pipefail

CLASS="${1:?usage: scripts/vm-profile-test.sh <8|16|24> [--keep]}"; KEEP=0; [ "${2:-}" = "--keep" ] && KEEP=1
case "$CLASS" in 8|16|24) ;; *) echo "pack class must be 8, 16 or 24" >&2; exit 2 ;; esac
TART="${TART:-$(command -v tart || echo "$HOME/Applications/tart.app/Contents/MacOS/tart")}"
[ -x "$TART" ] || { echo "tart is not installed (https://github.com/cirruslabs/tart/releases, Developer ID signed)" >&2; exit 1; }
REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$REPO/catalog/bench/vm"; mkdir -p "$OUT"
MODELS="${OLLAMA_MODELS:-$HOME/.ollama/models}"
BASE="${KM_VM_BASE:-km-base}"; VM="km-$CLASS"
KEY="$HOME/.ssh/kingmaker_vm_ed25519"
NODE_VERSION="${KM_VM_NODE:-v24.11.1}"
# The VM's Ollama is this Mac's version: a newer one migrates the store's layout (0.40 writes manifests-v2), which the
# read-only share refuses, and the owner's store must never be rewritten by a test.
OLLAMA_VERSION="${KM_VM_OLLAMA:-$(curl -fsS http://127.0.0.1:11434/api/version 2>/dev/null | sed -E 's/.*"version":"([^"]+)".*/\1/')}"
[ -n "$OLLAMA_VERSION" ] || { echo "this Mac's Ollama isn't answering, so its version is unknown (set KM_VM_OLLAMA)" >&2; exit 1; }

say() { printf '\n== %s\n' "$*"; }
"$TART" list | awk '{print $2}' | grep -qx "$BASE" || { say "cloning the stock macOS image as $BASE (about 24 GB, once)"; "$TART" clone ghcr.io/cirruslabs/macos-tahoe-vanilla:latest "$BASE"; }
"$TART" list | awk '{print $2}' | grep -qx "$VM" || "$TART" clone "$BASE" "$VM"
"$TART" set "$VM" --memory $((CLASS * 1024)) --cpu 8
say "starting $VM with $CLASS GB"
"$TART" run "$VM" --no-graphics --dir="repo:$REPO:ro" --dir="models:$MODELS:ro" --dir="out:$OUT" > "$OUT/$VM.tart.log" 2>&1 &
TART_PID=$!
stop_vm() { [ "$KEEP" = 1 ] || { "$TART" stop "$VM" >/dev/null 2>&1 || true; wait "$TART_PID" 2>/dev/null || true; }; }
trap stop_vm EXIT
IP="$("$TART" ip "$VM" --wait 180)"
say "$VM is at $IP"

# A key of its own, installed once with the image's default login (admin/admin).
[ -f "$KEY" ] || ssh-keygen -q -t ed25519 -N '' -f "$KEY" -C kingmaker-vm
# Only this key: the Mac's agent offering its own keys first ends in "Too many authentication failures".
SSH=(ssh -i "$KEY" -o IdentitiesOnly=yes -o IdentityAgent=none -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR "admin@$IP")
if ! "${SSH[@]}" -o BatchMode=yes true 2>/dev/null; then
  # The image's default login (admin/admin) installs this key once. OpenSSH's own SSH_ASKPASS gives the password (expect
  # proved unreliable at catching macOS's prompt).
  ASK="$(mktemp -t kmask)"; printf '#!/bin/sh\necho admin\n' > "$ASK"; chmod 700 "$ASK"
  SSH_ASKPASS="$ASK" SSH_ASKPASS_REQUIRE=force DISPLAY=none ssh -o PubkeyAuthentication=no -o PreferredAuthentications=password -o IdentityAgent=none \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR "admin@$IP" \
    "mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '$(cat "$KEY.pub")' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys" < /dev/null
  rm -f "$ASK"
  "${SSH[@]}" -o BatchMode=yes true || { echo "could not log in to the VM (admin/admin, then this key)" >&2; exit 1; }
fi

say "installing the official Node $NODE_VERSION and Ollama $OLLAMA_VERSION builds in the VM (no Homebrew)"
"${SSH[@]}" bash -s "$NODE_VERSION" "$OLLAMA_VERSION" <<'EOF'
set -euo pipefail
V="$1"; OV="$2"; T="$HOME/km-tools"; mkdir -p "$T"; cd "$T"
if [ ! -x "$T/node/bin/node" ]; then
  curl -fsSLO "https://nodejs.org/dist/$V/node-$V-darwin-arm64.tar.gz" && curl -fsSL "https://nodejs.org/dist/$V/SHASUMS256.txt" | grep " node-$V-darwin-arm64.tar.gz\$" | shasum -a 256 -c -
  tar -xzf "node-$V-darwin-arm64.tar.gz" && mv "node-$V-darwin-arm64" node && rm "node-$V-darwin-arm64.tar.gz"
fi
if ! "$T/Ollama.app/Contents/Resources/ollama" --version 2>/dev/null | grep -q " $OV\$"; then
  rm -rf "$T/Ollama.app"
  curl -fsSL -o Ollama-darwin.zip "https://github.com/ollama/ollama/releases/download/v$OV/Ollama-darwin.zip" && ditto -x -k Ollama-darwin.zip . && rm Ollama-darwin.zip
fi
"$T/node/bin/node" --version; "$T/Ollama.app/Contents/Resources/ollama" --version 2>&1 | tail -1
sysctl -n machdep.cpu.brand_string hw.memsize
EOF

say "the $CLASS GB pack: install plan, then the benchmark"
"${SSH[@]}" bash -s "$CLASS" <<'EOF'
set -uo pipefail
C="$1"; T="$HOME/km-tools"; S="/Volumes/My Shared Files"
export PATH="$T/node/bin:$PATH"
pkill -f "ollama serve" 2>/dev/null || true
OLLAMA_MODELS="$S/models" OLLAMA_NOPRUNE=1 OLLAMA_MAX_LOADED_MODELS=1 OLLAMA_NUM_PARALLEL=1 "$T/Ollama.app/Contents/Resources/ollama" serve > "$S/out/km-$C.ollama.log" 2>&1 &
for _ in $(seq 60); do curl -fsS http://127.0.0.1:11434/api/version >/dev/null 2>&1 && break; sleep 1; done
grep -E "inference compute|gpu memory" "$S/out/km-$C.ollama.log" | tail -2
node "$S/repo/lib/cli.mjs" models profile
node "$S/repo/lib/cli.mjs" models setup --pack "$C" --dry-run
OLLAMA_BIN="$T/Ollama.app/Contents/Resources/ollama" node "$S/repo/lib/cli.mjs" models bench --set "$C" --out "$S/out" --cooldown 20
EOF
say "results in $OUT"
