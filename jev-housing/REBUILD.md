# Rebuild and verify Open-JEV on the 8 GB Mac

The November 14 GGUF has fused `ssm_beta_alpha` and `attn_qkv_gate` tensors. The owner’s Ollama 0.34.4 stopped at the missing `blk.0.ssm_beta.weight`. Ollama 0.34.4 and 0.35.0 both pin llama.cpp b11081, commit `161755f29e415e2c33efe906e91843c068efd664`. Build the split-tensor GGUF from the canonical safetensors with that converter. [Ollama 0.34.4 pin](https://github.com/ollama/ollama/blob/v0.34.4/LLAMA_CPP_VERSION), [Ollama 0.35.0 pin](https://github.com/ollama/ollama/blob/v0.35.0/LLAMA_CPP_VERSION), [llama.cpp tensor layout change](https://github.com/ggml-org/llama.cpp/pull/32102).

## Disposable Linux build

The manual **Rebuild Open-JEV GGUF** Actions workflow builds and scores on Ubuntu 24.04, then uploads the Q4 GGUF, SHA-256 list, rebuild and score receipts, and conversion logs as a seven-day workflow artifact. Workflow dispatch requires the workflow definition on the repository’s default branch. The same build can run directly on a disposable Linux runner with Python 3.12, CMake, a C++ compiler and sufficient scratch space.

```sh
RUNNER_TEMP=/path/to/disposable/volume bash jev-housing/tools/rebuild_on_runner.sh
```

The runner pins all downloaded weights and Qwen tokenizer files, checks the regenerated shards, config and index against [housing-manifest.json](housing-manifest.json), then checks every linear-attention layer for the split tensors in both F16 and Q4. It removes the downloaded base after the merged checkpoint matches its pins and removes the staged F16 and shards after quantization and hashing. The runner requires 14 GiB free before setup and rechecks space before merge and conversion. It uses CPU PyTorch and builds only the necessary llama.cpp tool targets. The runner has no publishing credentials.

- The official [Qwen base checkpoint](https://huggingface.co/Qwen/Qwen3.5-2B/tree/15852e8c16360a2fea060d615a32b45270f8a8fc) contains the 4,548,221,488-byte base safetensors. The [Open-JEV adapter package](https://huggingface.co/ZefanCai/Open-Jev-2B/tree/0c7aa498b1627be8da4acf34c863ff0ee0a92785) contains the 10,042,480-byte LoRA adapter. Upstream LFS metadata matched the recorded weight pins.
- The runner uses the repo’s [head arrays](head/) and the [official Open-JEV loader source](https://github.com/Zefan-Cai/Open-Jev/tree/bd4118882f733574a3250a4b65fe4d884130c08b) for fixture prompt construction. Keep the receipt hashes with the GGUF. The workflow must pass the canonical checkpoint pins before producing a candidate. Cross-runner reproducibility of those shard hashes remains to be demonstrated.
- With an existing canonical merged directory, use the smaller entry point below. Supply the verified shard, config and index files plus the pinned Qwen tokenizer sidecars from the runner script. Use the converter dependencies listed in the pinned llama.cpp checkout. Build `llama-quantize` and `llama-embedding` into its `build/bin`.

```sh
python jev-housing/tools/rebuild_gguf.py \
  --llama-cpp /path/to/llama.cpp --merged /path/to/canonical/merged \
  --out /path/to/new/internal-output-directory
```

## Mac load and numeric score verification

Keep the candidate GGUF on internal storage and use `SHA256SUMS` to identify it. On the owner’s Mac, use a separate local Ollama server with an internal model directory and a fresh tag. Point the Ollama CLI and the following request at that server. Stage a Modelfile with one `FROM /absolute/path/to/open-jev-2b-merged-b11081-q4_k_m.gguf` line.

```sh
OLLAMA_HOST=127.0.0.1:11439 ollama create open-jev-b11081-test -f Modelfile
curl --fail-with-body -sS http://127.0.0.1:11439/api/generate \
  -H 'Content-Type: application/json' \
  -d '{"model":"open-jev-b11081-test","stream":false,"options":{"num_ctx":512}}' \
  > ollama-load.json
jq -e '.done == true and .done_reason == "load" and (.error | not)' ollama-load.json
```

Record the serving runtime version and the candidate hash with that response. An empty prompt uses Ollama’s explicit load path. On an 8 GB Mac, unload the Ollama copy before starting the separate llama.cpp score process. Both tests use the same GGUF. [Ollama load implementation](https://github.com/ollama/ollama/blob/v0.34.4/server/routes.go).

Use the pinned Mac `llama-embedding` and the bundled NumPy head arrays for the numeric proof. The scorer reads the last unnormalized token vector and computes `w · hidden + b`. The prompt file must already contain the Open-JEV candidate prompt in the Qwen chat template. Compare the token count with the tokenizer to verify that the runtime consumed the complete prompt.

```sh
python jev-housing/tools/gguf_score_min.py \
  --gguf /path/to/open-jev-2b-merged-b11081-q4_k_m.gguf \
  --embedding /path/to/llama.cpp/build/bin/llama-embedding \
  --prompt-file /path/to/prepared-prompt.txt --expected-tokens 123
```

Single-prompt mode returns one JSON object on stdout and exits nonzero on rejection. Stable fields are `loaded`, `scored_through_head`, finite scalar `score`, `model_calls` (one forward pass), `tokens`, `elapsed_ms`, `peak_rss_bytes`, and `load_time_ms` (the runtime’s reported timer, or null). The artifact, prompt and head hashes identify the scored inputs. Elapsed time covers invocation and scoring. The child process exits after each invocation, so this CLI measures cold inference per turn. Measure swap and paired residency separately.

For a complete fixture receipt, prepare the checked-in fixtures with `tools/gguf_prep_texts.py` as in the runner script, then call the scorer with `--fresh --label q4_k_m --texts <prepared-directory> --reference jev-housing/receipts/score-unmerged.json --out <new-score-receipt.json>`. Review logit and probability deltas and decision flips. The reference’s `score-phish-confidence/phish_likelihood` is a documented near-tie.

The Ollama load and separate llama.cpp head proof still need to run on the owner’s Mac. The bundled head is external to the rebuilt GGUF. Ollama 0.35.0 introduced `/v1/systemone` for its supported decision architectures. Serving this external head over that endpoint requires its own integration and inference proof. [Ollama 0.35.0 release notes](https://github.com/ollama/ollama/releases/tag/v0.35.0).
