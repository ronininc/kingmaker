#!/usr/bin/env python3
"""Load a GGUF in llama-embedding and apply the housed Jev scalar head.

Run with --prompt-file for a single JSON proof or with --texts for a
behavioral comparison against the unmerged reference. The scorer uses NumPy
and starts one embedding process at a time.
"""
import argparse, json, math, re, resource, subprocess, sys, time
from pathlib import Path
import numpy as np
from rebuild_gguf import LLAMA_COMMIT, ROOT, sha256

TEMPERATURE = 1.518796342858676
LLAMA_EMB = "work/llama.cpp/build/bin/llama-embedding"
TEXTS = Path("work/gguf_texts")
HEAD_W = ROOT / "head/head_w.npy"
HEAD_B = ROOT / "head/head_b.npy"
SEPARATOR = "<|kingmaker-single-jev-prompt|>"


def softmax(logits, temperature):
    v = np.asarray(logits, dtype=np.float64) / temperature
    v = v - v.max()
    e = np.exp(v)
    return (e / e.sum()).tolist()


def extract_json_array(text):
    for match in re.finditer(r"\[\s*(?=\[)", text):
        try:
            val, _ = json.JSONDecoder().raw_decode(text, match.start())
        except json.JSONDecodeError:
            continue
        if val and all(isinstance(row, list) for row in val):
            return val
    raise SystemExit("no JSON array found in llama-embedding output")


def head_parameters():
    weight = np.load(HEAD_W, allow_pickle=False)
    bias = np.load(HEAD_B, allow_pickle=False)
    if weight.shape != (2048,) or bias.shape != (1,):
        raise SystemExit(f"unexpected JEV head shapes: {weight.shape}, {bias.shape}")
    if not np.isfinite(weight).all() or not np.isfinite(bias).all():
        raise SystemExit("JEV head contains non-finite values")
    return weight, float(bias[0])


def embedding_version(embedding):
    # On the 8 GB Mac the first Metal registry initialization can exceed ten
    # seconds while the card-backed median model remains resident.
    result = subprocess.run([embedding, "--version"], capture_output=True, text=True, timeout=60)
    build = result.stdout + result.stderr
    # b11081 reports either "commit 161755f" or the hash in parentheses,
    # depending on the build. Bind to the hash token, not its punctuation.
    if result.returncode or not re.search(rf"(?<![0-9a-f]){LLAMA_COMMIT[:7]}(?:[0-9a-f]{{0,33}})?(?![0-9a-f])", build):
        raise SystemExit(f"llama-embedding does not report the pinned build ({LLAMA_COMMIT}): {build.strip()}")
    return build.strip()


def score_prompt(embedding, gguf, prompt, head_w, head_b, expected_tokens=None):
    data = prompt.read_bytes()
    if not data or SEPARATOR.encode() in data:
        raise SystemExit(f"empty prompt or reserved separator in {prompt}")
    result = subprocess.run(
        [embedding, "-m", gguf, "--binary-file", str(prompt), "--no-escape",
         "--embd-separator", SEPARATOR, "--pooling", "none", "--embd-output-format", "array",
         "--override-kv", "tokenizer.ggml.add_bos_token=bool:false,tokenizer.ggml.add_eos_token=bool:false",
         "--embd-normalize", "-1", "-c", "512", "-b", "512", "--no-warmup"],
        capture_output=True, text=True, timeout=900)
    if result.returncode or re.search(r"batch_decode\s*:\s*failed to process", result.stderr):
        raise SystemExit(f"llama-embedding failed rc={result.returncode}: {result.stderr[-800:]}")
    rows = extract_json_array(result.stdout + "\n" + result.stderr)
    if expected_tokens is not None and len(rows) != expected_tokens:
        raise SystemExit(f"token count mismatch for {prompt}: expected {expected_tokens}, got {len(rows)}")
    try:
        hidden = np.asarray(rows, dtype=np.float64)
    except (TypeError, ValueError):
        raise SystemExit(f"invalid raw hidden states for {prompt}") from None
    if hidden.shape != (len(rows), 2048) or not np.isfinite(hidden).all() or not hidden[-1].any():
        raise SystemExit(f"invalid raw final hidden state for {prompt}")
    score = float(hidden[-1] @ head_w + head_b)
    if not math.isfinite(score):
        raise SystemExit(f"non-finite JEV score for {prompt}")
    load = re.search(r"\bload time\s*=\s*([0-9]+(?:\.[0-9]+)?) ms", result.stderr)
    return score, len(rows), float(load[1]) if load else None


def compare(results, reference_path):
    reference = json.loads(Path(reference_path).read_text())["results"]
    ref = {(r["fixture"], r["key"]): r for r in reference}
    if {(r["fixture"], r["key"]) for r in results} != ref.keys() or len(results) != len(ref):
        raise SystemExit("scored fixture records do not match the reference")
    rows, flips = [], []
    for r in results:
        q = ref[(r["fixture"], r["key"])]
        if (r["option_keys"] != q["option_keys"] or len(r["logits"]) != len(q["logits"])
                or len(r["probabilities"]) != len(q["probabilities"])):
            raise SystemExit(f"reference options do not match {r['fixture']}/{r['key']}")
        dl = max(abs(a - b) for a, b in zip(r["logits"], q["logits"]))
        dp = max(abs(a - b) for a, b in zip(r["probabilities"], q["probabilities"]))
        if int(np.argmax(r["probabilities"])) != int(np.argmax(q["probabilities"])):
            flips.append({"fixture": r["fixture"], "key": r["key"]})
        rows.append({"fixture": r["fixture"], "key": r["key"],
                     "max_abs_logit_delta": dl, "max_abs_prob_delta": dp})
    return {"reference": reference_path, "rows": rows, "decision_flips": flips,
            "worst_logit_delta": max(x["max_abs_logit_delta"] for x in rows),
            "worst_prob_delta": max(x["max_abs_prob_delta"] for x in rows)}


def score_fixtures(args, head_w, head_b, proof):
    manifest = json.loads((args.texts / "manifest.json").read_text())
    if not manifest:
        raise SystemExit("fixture manifest is empty")
    payload = {"mode": f"gguf-{args.label}", "temperature": TEMPERATURE, "results": []}
    if not args.fresh and args.out.exists():
        payload["results"] = json.loads(args.out.read_text()).get("results", [])
        print(f"resuming: {len(payload['results'])} records already scored", flush=True)
    done = {(r["fixture"], r["key"]) for r in payload["results"]}
    model_calls = 0
    for rec in manifest:
        if (rec["fixture"], rec["key"]) in done:
            continue
        files = rec["files"]
        counts = rec.get("token_counts", [None] * len(files))
        expected_candidates = 1 if rec["kind"] == "noul" else len(rec["option_keys"])
        if not files or len(files) != expected_candidates or len(counts) != len(files):
            raise SystemExit(f"invalid fixture candidate count: {rec['fixture']}/{rec['key']}")
        if args.fresh and not all(type(count) is int and count > 0 for count in counts):
            raise SystemExit("fresh fixture proof requires token counts from gguf_prep_texts.py")
        logits = []
        for name, count in zip(files, counts):
            logit, _, _ = score_prompt(args.embedding, args.gguf, args.texts / name, head_w, head_b, count)
            model_calls += 1
            logits.append(logit)
        raw = [0.0, logits[0]] if rec["kind"] == "noul" else logits
        probs = softmax(raw, TEMPERATURE)
        payload["results"].append({"fixture": rec["fixture"], "key": rec["key"],
                                   "kind": rec["kind"], "option_keys": rec["option_keys"],
                                   "logits": logits, "probabilities": probs})
        if not args.fresh:
            args.out.write_text(json.dumps(payload, indent=1, allow_nan=False))
        print(f"RECORD {rec['fixture']} {rec['key']} probs={[round(p, 4) for p in probs]}", flush=True)
    if args.fresh:
        payload.update(proof, loaded=True, scored_through_head=True, model_calls=model_calls)
    if args.reference:
        payload["comparison_vs_reference"] = compare(payload["results"], args.reference)
    with args.out.open("x" if args.fresh else "w") as stream:
        json.dump(payload, stream, indent=1, allow_nan=False)
        stream.write("\n")
    print("GGUF SCORE (min) DONE ->", args.out)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--gguf", required=True)
    ap.add_argument("--embedding", default=LLAMA_EMB)
    ap.add_argument("--label")
    ap.add_argument("--texts", default=TEXTS, type=Path)
    ap.add_argument("--prompt-file", type=Path, help="score one already chat-templated prompt as JSON")
    ap.add_argument("--expected-tokens", type=int, help="expected token count in single-prompt mode")
    ap.add_argument("--fresh", action="store_true", help="pin runtime and write a new complete fixture receipt")
    ap.add_argument("--reference")
    ap.add_argument("--out", type=Path)
    args = ap.parse_args()
    if not args.prompt_file and (not args.label or not args.out):
        ap.error("fixture scoring requires --label and --out")
    if not args.prompt_file and args.expected_tokens is not None:
        ap.error("--expected-tokens requires --prompt-file")
    if args.out and (args.fresh or args.prompt_file) and args.out.exists():
        ap.error(f"output already exists: {args.out}")
    gguf = Path(args.gguf)
    if not gguf.is_file():
        ap.error(f"GGUF does not exist: {gguf}")

    head_w, head_b = head_parameters()
    proof = {}
    if args.fresh or args.prompt_file:
        proof = {"embedding_version": embedding_version(args.embedding), "gguf_sha256": sha256(gguf),
                 "head_weight_sha256": sha256(HEAD_W), "head_bias_sha256": sha256(HEAD_B)}
    if not args.prompt_file:
        score_fixtures(args, head_w, head_b, proof)
        return
    started = time.monotonic()
    score, tokens, load_ms = score_prompt(args.embedding, args.gguf, args.prompt_file,
                                         head_w, head_b, args.expected_tokens)
    rss = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
    payload = {**proof, "prompt_sha256": sha256(args.prompt_file),
               "score": score, "tokens": tokens, "loaded": True,
               "scored_through_head": True, "model_calls": 1, "load_time_ms": load_ms,
               "elapsed_ms": round((time.monotonic() - started) * 1000, 3),
               "peak_rss_bytes": rss if sys.platform == "darwin" else rss * 1024}
    line = json.dumps(payload, allow_nan=False)
    if args.out:
        with args.out.open("x") as stream:
            stream.write(line + "\n")
    print(line)


if __name__ == "__main__":
    main()
