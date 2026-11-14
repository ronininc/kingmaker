#!/usr/bin/env python3
"""Score Jev fixtures through the MLX target: mlx-lm qwen3_5 inner model
-> last-token final hidden state -> Jev fp32 head (numpy) -> calibrated
probabilities. Same result shape + comparison as the other targets.
Tokenization: the proven-identical fast tokenizer (HF) builds the ids;
MLX consumes ids directly, one sequence at a time (no padding).
"""
import argparse, json, sys
from pathlib import Path
sys.path.insert(0, "work/open-jev-src")
import numpy as np
from jev.api import compile_request, candidate_prompts

TEMPERATURE = 1.518796342858676

def softmax(logits, temperature):
    # identical math to jev.metrics.softmax (float64 torch.softmax(x / T))
    v = np.asarray(logits, dtype=np.float64) / temperature
    v = v - v.max()
    e = np.exp(v)
    return (e / e.sum()).tolist()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mlx-dir", default="work/mlx")
    ap.add_argument("--fixtures", default="work/fixtures.json")
    ap.add_argument("--head", default="src/open-jev-2b/package/checkpoint/head.pt")
    ap.add_argument("--reference", default="receipts/score-unmerged.json")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    import mlx.core as mx
    from mlx_lm.utils import load_model
    from transformers import AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained("src/qwen3.5-2b-fasttok")
    model, cfg = load_model(Path(args.mlx_dir))
    # find the inner text model whose call returns hidden states
    inner = None
    for path in ("model", "language_model", "language_model.model", "model.model"):
        obj = model
        try:
            for part in path.split("."):
                obj = getattr(obj, part)
            inner = obj
            print("inner model via:", path, type(obj).__name__, flush=True)
            break
        except AttributeError:
            continue
    if inner is None:
        raise SystemExit("could not locate inner text model on mlx model")

    head_w = np.load("work/head_w.npy")
    head_b = float(np.load("work/head_b.npy")[0])

    fixtures = json.load(open(args.fixtures))
    results = []
    done_keys = set()
    if Path(args.out).exists():
        prev = json.load(open(args.out))
        results = prev.get("results", [])
        done_keys = {(r["fixture"], r["key"]) for r in results}
        print(f"resuming: {len(results)} records already scored", flush=True)
    for fx in fixtures["requests"]:
        for rec in compile_request(state=fx["state"], questions=fx["questions"]):
            if (fx["name"], rec["id"]) in done_keys:
                continue
            prompts = candidate_prompts(rec)
            logits = []
            for p in prompts:
                s = tokenizer.apply_chat_template(
                    [{"role": "user", "content": p}], tokenize=False,
                    add_generation_prompt=True, enable_thinking=False)
                ids = tokenizer(s, add_special_tokens=False)["input_ids"]
                x = mx.array([ids])
                h = inner(x)
                if isinstance(h, (tuple, list)):
                    h = h[0]
                mx.eval(h)
                last = np.asarray(h[0, -1].astype(mx.float32), dtype=np.float64)
                assert last.shape == (2048,), last.shape
                logits.append(float(last @ head_w + head_b))
                mx.clear_cache()
            raw = [0.0, logits[0]] if rec["kind"] == "noul" else logits
            probs = softmax([float(v) for v in raw], TEMPERATURE)
            results.append({"fixture": fx["name"], "key": rec["id"], "kind": rec["kind"],
                            "option_keys": rec["answer_keys"],
                            "logits": raw if rec["kind"] != "noul" else logits,
                            "probabilities": probs})
            json.dump({"mode": "mlx-bf16", "temperature": TEMPERATURE, "results": results},
                      open(args.out, "w"), indent=1)
            print(f"RECORD {fx['name']} {rec['id']} probs={[round(p,4) for p in probs]}", flush=True)
    payload = {"mode": "mlx-bf16", "temperature": TEMPERATURE, "results": results}
    if args.reference:
        ref = {(r["fixture"], r["key"]): r for r in json.load(open(args.reference))["results"]}
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
            "rows": rows, "decision_flips": flips,
            "worst_logit_delta": max(x["max_abs_logit_delta"] for x in rows),
            "worst_prob_delta": max(x["max_abs_prob_delta"] for x in rows)}
        print("WORST |dlogit|:", payload["comparison_vs_reference"]["worst_logit_delta"],
              "| flips:", flips, flush=True)
    json.dump(payload, open(args.out, "w"), indent=1)
    print("MLX SCORE DONE ->", args.out)

if __name__ == "__main__":
    main()
