#!/usr/bin/env python3
"""Jev scoring harness: mirrors jev/model.py's forward exactly
(chat template wrap, last non-pad token hidden state, fp32 scalar head,
temperature softmax per jev/metrics.py) using jev.api.compile_request /
candidate_prompts for prompt construction. Two modes:
  unmerged: Bay base + PeftModel adapter (the reference path)
  merged:   merged checkpoint, no adapter
Writes per-record candidate logits + calibrated probabilities.
"""
import argparse, json, sys, time
sys.path.insert(0, "work/open-jev-src")
import torch
from jev.api import compile_request, candidate_prompts
from jev.metrics import softmax

TEMPERATURE = 1.518796342858676

def build_records(fixtures):
    records = []
    for fx in fixtures["requests"]:
        req = {"state": fx["state"], "questions": fx["questions"]}
        for rec in compile_request(**req):
            records.append((fx["name"], rec))
    return records

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["unmerged", "merged"], required=True)
    ap.add_argument("--backbone", required=True, help="HF model dir")
    ap.add_argument("--adapter", default=None)
    ap.add_argument("--head", required=True)
    ap.add_argument("--fixtures", default="work/fixtures.json")
    ap.add_argument("--out", required=True)
    ap.add_argument("--batch-size", type=int, default=4)
    args = ap.parse_args()

    from transformers import AutoModelForImageTextToText, AutoTokenizer
    t0 = time.time()
    tokenizer = AutoTokenizer.from_pretrained(args.backbone)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    tokenizer.padding_side = "right"

    full = AutoModelForImageTextToText.from_pretrained(
        args.backbone, dtype=torch.bfloat16, attn_implementation="sdpa")
    full.config.use_cache = False
    backbone = full.model.language_model
    if args.mode == "unmerged":
        from peft import PeftModel
        backbone = PeftModel.from_pretrained(backbone, args.adapter)
    backbone.eval()
    head = torch.nn.Linear(2048, 1)
    head.load_state_dict(torch.load(args.head, map_location="cpu", weights_only=True))
    head.eval()
    print(f"model loaded in {time.time()-t0:.0f}s", flush=True)

    fixtures = json.load(open(args.fixtures))
    records = build_records(fixtures)
    results = []
    for name, rec in records:
        prompts = candidate_prompts(rec)
        texts = [tokenizer.apply_chat_template(
            [{"role": "user", "content": p}], tokenize=False,
            add_generation_prompt=True, enable_thinking=False) for p in prompts]
        logits = []
        with torch.no_grad():
            for i in range(0, len(texts), args.batch_size):
                chunk = texts[i:i + args.batch_size]
                enc = tokenizer(chunk, return_tensors="pt", padding=True,
                                add_special_tokens=False)
                out = backbone(**enc, use_cache=False)
                hidden = out.last_hidden_state if hasattr(out, "last_hidden_state") else out[0]
                lengths = enc["attention_mask"].sum(dim=1)
                last = hidden[torch.arange(hidden.size(0)), lengths - 1]
                vals = head(last.float()).reshape(-1).tolist()
                logits.extend(float(v) for v in vals)
                print(f"  {name}/{rec['id']}: {len(logits)}/{len(texts)} prompts ({time.time()-t0:.0f}s)", flush=True)
        if rec["kind"] == "noul":  # one prompt scored; false logit pinned to 0
            raw = [0.0, logits[0]]
        else:
            raw = logits
        probs = softmax([float(x) for x in raw], TEMPERATURE)
        results.append({"fixture": name, "key": rec["id"], "kind": rec["kind"],
                        "option_keys": rec["answer_keys"],
                        "logits": raw if rec["kind"] != "noul" else logits,
                        "probabilities": probs})
        print(f"RECORD {name} {rec['id']} kind={rec['kind']} probs={[round(p,4) for p in probs]}", flush=True)
    json.dump({"mode": args.mode, "temperature": TEMPERATURE, "results": results},
              open(args.out, "w"), indent=1)
    print("SCORE DONE ->", args.out)

if __name__ == "__main__":
    main()
