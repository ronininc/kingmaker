#!/usr/bin/env bash
# Run on a disposable Linux build runner with Python 3.12, cmake and a compiler.
set -euo pipefail

housing="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
scratch="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/open-jev.XXXXXXXX")"
printf 'Build workspace: %s\n' "$scratch"
export TMPDIR="$scratch"
cd "$scratch"

require_space() {
  local available
  available="$(df -Pk "$scratch" | awk 'NR == 2 {print $4}')"
  if (( available < $1 * 1024 * 1024 )); then
    printf 'Need at least %s GiB free on the disposable build volume\n' "$1" >&2
    exit 1
  fi
}

fetch() {
  local url="$1" file="$2" hash="$3"
  curl -fsSL --retry 4 --output "$file" "$url"
  printf '%s  %s\n' "$hash" "$file" | sha256sum -c -
}

base="https://huggingface.co/Qwen/Qwen3.5-2B/resolve/15852e8c16360a2fea060d615a32b45270f8a8fc"
adapter="https://huggingface.co/ZefanCai/Open-Jev-2B/resolve/0c7aa498b1627be8da4acf34c863ff0ee0a92785"
llama_commit="161755f29e415e2c33efe906e91843c068efd664"
jev_commit="bd4118882f733574a3250a4b65fe4d884130c08b"

require_space 14
git clone --quiet --depth 1 --branch b11081 https://github.com/ggml-org/llama.cpp.git llama.cpp
test "$(git -C llama.cpp rev-parse HEAD)" = "$llama_commit"
cmake -S llama.cpp -B llama.cpp/build -DCMAKE_BUILD_TYPE=Release \
  -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_SERVER=OFF -DLLAMA_CURL=OFF -DGGML_NATIVE=OFF
cmake --build llama.cpp/build --target llama-quantize llama-embedding --parallel 2
python -m venv venv
venv/bin/python -m pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch==2.11.0
venv/bin/python -m pip install --no-cache-dir -r llama.cpp/requirements/requirements-convert_hf_to_gguf.txt safetensors==0.7.0

require_space 10
base_dir="src/qwen3.5-2b"
adapter_dir="src/open-jev-2b/package/checkpoint/adapter"
merged="work/merged"
mkdir -p "$base_dir" "$adapter_dir" "$merged" receipts
while read -r file hash; do
  fetch "$base/$file" "$base_dir/$file" "$hash"
done <<'PINS'
config.json ed1c1723241f23f7f4e23430759cbd7dcfb4103cbdfe052bfe7626b57c2615b4
model.safetensors.index.json aca8afed9da75b0f050b408d270766fd77627f1af401e240f61c3b47d0db02f9
tokenizer.json 5f9e4d4901a92b997e463c1f46055088b6cca5ca61a6522d1b9f64c4bb81cb42
tokenizer_config.json 49e2b6e395f959f077f1e992b338919c0d4a9732fc6e613995e06557f843500c
chat_template.jinja 273d8e0e683b885071fb17e08d71e5f2a5ddfb5309756181681de4f5a1822d80
merges.txt a9d356d7bdf1ef4949e3e748e95b8e10ad9d4e2e838eddc38a0a7b6b94d1db8d
vocab.json ce99b4cb2983d118806ce0a8b777a35b093e2000a503ebde25853284c9dfa003
model.safetensors-00001-of-00001.safetensors aa33250c4fc64891ddfaba3a314fd9542ea371843c387178b425fbcc5ed680b1
PINS

fetch "$adapter/package/checkpoint/adapter/adapter_model.safetensors" \
  "$adapter_dir/adapter_model.safetensors" 2d23935b1a7380db444abac572c04646918ba794e59002d1588236182a3ca18f
cp "$base_dir"/{config.json,tokenizer.json,tokenizer_config.json,chat_template.jinja,merges.txt,vocab.json} "$merged/"
venv/bin/python "$housing/tools/merge.py" | tee receipts/merge.log
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$housing/tools" venv/bin/python -c \
  "from pathlib import Path; from rebuild_gguf import verify_checkpoint; verify_checkpoint(Path('work/merged'))"
unlink "$base_dir/model.safetensors-00001-of-00001.safetensors"

require_space 9
venv/bin/python "$housing/tools/rebuild_gguf.py" --llama-cpp llama.cpp --merged "$merged" --out artifact
unlink artifact/open-jev-2b-merged-b11081-f16.gguf
cp receipts/merge-receipt.json artifact/
for shard in "$merged"/model-?????-of-?????.safetensors; do
  unlink "$shard"
done
(
  cd artifact
  sha256sum open-jev-2b-merged-b11081-q4_k_m.gguf > SHA256SUMS
)

git init --quiet jev-source
git -C jev-source fetch --quiet --depth 1 https://github.com/Zefan-Cai/Open-Jev.git "$jev_commit"
git -C jev-source checkout --quiet --detach FETCH_HEAD
test "$(git -C jev-source rev-parse HEAD)" = "$jev_commit"
venv/bin/python "$housing/tools/gguf_prep_texts.py" --jev-source jev-source \
  --tokenizer "$base_dir" --fixtures "$housing/fixtures.json" --out prompts
venv/bin/python "$housing/tools/gguf_score_min.py" --fresh --label q4_k_m \
  --gguf artifact/open-jev-2b-merged-b11081-q4_k_m.gguf \
  --embedding ./llama.cpp/build/bin/llama-embedding --texts prompts \
  --reference "$housing/receipts/score-unmerged.json" --out artifact/score.json

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  printf 'artifact=%s/artifact\n' "$scratch" >> "$GITHUB_OUTPUT"
fi
printf 'Workflow artifact directory: %s/artifact\n' "$scratch"
