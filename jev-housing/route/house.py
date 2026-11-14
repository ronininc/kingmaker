#!/usr/bin/env python3
"""Format-agnostic housing route for Open-Jev-2B (Kingmaker asset housing).

Owner correction 2026-11-14 04:10 MST (binding): the housing/conversion
route is FORMAT-AGNOSTIC. The base model + LoRA adapter are housed and
merged ONCE into a canonical merged checkpoint; each serving format is
then emitted per-target behind the target registry below. GGUF is one
target among several, not the pipeline. The scalar decision head is a
separate fp32 artifact (head.pt / head_w.npy / head_b.npy) whose wiring
rides whichever target is emitted — every target scorer applies the
same head math to that target's last-token final hidden state.

Pipeline (all paths relative to the build workspace root):

  fetch   bay_fetch.py: base + adapter from Hugging Bay, sha256-pinned
          (proven: receipts/adapter-fetch.log, receipts/base-fetch.log,
          "ALL PINS MATCH" on both)
  merge   work/merge.py: W' = W + 2.0 * (B @ A) in fp32 -> bf16, sharded
          -> work/merged/ (the canonical merged checkpoint; this IS the
          safetensors target artifact)
  head    head.pt -> work/head_w.npy + work/head_b.npy (float64 numpy
          form for non-torch targets; torch targets load head.pt via
          work/score.py / work/gguf_score.py)
  emit    per target (registry below)
  verify  per target (registry below): safetensors = behavioral score
          comparison vs the unmerged reference path; gguf = weight-level
          tensor comparison vs the merged checkpoint + behavioral score
          where the node can run it; mlx = behavioral score comparison
          vs the unmerged reference path

Targets are declared once in TARGETS; adding a format = adding one
registry entry, never a new pipeline. Every step shells out to the
proven per-step implementation, streams output to receipts/route-*.log,
and refuses to overwrite an existing artifact unless --force is given.

GGUF behavioral scoring runs two-phase (gguf_prep_texts.py, then the
numpy-only gguf_score_min.py): on memory-tight nodes the original
single-process scorer (work/gguf_score.py, torch + transformers in the
harness) was OOM-killed alongside llama-embedding three times; the
two-phase form keeps the harness at ~100 MB. Same fixtures, same head,
same comparison.

Usage (from the workspace root):
  python3 route/house.py targets
  python3 route/house.py merge
  python3 route/house.py head
  python3 route/house.py emit   --target gguf-q4_k_m
  python3 route/house.py verify --target gguf-f16
  python3 route/house.py score  --target mlx
  python3 route/house.py verify --target safetensors   (receipt compare)
"""
import argparse, json, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VENV = "venv/bin/python"
VENV_MLX = "venv-mlx/bin/python"
HEAD_PT = "src/open-jev-2b/package/checkpoint/head.pt"
REFERENCE = "receipts/score-unmerged.json"

def run(cmd, log_name):
    log_path = ROOT / "receipts" / log_name
    print("+", " ".join(cmd), f"(log: receipts/{log_name})", flush=True)
    with open(log_path, "w") as log:
        r = subprocess.run(cmd, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
    if r.returncode != 0:
        tail = log_path.read_text(errors="replace")[-600:]
        raise SystemExit(f"step failed rc={r.returncode}; log tail:\n{tail}")
    print("  ok")

def guard(paths, force):
    if force:
        return
    for p in paths:
        if (ROOT / p).exists():
            raise SystemExit(f"artifact exists, refusing to overwrite without --force: {p}")

# ---------------------------------------------------------------- targets
# Each target: what it is, where its bytes live, how it is emitted from
# the canonical merged checkpoint, and how it is verified. The scalar
# head wiring is part of every scorer (never part of the weights file).

TARGETS = {
    "safetensors": {
        "class": "Transformers / vLLM",
        "artifacts": ["work/merged/ (3 shards, model.safetensors.index.json)"],
        "emit": [],  # the merge step itself produces this target
        "verify": [("compare", None)],
        "score": [[VENV, "work/score.py", "--mode", "merged",
                   "--backbone", "work/merged", "--head", HEAD_PT,
                   "--out", "receipts/score-merged-safetensors.json"]],
        "head_wiring": "torch nn.Linear(2048,1) loaded from head.pt (work/score.py)",
    },
    "gguf-f16": {
        "class": "llama.cpp / Ollama",
        "artifacts": ["work/gguf/open-jev-2b-merged-f16.gguf"],
        "emit": [[VENV, "work/llama.cpp/convert_hf_to_gguf.py", "work/merged",
                  "--outfile", "work/gguf/open-jev-2b-merged-f16.gguf",
                  "--outtype", "f16"]],
        "verify": [[VENV, "work/gguf_tensor_check.py", "f16",
                    "work/gguf/open-jev-2b-merged-f16.gguf"]],
        "score": [[VENV, "work/gguf_prep_texts.py"],
                  [VENV, "work/gguf_score_min.py", "--gguf",
                   "work/gguf/open-jev-2b-merged-f16.gguf", "--label", "f16",
                   "--reference", REFERENCE,
                   "--out", "receipts/score-gguf-f16.json"]],
        "head_wiring": "numpy head (head.pt -> float64) over llama-embedding "
                       "per-token hidden states (work/gguf_score.py)",
    },
    "gguf-q4_k_m": {
        "class": "llama.cpp / Ollama",
        "artifacts": ["work/gguf/open-jev-2b-merged-q4_k_m.gguf"],
        "emit": [["work/llama.cpp/build/bin/llama-quantize",
                  "work/gguf/open-jev-2b-merged-f16.gguf",
                  "work/gguf/open-jev-2b-merged-q4_k_m.gguf", "Q4_K_M"]],
        "verify": [[VENV, "work/gguf_tensor_check.py", "q4",
                    "work/gguf/open-jev-2b-merged-q4_k_m.gguf"]],
        "score": [[VENV, "work/gguf_prep_texts.py"],
                  [VENV, "work/gguf_score_min.py", "--gguf",
                   "work/gguf/open-jev-2b-merged-q4_k_m.gguf",
                   "--label", "q4_k_m", "--reference", REFERENCE,
                   "--out", "receipts/score-gguf-q4_k_m.json"]],
        "head_wiring": "numpy head (head.pt -> float64) over llama-embedding "
                       "per-token hidden states (work/gguf_score.py)",
    },
    "mlx": {
        "class": "MLX (Apple Silicon serving; conversion + scoring also run "
                 "on this Linux node via mlx CPU)",
        "artifacts": ["work/mlx/ (model.safetensors, text model only — the "
                      "vision tower is not carried; Jev scoring is text-only)"],
        "emit": [[VENV_MLX, "-m", "mlx_lm", "convert", "--hf-path", "work/merged",
                  "--mlx-path", "work/mlx", "--dtype", "bfloat16"]],
        "verify": [],  # behavioral score comparison IS this target's verify
        "score": [[VENV_MLX, "work/mlx_score.py",
                   "--out", "receipts/score-mlx.json"]],
        "head_wiring": "numpy head from work/head_w.npy + work/head_b.npy "
                       "over the mlx-lm inner model's hidden states "
                       "(work/mlx_score.py)",
    },
}

# ---------------------------------------------------------------- steps

def step_merge(force):
    guard(["work/merged/model-00001-of-00003.safetensors"], force)
    run([VENV, "work/merge.py"], "route-merge.log")

def step_head(force):
    """Extract the fp32 scalar head to float64 numpy form (idempotent;
    verifies byte-equality against any existing extraction)."""
    import numpy as np
    import torch  # run house.py itself under venv/bin/python for this step
    sd = torch.load(ROOT / HEAD_PT, map_location="cpu", weights_only=True)
    # flat (2048,) form: the shape every non-torch consumer uses
    w = sd["weight"].numpy().reshape(-1).astype(np.float64)
    b = sd["bias"].numpy().reshape(-1).astype(np.float64)
    assert w.shape == (2048,) and b.shape == (1,), (w.shape, b.shape)
    for name, arr in (("head_w.npy", w), ("head_b.npy", b)):
        p = ROOT / "work" / name
        if p.exists():
            old = np.load(p)
            assert np.array_equal(old, arr), f"{name}: existing extraction differs"
            print(f"  {name}: existing extraction verified identical")
        else:
            np.save(p, arr)
            print(f"  {name}: written {arr.shape} {arr.dtype}")

def step_compare():
    """safetensors verify: merged-checkpoint scores vs the unmerged
    reference path (base + PeftModel adapter), pure receipt math.
    Reproduces receipts/verify-safetensors.json from the two score
    receipts; asserts equality if that file already exists."""
    import numpy as np
    ref = {(r["fixture"], r["key"]): r
           for r in json.load(open(ROOT / REFERENCE))["results"]}
    got = json.load(open(ROOT / "receipts/score-merged-safetensors.json"))["results"]
    rows, flips = [], []
    for r in got:
        q = ref[(r["fixture"], r["key"])]
        dl = max(abs(a - b) for a, b in zip(r["logits"], q["logits"]))
        dp = max(abs(a - b) for a, b in zip(r["probabilities"], q["probabilities"]))
        if int(np.argmax(r["probabilities"])) != int(np.argmax(q["probabilities"])):
            flips.append([r["fixture"], r["key"]])
        rows.append({"fixture": r["fixture"], "key": r["key"],
                     "max_abs_logit_delta": dl, "max_abs_prob_delta": dp})
    payload = {"target": "safetensors (merged HF checkpoint, bf16)",
               "rows": rows,
               "worst_logit_delta": max(x["max_abs_logit_delta"] for x in rows),
               "worst_prob_delta": max(x["max_abs_prob_delta"] for x in rows),
               "decision_flips": flips}
    out = ROOT / "receipts/verify-safetensors.json"
    if out.exists():
        old = json.load(open(out))
        assert old == payload, "recomputed verify differs from existing receipt"
        print("  verify-safetensors.json: recomputed, identical to existing receipt")
    else:
        json.dump(payload, open(out, "w"), indent=1)
        print("  verify-safetensors.json: written")

def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("step", choices=["targets", "merge", "head", "emit",
                                     "verify", "score"])
    ap.add_argument("--target", choices=sorted(TARGETS))
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    if args.step == "targets":
        for name, t in TARGETS.items():
            print(f"{name:12s} {t['class']}")
            for a in t["artifacts"]:
                print(f"{'':12s} artifact: {a}")
            print(f"{'':12s} head: {t['head_wiring']}")
        return
    if args.step == "merge":
        step_merge(args.force); return
    if args.step == "head":
        step_head(args.force); return
    if not args.target:
        raise SystemExit(f"step {args.step} needs --target")
    t = TARGETS[args.target]
    cmds = t[args.step]
    if args.step == "emit":
        arts = [a.split(" ")[0].rstrip("/") for a in t["artifacts"]]
        guard([a for a in arts if not a.endswith("/")], args.force)
    if not cmds:
        print(f"target {args.target}: no {args.step} commands "
              f"(see BUILD-REPORT.md for how this target is verified)")
        return
    for cmd in cmds:
        if cmd[0] == "compare":
            step_compare()
        else:
            run(cmd, f"route-{args.step}-{args.target}.log")

if __name__ == "__main__":
    main()
