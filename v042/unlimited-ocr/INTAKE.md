# Unlimited-OCR — Cage intake (2026-10-21, finish plan Phase 3)

**What it is.** baidu/Unlimited-OCR — one-shot long-document parsing: a
100-page PDF in a single pass with layout, tables, and formulas preserved
(DeepSeek-OCR / PaddleOCR lineage). Fit: the ingestion pipeline + the
universal file handler — the "read enormous documents, write minimally"
doctrine in engine form. Source reel: @kathrynpetrillo.ai, 2026-10-20.

**Pins (verified live 2026-10-21).**
- Repo: github.com/baidu/Unlimited-OCR @ `92ad94b53a51950fea0416aced42331dfb4dd59e` (2026-10-12)
- License: **MIT** (verified from the repo's LICENSE file: "MIT License, Copyright (c) 2026 Baidu")
- Model: huggingface.co/baidu/Unlimited-OCR @ revision `8249d20b2822a7d8a4c22c8d8c9069b5ac36bda3`
- Paper: arXiv 2606.23050 · ~28k stars at intake

**The gate (why this is an intake, not an install).**
1. **CUDA-only upstream.** Every documented inference path (Transformers /
   vLLM / SGLang) requires CUDA. No MLX, GGUF, or Apple Silicon path
   exists. NOT promised inside the Mac build.
2. **trust_remote_code = True.** The model repo ships executable Python
   (configuration_deepseek_v2.py and friends) that the loader runs. Cage
   rule: the code is vendored at the pinned commit and loaded from the
   local snapshot only; runtime hub downloads are refused by the
   contract (`lib/unlimited-ocr-contract.mjs`).

**Disposition.**
- **cuda-node lane: ADMITTED** under the contract (pinned, vendored,
  document-inputs only) — the EAGLE-4 pattern: a governed external lane
  on GPU hardware, never linked into the Mac build.
- **Apple Silicon: PARKED** behind the feasibility spike below.

**Mac feasibility spike (run sheet — the spike is a Mac-side job).**
1. From the pinned revision, attempt a conversion: MLX (mlx-vlm class
   port of the DeepSeek-OCR architecture) or llama.cpp-vision. Time-box:
   one working session; a hard blocker (unsupported op with no fallback)
   ends the spike as a FAIL, recorded, not retried silently.
2. On the 8 GB M3 profile, parse a 10-page mixed PDF (text + table +
   formula). Record: completion, peak memory, wall time.
3. Diff the output against the CUDA reference output for the same
   document (table row/column fidelity spot-check).
4. PASS = all SPIKE_PASS_CRITERIA in the contract. File the receipt here;
   only then is the contract amended to admit `apple-silicon`.

**Contract tests:** `tests/run-tests.mjs` (10 checks).
