#!/usr/bin/env python3
"""Weight-level verification: GGUF tensors vs the merged HF checkpoint.

v2 (continuation, 2026-11-14) — v1 never ran (bf16 loader crash) and four
of its comparison assumptions proved wrong against the actual converter
output. Each correction below is backed by a measured receipt-level test:

1. RMSNorm weights: llama.cpp stores the EFFECTIVE Qwen3.5 norm weight
   (1 + w) for input/post-attention/q/k/final norms. Measured: blk.0
   attn_norm vs (1+w) max diff exactly 0.0; vs w exactly 1.0. The SSM
   gated norm (ssm_norm) is stored verbatim — it is NOT in the +1 set.
2. ssm_a: the converter stores -exp(A_log), not A_log. Measured max diff
   vs -exp(A_log): 3.0e-08.
3. blk.24.* is the MTP (nextn) layer: its HF names live under mtp.* in
   the merged checkpoint, outside the layers.* table v1 used. Mapping is
   resolved by shape + value match against an explicit candidate list
   and the winning mapping is recorded in the receipt.
4. The two per-layer concatenated tensors cannot be byte-hash compared:
   f16 storage rounds tiny weights through subnormals (observed error
   3.0e-08), and attn_qkv_gate rows are head-interleaved by the
   converter (rows are not preserved; the element multiset is, to
   3.0e-08). Verification is therefore: ssm_beta_alpha = in-order
   max-abs-diff vs [in_proj_b | in_proj_a]; attn_qkv_gate = sorted
   element-multiset max-diff vs [in_proj_qkv | in_proj_z]. For q4_k_m,
   both are rel-L2 (beta_alpha vs the HF concat in order; qkv_gate vs
   the f16 GGUF, the quantization source, same layout).

f16 mode: direct compares are chunked max-abs-diff; a tensor passes at
<= 1e-4 (observed worst after transforms: 3.0e-08).
q4 mode: compares are rel-L2 vs the (transformed) HF tensor (concat
qkv_gate: vs the f16 GGUF, its quantization source). The pass gate is
0.10 for every tensor: it is a CORRUPTION gate (a mis-mapped or damaged
tensor scores ~1.0), not a quantization-quality grade — the observed
values are the quality record (first run: direct worst 0.0895,
concat worst 0.0827, uniformly in the q4_k_m envelope).
element-count-weighted coverage is reported either way.

Usage: gguf_tensor_check.py f16 work/gguf/open-jev-2b-merged-f16.gguf
       gguf_tensor_check.py q4  work/gguf/open-jev-2b-merged-q4_k_m.gguf
"""
import json, sys
sys.path.insert(0, "work/llama.cpp/gguf-py")
import numpy as np
import gguf
from gguf import quants
from safetensors import safe_open

MODE = sys.argv[1]           # f16 | q4
GGUF_PATH = sys.argv[2]
MERGED = "work/merged"
F16_GGUF = "work/gguf/open-jev-2b-merged-f16.gguf"
TOL_F16 = 1e-4

def hf_index():
    idx = json.load(open(f"{MERGED}/model.safetensors.index.json"))["weight_map"]
    return idx

WM = hf_index()
HF_CACHE = {}
def hf_tensor(name):
    if name not in HF_CACHE:
        HF_CACHE[name] = safe_open(f"{MERGED}/{WM[name]}", framework="pt")
    return HF_CACHE[name].get_tensor(name)

def hf_np(name):
    return hf_tensor(name).float().numpy()

def hf_cat_np(names):
    import torch
    return torch.cat([hf_tensor(n) for n in names], dim=0).float().numpy()

PLUS_ONE_SUFFIXES = ("attn_norm.weight", "post_attention_norm.weight",
                     "attn_q_norm.weight", "attn_k_norm.weight",
                     "output_norm.weight", "nextn.enorm.weight",
                     "nextn.hnorm.weight", "nextn.shared_head_norm.weight")

def hf_reference(gname, hname):
    """HF reference values for a GGUF tensor, with converter transforms."""
    if gname.endswith("ssm_a"):
        return -np.exp(hf_np(hname))
    arr = hf_np(hname)
    if gname.endswith(PLUS_ONE_SUFFIXES):
        return 1.0 + arr
    return arr

def hf_name_for(gn):
    p = gn.split(".")
    if gn == "token_embd.weight":
        return "model.language_model.embed_tokens.weight"
    if gn == "output_norm.weight":
        return "model.language_model.norm.weight"
    if gn.startswith("blk.") and len(p) >= 3:
        n = p[1]
        rest = ".".join(p[2:])
        L = f"model.language_model.layers.{n}"
        m = {
            "attn_norm.weight": f"{L}.input_layernorm.weight",
            "attn_q.weight": f"{L}.self_attn.q_proj.weight",
            "attn_k.weight": f"{L}.self_attn.k_proj.weight",
            "attn_v.weight": f"{L}.self_attn.v_proj.weight",
            "attn_output.weight": f"{L}.self_attn.o_proj.weight",
            "attn_q_norm.weight": f"{L}.self_attn.q_norm.weight",
            "attn_k_norm.weight": f"{L}.self_attn.k_norm.weight",
            "post_attention_norm.weight": f"{L}.post_attention_layernorm.weight",
            "ffn_gate.weight": f"{L}.mlp.gate_proj.weight",
            "ffn_up.weight": f"{L}.mlp.up_proj.weight",
            "ffn_down.weight": f"{L}.mlp.down_proj.weight",
            "ssm_a": f"{L}.linear_attn.A_log",
            "ssm_alpha.weight": f"{L}.linear_attn.in_proj_a.weight",
            "ssm_beta.weight": f"{L}.linear_attn.in_proj_b.weight",
            "ssm_conv1d.weight": f"{L}.linear_attn.conv1d.weight",
            "ssm_dt.bias": f"{L}.linear_attn.dt_bias",
            "ssm_norm.weight": f"{L}.linear_attn.norm.weight",
            "ssm_out.weight": f"{L}.linear_attn.out_proj.weight",
        }
        return m.get(rest)
    return None

# blk.24 (MTP / nextn): candidate HF names, value match decides.
M = "mtp.layers.0"
MTP_CANDIDATES = {
    "attn_q.weight": [f"{M}.self_attn.q_proj.weight"],
    "attn_k.weight": [f"{M}.self_attn.k_proj.weight", f"{M}.self_attn.v_proj.weight"],
    "attn_v.weight": [f"{M}.self_attn.v_proj.weight", f"{M}.self_attn.k_proj.weight"],
    "attn_output.weight": [f"{M}.self_attn.o_proj.weight"],
    "attn_q_norm.weight": [f"{M}.self_attn.q_norm.weight", f"{M}.self_attn.k_norm.weight"],
    "attn_k_norm.weight": [f"{M}.self_attn.k_norm.weight", f"{M}.self_attn.q_norm.weight"],
    "attn_norm.weight": [f"{M}.input_layernorm.weight"],
    "post_attention_norm.weight": [f"{M}.post_attention_layernorm.weight"],
    "ffn_gate.weight": [f"{M}.mlp.gate_proj.weight", f"{M}.mlp.up_proj.weight"],
    "ffn_up.weight": [f"{M}.mlp.up_proj.weight", f"{M}.mlp.gate_proj.weight"],
    "ffn_down.weight": [f"{M}.mlp.down_proj.weight"],
    "nextn.eh_proj.weight": ["mtp.fc.weight"],
    "nextn.enorm.weight": ["mtp.pre_fc_norm_embedding.weight"],
    "nextn.hnorm.weight": ["mtp.pre_fc_norm_hidden.weight"],
    "nextn.shared_head_norm.weight": ["mtp.norm.weight"],
}

def dequant(t):
    a = quants.dequantize(t.data, t.tensor_type)
    return np.asarray(a, dtype=np.float32).reshape(t.shape[::-1])

def rel_l2_np(data, ref):
    """Chunked rel-L2 between two numpy arrays (no full-size temporaries)."""
    a = np.asarray(data, dtype=np.float32).reshape(-1)
    b = np.asarray(ref, dtype=np.float32).reshape(-1)
    num = den = 0.0
    BLOCK = 1 << 20
    for i in range(0, a.size, BLOCK):
        d = a[i:i + BLOCK].astype(np.float64) - b[i:i + BLOCK].astype(np.float64)
        num += float(d @ d)
        den += float(b[i:i + BLOCK].astype(np.float64) @ b[i:i + BLOCK].astype(np.float64))
    return float(np.sqrt(num) / (np.sqrt(den) + 1e-12))

def rel_l2_vs_hf(data, gname, hname):
    """Chunked rel-L2 of a GGUF tensor vs its transformed HF reference,
    streaming the HF side from the bf16 torch tensor block by block so
    the 0.5B-param embedding never materializes in fp32."""
    t = hf_tensor(hname)
    gf = np.asarray(data, dtype=np.float32).reshape(-1)
    hf_flat = t.reshape(-1)
    assert gf.size == hf_flat.numel(), (gname, gf.size, hf_flat.numel())
    num = den = 0.0
    BLOCK = 1 << 20
    for i in range(0, gf.size, BLOCK):
        c = hf_flat[i:i + BLOCK].float().numpy().astype(np.float64)
        if gname.endswith("ssm_a"):
            c = -np.exp(c)
        elif gname.endswith(PLUS_ONE_SUFFIXES):
            c = c + 1.0
        d = gf[i:i + BLOCK].astype(np.float64) - c
        num += float(d @ d)
        den += float(c @ c)
    return float(np.sqrt(num) / (np.sqrt(den) + 1e-12))

def max_abs_diff_chunked(g, hf_t):
    gf = np.asarray(g, dtype=np.float32).reshape(-1)
    hf_flat = hf_t.reshape(-1)
    mx = 0.0
    BLOCK = 1 << 20
    for i in range(0, gf.size, BLOCK):
        chunk = hf_flat[i:i + BLOCK].float().numpy()
        d = np.abs(gf[i:i + BLOCK].astype(np.float64) - chunk.astype(np.float64))
        if d.size:
            mx = max(mx, float(d.max()))
    return mx

def main():
    reader = gguf.GGUFReader(GGUF_PATH)
    tensors = {t.name: t for t in reader.tensors}
    f16_tensors = None
    if MODE == "q4":
        f16_tensors = {t.name: t for t in gguf.GGUFReader(F16_GGUF).tensors}
    results = {"mode": MODE, "file": GGUF_PATH, "compared": [],
               "concat_compared": [], "mtp_mapping": {}, "unmapped": [],
               "errors": [], "param_coverage": 0.0}
    total_params = sum(int(np.prod(t.shape)) for t in tensors.values())
    covered = 0

    for gname, t in tensors.items():
        data = dequant(t)
        n = int(np.prod(t.shape))
        # --- concatenated linear-attention tensors
        if gname.startswith("blk.") and gname.endswith("attn_qkv_gate.weight"):
            layer = gname.split(".")[1]
            names = [f"model.language_model.layers.{layer}.linear_attn.in_proj_qkv.weight",
                     f"model.language_model.layers.{layer}.linear_attn.in_proj_z.weight"]
            if MODE == "f16":
                hf_cat = hf_cat_np(names)
                d = float(np.abs(np.sort(data, axis=None).astype(np.float64)
                                 - np.sort(hf_cat, axis=None).astype(np.float64)).max())
                ok = d <= TOL_F16
                results["concat_compared"].append(
                    {"gguf": gname, "method": "sorted element multiset max-diff",
                     "hf": names, "value": d, "pass": ok})
                if not ok:
                    results["errors"].append(f"concat mismatch {gname}: {d}")
            else:
                src = dequant(f16_tensors[gname])
                rel = rel_l2_np(data, src)
                results["concat_compared"].append(
                    {"gguf": gname, "method": "rel-L2 vs f16 GGUF (quantization source)",
                     "hf": names, "value": rel, "pass": rel <= 0.10})
                if rel > 0.10:
                    results["errors"].append(f"concat rel-L2 too high {gname}: {rel}")
            covered += n
            continue
        if gname.startswith("blk.") and gname.endswith("ssm_beta_alpha.weight"):
            layer = gname.split(".")[1]
            names = [f"model.language_model.layers.{layer}.linear_attn.in_proj_b.weight",
                     f"model.language_model.layers.{layer}.linear_attn.in_proj_a.weight"]
            hf_cat = hf_cat_np(names)
            if MODE == "f16":
                d = float(np.abs(data.astype(np.float64) - hf_cat.astype(np.float64)).max())
                ok = d <= TOL_F16
                results["concat_compared"].append(
                    {"gguf": gname, "method": "in-order max-abs-diff vs [in_proj_b | in_proj_a]",
                     "hf": names, "value": d, "pass": ok})
                if not ok:
                    results["errors"].append(f"concat mismatch {gname}: {d}")
            else:
                rel = rel_l2_np(data, hf_cat)
                results["concat_compared"].append(
                    {"gguf": gname, "method": "rel-L2 vs HF [in_proj_b | in_proj_a]",
                     "hf": names, "value": rel, "pass": rel <= 0.10})
                if rel > 0.10:
                    results["errors"].append(f"concat rel-L2 too high {gname}: {rel}")
            covered += n
            continue
        # --- MTP layer (blk.24)
        if gname.startswith("blk.24."):
            rest = ".".join(gname.split(".")[2:])
            cands = MTP_CANDIDATES.get(rest, [])
            best = None
            for cand in cands:
                if cand not in WM:
                    continue
                ref = hf_reference(gname, cand)
                if MODE == "f16":
                    val = float(np.abs(data.astype(np.float64) - ref.astype(np.float64)).max())
                    score = val
                else:
                    val = rel_l2_np(data, ref)
                    score = val
                if best is None or score < best[1]:
                    best = (cand, val)
            if best is None:
                results["unmapped"].append(gname)
                continue
            cand, val = best
            limit = TOL_F16 if MODE == "f16" else 0.10
            results["mtp_mapping"][gname] = {"hf": cand, "value": val,
                                             "pass": val <= limit}
            results["compared"].append({"gguf": gname, "hf": cand,
                                         "max_abs_diff" if MODE == "f16" else "rel_l2": val})
            if val > limit:
                results["errors"].append(f"mtp mismatch {gname} vs {cand}: {val}")
            covered += n
            continue
        # --- ordinary direct compares
        hn = hf_name_for(gname)
        if hn is None or hn not in WM:
            results["unmapped"].append(gname)
            continue
        if MODE == "f16":
            ref_t = hf_tensor(hn)
            if gname.endswith("ssm_a"):
                import torch
                ref_t = -torch.exp(ref_t.float())
            elif gname.endswith(PLUS_ONE_SUFFIXES):
                ref_t = ref_t.float() + 1.0
            else:
                ref_t = ref_t.float()
            if tuple(data.shape) != tuple(ref_t.shape) and data.size == ref_t.numel():
                ref_t = ref_t.reshape(tuple(data.shape))  # e.g. conv1d (6144,1,4)->(6144,4)
            if tuple(data.shape) != tuple(ref_t.shape):
                results["errors"].append(f"shape mismatch {gname}: {data.shape} vs {tuple(ref_t.shape)}")
                continue
            mx = max_abs_diff_chunked(data, ref_t)
            results["compared"].append({"gguf": gname, "hf": hn, "max_abs_diff": mx})
            if mx > TOL_F16:
                results["errors"].append(f"f16 diff too high {gname}: {mx}")
        else:
            if data.size != hf_tensor(hn).numel():
                results["errors"].append(f"size mismatch {gname}: {data.size} vs {hf_tensor(hn).numel()}")
                continue
            rel = rel_l2_vs_hf(data, gname, hn)
            results["compared"].append({"gguf": gname, "hf": hn, "rel_l2": rel})
            if rel > 0.10:
                results["errors"].append(f"q4 rel-L2 too high {gname}: {rel}")
        covered += n

    results["param_coverage"] = covered / total_params if total_params else 0.0
    vals = [r.get("max_abs_diff", r.get("rel_l2", 0.0)) for r in results["compared"]]
    results["worst_value"] = max(vals) if vals else None
    out = f"receipts/gguf-tensor-check-{'f16' if MODE == 'f16' else 'q4'}.json"
    json.dump(results, open(out, "w"), indent=1)
    print(f"{MODE}: compared {len(results['compared'])} direct + "
          f"{len(results['concat_compared'])} concat; coverage "
          f"{results['param_coverage']:.4f}; worst {results['worst_value']}; "
          f"unmapped {len(results['unmapped'])}; errors {len(results['errors'])}")
    for e in results["errors"][:10]:
        print("  ERR:", e)
    print("wrote", out)

if __name__ == "__main__":
    main()
