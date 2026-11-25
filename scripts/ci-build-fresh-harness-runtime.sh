#!/bin/bash
# Called only on the dedicated, disposable arm64 macOS assembly runner.
# Build the exact TSS development inputs; do not reuse an old build or write to
# a customer's home, launchd, Keychain, production storage or updater.
set -euo pipefail
engine="${1:?absolute path to pinned TSS worktree}"
kingmaker="${2:?absolute path to pinned Kingmaker worktree}"
scratch="${3:?absolute path to disposable owner runner scratch}"
[[ "$engine" == /* && "$kingmaker" == /* && "$scratch" == /* ]]
test "$(uname -s):$(uname -m)" = Darwin:arm64
test "$(git -C "$engine" rev-parse HEAD)" = "${TSS_SHA:?}"
test "$(git -C "$kingmaker" rev-parse HEAD)" = "${KINGMAKER_SHA:?}"
for p in python3.13 cmake ollama; do command -v "$p" >/dev/null; done
for d in home upstream models browser ollama tmp; do mkdir "$scratch/$d"; done
export HOME="$scratch/home" TMPDIR="$scratch/tmp"
export SOLOMON_UPSTREAM_ROOT="$scratch/upstream" SOLOMON_MODEL_ROOT="$scratch/models"
export PLAYWRIGHT_BROWSERS_PATH="$scratch/browser"
export OLLAMA_MODELS="$scratch/ollama" OLLAMA_HOST=127.0.0.1:11383
export PATH="$kingmaker/app/Resources/bin:$PATH"
export CSC_IDENTITY_AUTO_DISCOVERY=false SOLOMON_RELEASE_SIGNING=local-unsigned SOLOMON_SIGNING_IDENTITY=-
export SOLOMON_REQUIRE_FULL_RUNTIME=1 SOLOMON_NORTHSTAR_FORCE_MODELS=0
unset SOLOMON_NEMO_STANDALONE SOLOMON_SKIP_PACKAGE_PREP SOLOMON_PROVISION_DRY_RUN
cd "$engine"
test ! -e desktop/build
npm ci
npm --prefix server ci
npm --prefix app ci
npm run package:prep

# Establish the wheel's provenance from the exact engine recipe, before
# installing it. This is an upstream input pin, not a previous build's binary.
wheel_pin="$(node --input-type=module -e '
  import {readFileSync} from "node:fs";
  const recipe = readFileSync("scripts/solomon-build-guardrails-runtime.mjs","utf8");
  const pin = recipe.match(/const WHEEL_SHA256 = .([0-9a-f]{64}).;/);
  if (!pin) process.exit(1);
  console.log(pin[1]);')"
python3.13 -m venv "$scratch/nemo-wheel-fetch"
mkdir "$scratch/wheel"
"$scratch/nemo-wheel-fetch/bin/python" -m pip download --no-deps --only-binary=:all: --dest "$scratch/wheel" 'nemoguardrails==0.23.0'
wheel="$scratch/wheel/nemoguardrails-0.23.0-py3-none-any.whl"
printf '%s  %s\n' "$wheel_pin" "$wheel" | shasum -a 256 -c -

# Pinned TSS recipes select required voice and NeMo inputs, not every optional
# bundle. Isolated uv and Python caches may not escape this build session.
SOLOMON_VOICE_BUNDLE=lean SOLOMON_PROVISION_BUNDLES=voice,agent \
SOLOMON_PROVISION_ONLY=whisper.cpp,fluid-audio,sherpa-onnx,kokoro,venv-wake,venv-kokoro-onnx,voice-models,venv-nemo \
SOLOMON_PROVISION_SKIP_SETUP=1 PIP_FIND_LINKS="$scratch/wheel" npm run provision
test -x "$SOLOMON_UPSTREAM_ROOT/venv-nemo/bin/pyinstaller"
"$SOLOMON_UPSTREAM_ROOT/venv-nemo/bin/python" -m pip install --no-deps --force-reinstall "$wheel"
node scripts/solomon-build-guardrails-runtime.mjs

# Confirm the newly staged executable matches this run's builder metadata.
# Signing can rewrite a Mach-O section later; record both distinct digests,
# never substitute an earlier package's output pin.
node --input-type=module - "$scratch/guardrails-pre-sign.json" "$wheel_pin" <<'NODE'
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream, readFileSync, writeFileSync} from 'node:fs';
const root = 'desktop/build/guardrails-runtime';
const meta = JSON.parse(readFileSync(root + '/runtime-manifest.json'));
const hash = createHash('sha256');
let bytes = 0;
for await (const chunk of createReadStream(root + '/solomon-guardrails')) {
  hash.update(chunk); bytes += chunk.length;
}
const preSignSha256 = hash.digest('hex');
assert.equal(meta.executable, 'solomon-guardrails');
assert.equal(meta.executableSha256, preSignSha256);
assert.equal(meta.executableSizeBytes, bytes);
writeFileSync(process.argv[2], JSON.stringify({preSignSha256,bytes,wheelSha256:process.argv[3]})+'\n',{flag:'wx'});
NODE
lipo -verify_arch arm64 desktop/build/guardrails-runtime/solomon-guardrails

npm --prefix server exec -- playwright install --only-shell chromium
node scripts/solomon-stage-browser-runtime.mjs

# Exact upstream North-Star bootstrap also stages its local test models. Use a
# loopback-only disposable Ollama; never borrow a service or prior model store.
if curl --noproxy '*' -fsS --max-time 2 "http://$OLLAMA_HOST/api/version" >/dev/null 2>&1; then
  echo "Refusing to use an existing Ollama service" >&2
  exit 1
fi
# This pinned bootstrap pulls Docker service images if a daemon is reachable.
# Require the dedicated assembly host to have no live daemon for this lane.
if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
  echo "Refusing to use a live Docker daemon for private assembly" >&2
  exit 1
fi
ollama serve >"$scratch/ollama.log" 2>&1 &
ollama_pid=$!
trap 'kill "$ollama_pid" 2>/dev/null || true; wait "$ollama_pid" 2>/dev/null || true' EXIT
for n in {1..25}; do
  kill -0 "$ollama_pid" 2>/dev/null || exit 1
  if curl --noproxy '*' -fsS --max-time 2 "http://$OLLAMA_HOST/api/version" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl --noproxy '*' -fsS --max-time 2 "http://$OLLAMA_HOST/api/version" >/dev/null
npm run solomon:bootstrap-northstar-tools

# package:prep clears desktop/build; it already ran before provisioning.
test -s desktop/build/knowledge-runtime/northstar-tools-manifest.json
test -s desktop/build/playwright-browsers/solomon-runtime-manifest.json
test -s desktop/build/guardrails-config/policy-manifest.json
test -s desktop/build/voice-runtime/manifest.json
SOLOMON_SKIP_PACKAGE_PREP=true SOL_GHOST_SOURCE="$kingmaker" npm run package:ghost
