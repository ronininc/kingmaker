"""Join HuggingBay programs + file lists into one object per model, with hardware fit.
Usage: python3 -I build_hb.py HBOUT OUT.json"""
import json, re, sys
from datetime import datetime, timezone

HB, OUT = sys.argv[1], sys.argv[2]
BASE = "https://huggingbay.xyz"
WEIGHT = re.compile(r"\.(gguf|safetensors|bin|pt|pth|onnx|ckpt|mlmodel|tflite)$", re.I)
QUANT = re.compile(r"(?<![A-Za-z0-9])(I?Q[1-8](?:_K)?(?:_(?:XXS|XS|NL|S|M|L|0|1))?|BF16|F16|FP16|F32|FP8|MXFP4|NVFP4|INT[48]|[48]-?bit|AWQ|GPTQ|EXL2)(?![A-Za-z0-9])", re.I)
SHARD = re.compile(r"-0*(\d+)-of-0*(\d+)(?=\.gguf$)", re.I)
PARAMS = re.compile(r"(?<![A-Za-z0-9.])(\d+(?:\.\d+)?)\s*([BbMm])(?:-?[Aa](\d+(?:\.\d+)?)[Bb])?(?![A-Za-z0-9])")
EFFECTIVE = re.compile(r"(?<![A-Za-z0-9])[Ee](\d+)[Bb](?![A-Za-z0-9])")
UNCENSORED = re.compile(r"abliterat|uncensor|heretic|dolphin|unfilter|unalign|refusal|decensor|nsfw|lewd|rp-?uncen", re.I)
GiB = 1024 ** 3

# Hardware classes. Usable memory for a model = what is left after the OS, the browser and Kingmaker's engine.
# Anchored on measurements on the 8 GB M3 (2026-10-09): a model resident at <=2.4 GB ran with no swap;
# 2.9 GB pushed ~1.1 GB to swap and dropped to 8-10 tok/s. Larger classes are scaled estimates, not measured.
HARDWARE = [
    # id, label, comfortable GB, tight GB
    ("ram8", "8 GB laptop / Mac, no GPU", 2.5, 4.5),
    ("ram16", "16 GB laptop / Mac / mini PC", 8.0, 11.0),
    ("ram32", "32 GB desktop / Mac", 18.0, 24.0),
    ("vram8", "8 GB graphics card", 6.8, 7.4),
    ("vram12", "12 GB graphics card", 10.5, 11.3),
    ("vram16", "16 GB graphics card", 14.2, 15.2),
    ("vram24", "24 GB graphics card", 21.5, 23.0),
]


def resident_gb(file_bytes):
    """Weights + runtime + a 4k-token cache. Measured: 1.4 GB file -> 1.66 GB resident; 2.0 GB -> 2.33; 2.5 -> 2.9."""
    return file_bytes / 1e9 * 1.08 + 0.2


def fit(file_bytes):
    if not file_bytes:
        return None
    need = resident_gb(file_bytes)
    out = {}
    for hid, _, ok, tight in HARDWARE:
        out[hid] = "runs" if need <= ok else "tight" if need <= tight else "no"
    return out


def params_of(*names):
    for n in names:
        if not n:
            continue
        e = EFFECTIVE.search(n)
        if e:
            return f"E{e.group(1)}B (effective)"
        best = None
        for m in PARAMS.finditer(n.replace("_", "-")):
            num, unit, active = m.group(1), m.group(2).upper(), m.group(3)
            if unit == "M" and float(num) < 10:  # "4M" context etc. are not param counts
                continue
            label = f"{num}{unit}" + (f"-A{active}B" if active else "")
            best = best or label
        if best:
            return best
    return None


def quant_of(path):
    stem = SHARD.sub("", path.rsplit("/", 1)[-1])
    stem = re.sub(r"\.(gguf|safetensors|bin|onnx|pt|pth)$", "", stem, flags=re.I)
    m = QUANT.findall(re.sub(r"[.\-]", "_", stem))
    return m[-1].upper() if m else None


def load_files():
    files = {}
    for l in open(f"{HB}/hosted_files.jsonl"):
        if not l.strip():
            continue
        r = json.loads(l)
        files.setdefault(r["artifactId"], []).append(r)
    try:
        for l in open(f"{HB}/files_by_artifact.jsonl"):
            if not l.strip():
                continue
            r = json.loads(l)
            if r.get("rows") is None:
                files.setdefault(r["artifactId"], None)
                continue
            files.setdefault(r["artifactId"], [])  # fetched; the site may list no files for it
            for x in r["rows"]:
                files.setdefault(r["artifactId"], []).append(x)
    except FileNotFoundError:
        pass
    return files


def main():
    groups = {g["artifactId"]: g for g in json.load(open(f"{HB}/programs.json"))["groups"]}
    files = load_files()
    models = []
    for aid, g in sorted(groups.items()):
        rows = files.get(aid)
        seen, weights, other = set(), [], 0
        for x in rows or []:
            p = x.get("filePath")
            if not p or p in seen:
                continue
            seen.add(p)
            if not WEIGHT.search(p):
                other += 1
                continue
            state = (x.get("serveDecision") or {}).get("state")
            weights.append({
                "path": p,
                "format": p.rsplit(".", 1)[-1].lower(),
                "quantization": quant_of(p),
                "size_bytes": x.get("sizeBytes"),
                "size_gb": round(x["sizeBytes"] / 1e9, 2) if x.get("sizeBytes") else None,
                "sha256": x.get("sha256"),
                "download_url": x.get("downloadUrl"),
                "serve_state": state,
                "hardware_fit": fit(x.get("sizeBytes")) if p.lower().endswith(".gguf") else None,
            })
        repo = g.get("repo") or ""
        name = g.get("displayName") or repo.split("/")[-1]
        quants = sorted({w["quantization"] for w in weights if w["quantization"]})
        # GGUF variants: shards (-00001-of-00003) summed into one variant so the fit reflects the whole model.
        variants = {}
        for w in weights:
            if w["format"] != "gguf" or not w["size_bytes"]:
                continue
            key = SHARD.sub("", w["path"])
            v = variants.setdefault(key, {"path": key, "quantization": w["quantization"], "size_bytes": 0, "files": 0})
            v["size_bytes"] += w["size_bytes"]
            v["files"] += 1
        for w in weights:
            if w["format"] == "gguf" and w["size_bytes"] and SHARD.search(w["path"]):
                w["hardware_fit"] = None  # one shard alone says nothing; see gguf_variants
        gguf_variants = sorted(({**v, "size_gb": round(v["size_bytes"] / 1e9, 2), "est_memory_gb": round(resident_gb(v["size_bytes"]), 1),
                                 "hardware_fit": fit(v["size_bytes"])} for v in variants.values()), key=lambda v: v["size_bytes"])
        smallest = gguf_variants[0] if gguf_variants else None
        uncensored_by_name = bool(UNCENSORED.search(repo))
        models.append({
            "name": name,
            "id": aid,
            "repo": repo,
            "publisher": g.get("publisher"),
            "source_url": f"https://huggingface.co/{repo}" if repo else None,
            "huggingbay_url": f"{BASE}/artifact/{aid}",
            "task": g.get("task"),
            "parameters": params_of(repo, name),
            "formats": sorted({w["format"] for w in weights}) or g.get("formats"),
            "quantizations": quants,
            "size_bytes_site": g.get("bytes"),
            "weight_bytes_total": sum(w["size_bytes"] or 0 for w in weights) or None,
            "uncensored": bool(g.get("uncensored")) or uncensored_by_name,
            "uncensored_source": ("site flag" if g.get("uncensored") else "") + (" + name" if uncensored_by_name and g.get("uncensored") else "name" if uncensored_by_name else ""),
            "abliterated": bool(re.search(r"abliterat", repo, re.I)),
            "nsfw": bool(g.get("nsfw")),
            "license": g.get("license"),
            "smallest_gguf": smallest,
            "gguf_variants": gguf_variants,
            "files_fetched": rows is not None,
            "weight_files": weights,
            "other_file_count": other,
        })
    meta = {
        "source": BASE,
        "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "scope": "HuggingBay downloadable-programs index (every model with files on the site); the wider 170k metadata index was not included",
        "how_downloads_work": {
            "direct": "HTTPS GET https://huggingbay.xyz/api/downloads/{artifactId}/{filePath} (only files whose serve_state is READY; BLOCKED files return no bytes). Each file carries a sha256; the per-model signed manifest is /api/manifests/{artifactId} (key at /api/keys/manifest-signing).",
            "download_plan": "/api/artifacts/{artifactId}/download-plan",
            "torrent_magnet": "reviewed fallback only: each artifact has decentralizedDistribution {protocol: bittorrent-magnet-metadata, verifiedFallbacks}, read via /api/artifacts/{id}/peer-fallbacks; policy noUnreviewedMagnetPublication, sampled models had 0 verified magnets. No magnet links on the page.",
            "upstream": "every model also links its Hugging Face repo (source_url)",
        },
        "api_endpoints": {
            "model_list": "/api/downloadable-programs?limit=60&cursor=…&uncensored=only|…&format=gguf (60 per page, cursor paginated)",
            "files_per_model": "/api/downloadable-files?artifactId={id}&limit=100",
            "hosted_files_dump": "/api/dumps/hosted-files.jsonl?limit=1000 (cursor in the Link rel=next header; covers ~2k models)",
            "full_search": "/api/v1/search?limit=100&cursor=N (~170k entries incl. metadata-only HF listings)",
            "catalog_dump": "/api/dumps/catalog.jsonl (27-row stale snapshot)",
            "openapi": "/openapi.json", "mcp": "/api/mcp", "rate_limit": "1200 requests per window (RateLimit-* headers)",
        },
        "hardware_fit_legend": {h[0]: {"label": h[1], "runs_if_memory_gb_at_most": h[2], "tight_if_at_most": h[3]} for h in HARDWARE},
        "hardware_fit_method": "est_memory_gb = file_gb*1.08 + 0.2 (fitted to 4 measured Ollama loads on an 8 GB M3). runs = fits with the usual apps open; tight = fits with little else open, expect swap or partial GPU offload; no = will not run usefully. RAM classes measured only for 8 GB; others are scaled estimates.",
        "fields": "size_bytes_site = the site's own size figure (sometimes wrong, e.g. a few KB); weight_bytes_total = sum of every listed weight file (all quants together); gguf_variants = one entry per quant with shards summed, smallest first. uncensored = site flag OR repo name matches abliterated/uncensored/heretic/dolphin; abliterated = repo name says so. parameters/quantization parsed from repo and file names (null when absent).",
    }
    json.dump({"meta": meta, "count": len(models), "models": models}, open(OUT, "w"), indent=None, separators=(",", ":"))
    print(len(models), "models;", sum(m["files_fetched"] for m in models), "with files;",
          sum(1 for m in models if m["smallest_gguf"]), "with GGUF;", sum(m["uncensored"] for m in models), "uncensored")


main()
