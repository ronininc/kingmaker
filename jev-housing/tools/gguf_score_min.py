#!/usr/bin/env python3
"""Phase 2 of the low-memory GGUF behavioral score: for each prepared
text, run llama-embedding (subprocess, one at a time), take the last
token's hidden state, apply the fp32 scalar head from the portable
float64 numpy extraction, and emit the same payload + reference
comparison as gguf_score.py. Imports numpy only — no torch, no
transformers — so the harness stays ~100 MB and the embedding process
gets the node's memory. Writes results incrementally per record.

Usage: gguf_score_min.py --gguf <file> --label q4_k_m \
         --reference receipts/score-unmerged.json \
         --out receipts/score-gguf-q4_k_m.json
"""
import argparse, json, subprocess, sys
from pathlib import Path
import numpy as np

TEMPERATURE = 1.518796342858676
LLAMA_EMB = "work/llama.cpp/build/bin/llama-embedding"
TEXTS = Path("work/gguf_texts")

def softmax(logits, temperature):
    v = np.asarray(logits, dtype=np.float64) / temperature
    v = v - v.max()
    e = np.exp(v)
    return (e / e.sum()).tolist()

def extract_json_array(text):
    for start in range(len(text) - 1, -1, -1):
        if text[start] == "[":
            try:
                val, _ = json.JSONDecoder().raw_decode(text[start:])
                if isinstance(val, list) and val and isinstance(val[0], list):
                    return val
            except Exception:
                continue
    raise SystemExit("no JSON array found in llama-embedding output")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gguf", required=True)
    ap.add_argument("--label", required=True)
    ap.add_argument("--reference", default=None)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    head_w = np.load("work/head_w.npy").reshape(-1)
    head_b = float(np.load("work/head_b.npy")[0])
    manifest = json.load(open(TEXTS / "manifest.json"))

    results, done = [], set()
    if Path(args.out).exists():
        prev = json.load(open(args.out))
        results = prev.get("results", [])
        done = {(r["fixture"], r["key"]) for r in results}
        print(f"resuming: {len(results)} records already scored", flush=True)
    for rec in manifest:
        if (rec["fixture"], rec["key"]) in done:
            continue
        logits = []
        for name in rec["files"]:
            r = subprocess.run(
                [LLAMA_EMB, "-m", args.gguf, "-f", str(TEXTS / name),
                 "--pooling", "none", "--embd-output-format", "array",
                 "--embd-normalize", "-1", "-c", "512", "-b", "512",
                 "--no-warmup"],
                capture_output=True, text=True, timeout=900)
            if r.returncode != 0:
                raise SystemExit(f"llama-embedding failed rc={r.returncode}: "
                                 f"{r.stderr[-500:]}")
            arr = extract_json_array(r.stdout + "\n" + r.stderr)
            last = np.asarray(arr[-1], dtype=np.float64)
            assert last.shape == (2048,), last.shape
            logits.append(float(last @ head_w + head_b))
        raw = [0.0, logits[0]] if rec["kind"] == "noul" else logits
        probs = softmax([float(x) for x in raw], TEMPERATURE)
        results.append({"fixture": rec["fixture"], "key": rec["key"],
                        "kind": rec["kind"], "option_keys": rec["option_keys"],
                        "logits": raw if rec["kind"] != "noul" else logits,
                        "probabilities": probs})
        json.dump({"mode": f"gguf-{args.label}", "temperature": TEMPERATURE,
                   "results": results}, open(args.out, "w"), indent=1)
        print(f"RECORD {rec['fixture']} {rec['key']} "
              f"probs={[round(p, 4) for p in probs]}", flush=True)
    payload = {"mode": f"gguf-{args.label}", "temperature": TEMPERATURE,
               "results": results}
    if args.reference:
        ref = {(r["fixture"], r["key"]): r
               for r in json.load(open(args.reference))["results"]}
        rows, flips = [], []
        for r in results:
            q = ref[(r["fixture"], r["key"])]
            dl = max(abs(a - b) for a, b in zip(r["logits"], q["logits"]))
            dp = max(abs(a - b) for a, b in zip(r["probabilities"], q["probabilities"]))
            if int(np.argmax(r["probabilities"])) != int(np.argmax(q["probabilities"])):
                flips.append({"fixture": r["fixture"], "key": r["key"]})
            rows.append({"fixture": r["fixture"], "key": r["key"],
                         "max_abs_logit_delta": dl, "max_abs_prob_delta": dp})
        payload["comparison_vs_reference"] = {
            "reference": args.reference, "rows": rows, "decision_flips": flips,
            "worst_logit_delta": max(x["max_abs_logit_delta"] for x in rows),
            "worst_prob_delta": max(x["max_abs_prob_delta"] for x in rows)}
        print("WORST |dlogit|:", payload["comparison_vs_reference"]["worst_logit_delta"],
              "| flips:", flips, flush=True)
    json.dump(payload, open(args.out, "w"), indent=1)
    print("GGUF SCORE (min) DONE ->", args.out)

if __name__ == "__main__":
    main()
