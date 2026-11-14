#!/usr/bin/env python3
"""Streaming LoRA merge for Open-Jev-2B into Qwen/Qwen3.5-2B (Bay bytes only).

W' = W + scaling * (B @ A), scaling = lora_alpha / r = 16 / 8 = 2.0,
computed in fp32, cast back to bfloat16. Output is SHARDED (<=2.2 GB per
shard) with a model.safetensors.index.json, so the 6 GB cell never holds
the whole model. Memory is released between shards.
"""
import json, sys, hashlib, time, gc
import torch
from safetensors import safe_open
from safetensors.torch import save_file

BASE = "src/qwen3.5-2b"
ADAPTER = "src/open-jev-2b/package/checkpoint/adapter/adapter_model.safetensors"
OUTDIR = "work/merged"
SCALING = 2.0
SHARD_MAX = 2_200_000_000

def main():
    torch.set_num_threads(2)
    idx = json.load(open(f"{BASE}/model.safetensors.index.json"))
    base_keys = set(idx["weight_map"].keys())
    shard = f"{BASE}/model.safetensors-00001-of-00001.safetensors"

    with safe_open(ADAPTER, framework="pt") as f:
        pairs = {}
        for k in f.keys():
            assert k.startswith("base_model.model."), k
            rel = k[len("base_model.model."):]
            if rel.endswith(".lora_A.weight"):
                pairs.setdefault(rel[: -len(".lora_A.weight")], {})["A"] = k
            elif rel.endswith(".lora_B.weight"):
                pairs.setdefault(rel[: -len(".lora_B.weight")], {})["B"] = k
            else:
                raise SystemExit(f"unexpected adapter key: {k}")
        adapter = {k: f.get_tensor(k) for k in f.keys()}
    assert all(set(v) == {"A", "B"} for v in pairs.values()), "unpaired A/B"
    targets = {}
    for mod, ab in pairs.items():
        base_key = f"model.language_model.{mod}.weight"
        assert base_key in base_keys, f"base key missing: {base_key}"
        targets[base_key] = ab
    print(f"target modules: {len(targets)}", flush=True)

    weight_map, total_size = {}, 0
    out_tensors, shard_bytes, shard_no = {}, 0, 1
    pending_keys = []
    spot = []
    t0 = time.time()
    hashes = {}

    def flush():
        nonlocal out_tensors, shard_bytes, shard_no, pending_keys
        fname = f"model-{shard_no:05d}-of-00003.safetensors"
        save_file(out_tensors, f"{OUTDIR}/{fname}", metadata={"format": "pt"})
        h = hashlib.sha256(open(f"{OUTDIR}/{fname}", "rb").read()).hexdigest()
        hashes[fname] = h
        for k in pending_keys:
            weight_map[k] = fname
        pending_keys = []
        print(f"shard {fname}: {len(out_tensors)} tensors, {shard_bytes} B, sha256 {h[:16]}...", flush=True)
        out_tensors.clear()
        gc.collect()
        shard_bytes = 0
        shard_no += 1

    with safe_open(shard, framework="pt") as f:
        keys = list(f.keys())
        print(f"base tensors: {len(keys)}", flush=True)
        for i, k in enumerate(keys):
            w = f.get_tensor(k)
            if k in targets:
                ab = targets[k]
                A = adapter[ab["A"]]; B = adapter[ab["B"]]
                wf = w.float()
                delta = SCALING * (B @ A)
                merged = (wf + delta).to(w.dtype)
                if len(spot) < 6:
                    err = (merged.float() - (wf + delta)).abs().max().item()
                    spot.append({"tensor": k, "cast_max_err": err,
                                 "delta_max": delta.abs().max().item()})
                w = merged.contiguous()
            nbytes = w.numel() * w.element_size()
            if shard_bytes + nbytes > SHARD_MAX and out_tensors:
                flush()
            out_tensors[k] = w
            pending_keys.append(k)
            shard_bytes += nbytes
            total_size += nbytes
            if (i + 1) % 300 == 0:
                print(f"  {i+1}/{len(keys)} ({time.time()-t0:.0f}s, shard {shard_no})", flush=True)
    if out_tensors:
        flush()
    shard_files = sorted(hashes.keys())
    idx_out = {"metadata": {"total_size": total_size}, "weight_map": weight_map}
    json.dump(idx_out, open(f"{OUTDIR}/model.safetensors.index.json", "w"), indent=1)
    receipt = {"shards": hashes, "index": "model.safetensors.index.json",
               "sha256": hashes, "target_modules": len(targets),
               "scaling": SCALING, "total_size": total_size,
               "spot_cast_max_err": spot, "targets": sorted(targets.keys())}
    json.dump(receipt, open("receipts/merge-receipt.json", "w"), indent=1)
    print(f"MERGE DONE: {len(shard_files)} shards, {total_size} B")

if __name__ == "__main__":
    main()
