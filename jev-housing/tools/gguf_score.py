#!/usr/bin/env python3
"""Score Jev fixtures through a GGUF in llama.cpp: llama-embedding
--pooling none emits per-token final hidden states; the last token's
vector goes through Jev's fp32 scalar head (head.pt) exactly as in the
HF path. Emits the same result shape as score.py plus, when a reference
receipt is given, per-record deltas and decision flips.
"""
import argparse, json, subprocess, sys, tempfile, os
sys.path.insert(0, "work/open-jev-src")
import numpy as np
from jev.api import compile_request, candidate_prompts
from jev.metrics import softmax

TEMPERATURE = 1.518796342858676
LLAMA_EMB = "work/llama.cpp/build/bin/llama-embedding"

def extract_json_array(text):
    # llama-embedding logs interleave with the JSON; find the last
    # top-level array that parses.
    for start in range(len(text) - 1, -1, -1):
        if text[start] == "[":
            try:
                val, _ = json.JSONDecoder().raw_decode(text[start:])
                if isinstance(val, list) and val and isinstance(val[0], list):
                    return val
            except Exception:
                continue
    raise SystemExit("no JSON array found in llama-embedding output")

def gguf_logits(gguf, texts, head_w, head_b):
    logits = []
    for text in texts:
        with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
            f.write(text)
            path = f.name
        try:
            r = subprocess.run(
                [LLAMA_EMB, "-m", gguf, "-f", path, "--pooling", "none",
                 "--embd-output-format", "array", "--embd-normalize", "-1",
                 "-c", "512", "-b", "512", "--no-warmup"],
                capture_output=True, text=True, timeout=900)
        finally:
            os.unlink(path)
        if r.returncode != 0:
            raise SystemExit(f"llama-embedding failed rc={r.returncode}: {r.stderr[-800:]}")
        arr = extract_json_array(r.stdout + "\n" + r.stderr)
        last = np.asarray(arr[-1], dtype=np.float64)
        assert last.shape == (2048,), f"hidden dim {last.shape}"
        logits.append(float(last @ head_w + head_b))
        print(f"  tokens={len(arr)} logit={logits[-1]:.4f}", flush=True)
    return logits

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gguf", required=True)
    ap.add_argument("--label", required=True)
    ap.add_argument("--fixtures", default="work/fixtures.json")
    ap.add_argument("--head", default="src/open-jev-2b/package/checkpoint/head.pt")
    ap.add_argument("--reference", default=None)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    from transformers import AutoTokenizer
    # fast tokenizer: string-identical to the slow one (proven in score.py)
    tokenizer = AutoTokenizer.from_pretrained("src/qwen3.5-2b-fasttok")
    # Head: prefer the portable float64 numpy extraction — value-identical
    # to head.pt (route/house.py `head` verifies byte equality) — so torch
    # stays out of the harness and llama-embedding gets the memory.
    from pathlib import Path
    if Path("work/head_w.npy").exists() and Path("work/head_b.npy").exists():
        head_w = np.load("work/head_w.npy").reshape(-1)
        head_b = float(np.load("work/head_b.npy")[0])
    else:
        import torch
        sd = torch.load(args.head, map_location="cpu", weights_only=True)
        head_w = sd["weight"].numpy().astype(np.float64).reshape(-1)
        head_b = float(sd["bias"][0])

    fixtures = json.load(open(args.fixtures))
    results = []
    for fx in fixtures["requests"]:
        for rec in compile_request(state=fx["state"], questions=fx["questions"]):
            prompts = candidate_prompts(rec)
            texts = [tokenizer.apply_chat_template(
                [{"role": "user", "content": p}], tokenize=False,
                add_generation_prompt=True, enable_thinking=False) for p in prompts]
            print(f"{args.label} {fx['name']}/{rec['id']} ({len(texts)} candidates)", flush=True)
            logits = gguf_logits(args.gguf, texts, head_w, head_b)
            raw = [0.0, logits[0]] if rec["kind"] == "noul" else logits
            probs = softmax([float(x) for x in raw], TEMPERATURE)
            results.append({"fixture": fx["name"], "key": rec["id"], "kind": rec["kind"],
                            "option_keys": rec["answer_keys"],
                            "logits": raw if rec["kind"] != "noul" else logits,
                            "probabilities": probs})
    payload = {"mode": f"gguf-{args.label}", "temperature": TEMPERATURE, "results": results}
    if args.reference:
        ref = {(r["fixture"], r["key"]): r for r in json.load(open(args.reference))["results"]}
        cmp_rows, flips = [], []
        for r in results:
            q = ref[(r["fixture"], r["key"])]
            dl = max(abs(a - b) for a, b in zip(r["logits"], q["logits"]))
            dp = max(abs(a - b) for a, b in zip(r["probabilities"], q["probabilities"]))
            dec = int(np.argmax(r["probabilities"])); dec_ref = int(np.argmax(q["probabilities"]))
            if dec != dec_ref:
                flips.append({"fixture": r["fixture"], "key": r["key"],
                              "ref_decision": q["option_keys"][dec_ref],
                              "gguf_decision": r["option_keys"][dec]})
            cmp_rows.append({"fixture": r["fixture"], "key": r["key"],
                             "max_abs_logit_delta": dl, "max_abs_prob_delta": dp})
        payload["comparison_vs_reference"] = {
            "reference": args.reference, "rows": cmp_rows, "decision_flips": flips,
            "worst_logit_delta": max(x["max_abs_logit_delta"] for x in cmp_rows),
            "worst_prob_delta": max(x["max_abs_prob_delta"] for x in cmp_rows)}
        print("WORST logit delta:", payload["comparison_vs_reference"]["worst_logit_delta"],
              "| flips:", flips, flush=True)
    json.dump(payload, open(args.out, "w"), indent=1)
    print("GGUF SCORE DONE ->", args.out)

if __name__ == "__main__":
    main()
