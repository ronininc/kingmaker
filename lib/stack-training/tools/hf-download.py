#!/usr/bin/env python3
"""
tools/hf-download.py — the REAL downloader for dataset intake.

Given an HF dataset id and revision, snapshots the repo via huggingface_hub,
then emits a JSON manifest of data files with per-file sha256, size, row
counts (for .json/.jsonl) and a sampled schema. No telemetry: plain HTTPS to
huggingface.co only. $0.

Usage:
    python3 tools/hf-download.py <hf_id> [revision] [--out DIR]

Output: JSON to stdout.
"""
import json
import os
import sys
import hashlib

# This VM's proxy env vars are malformed for httpx URL parsing (':1]').
# Direct HTTPS to huggingface.co works (curl proves it) — drop proxy vars
# before huggingface_hub builds its client.
for _k in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY",
           "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"):
    os.environ.pop(_k, None)

from huggingface_hub import snapshot_download, dataset_info


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def sample_schema(path):
    """Return (row_count, schema_keys) for .json/.jsonl files; else (None, None)."""
    name = path.lower()
    try:
        if name.endswith(".jsonl"):
            keys = []
            count = 0
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    count += 1
                    if count == 1:
                        row = json.loads(line)
                        keys = list(row.keys()) if isinstance(row, dict) else []
            return count, keys
        if name.endswith(".json"):
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                row0 = f.read(4096).lstrip()
            if row0.startswith("["):
                with open(path, "r", encoding="utf-8", errors="replace") as f:
                    data = json.load(f)
                if isinstance(data, list):
                    keys = list(data[0].keys()) if data and isinstance(data[0], dict) else []
                    return len(data), keys
            return None, None
    except Exception:
        return None, None
    return None, None


def main():
    if len(sys.argv) < 2:
        print("usage: hf-download.py <hf_id> [revision] [--out DIR]", file=sys.stderr)
        sys.exit(2)
    hf_id = sys.argv[1]
    revision = sys.argv[2] if len(sys.argv) > 2 and not sys.argv[2].startswith("--") else None
    out = None
    if "--out" in sys.argv:
        out = sys.argv[sys.argv.index("--out") + 1]

    meta = dataset_info(hf_id)
    card = (meta.cardData or {}) if hasattr(meta, "cardData") else {}
    license_str = card.get("license")

    repo_dir = snapshot_download(
        repo_id=hf_id, repo_type="dataset", revision=revision,
        cache_dir=out or os.path.expanduser("~/.cache/huggingface"),
        max_workers=4,
    )

    files = []
    for root, _dirs, names in os.walk(repo_dir):
        for n in names:
            full = os.path.join(root, n)
            if ".git" in full.split(os.sep):
                continue
            rel = os.path.relpath(full, repo_dir)
            if rel == ".no_exist":
                continue
            size = os.path.getsize(full)
            entry = {
                "path": rel,
                "size": size,
                "sha256": sha256_file(full) if size < (4 << 30) else None,
            }
            rows, schema = sample_schema(full)
            if rows is not None:
                entry["rowCount"] = rows
                entry["schema"] = schema
            files.append(entry)

    files.sort(key=lambda e: e["path"])
    manifest = {
        "hfId": hf_id,
        "revision": meta.sha,
        "license": license_str,
        "repoDir": repo_dir,
        "files": files,
    }
    print(json.dumps(manifest))


if __name__ == "__main__":
    main()
