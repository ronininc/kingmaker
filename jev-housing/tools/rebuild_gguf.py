#!/usr/bin/env python3
"""Rebuild the merged Open-JEV backbone for the Ollama b11081 loader."""
import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LLAMA_COMMIT = "161755f29e415e2c33efe906e91843c068efd664"
LLAMA_BUILD = 11081


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def verify_checkpoint(merged):
    manifest = json.loads((ROOT / "housing-manifest.json").read_text())["merge"]
    pins = manifest["shards"] + [manifest["config"], manifest["index"]]
    for pin in pins:
        path = merged / Path(pin["path"]).name
        if not path.is_file():
            raise SystemExit(f"missing merged checkpoint file: {path}")
        if path.stat().st_size != pin["size"] or sha256(path) != pin["sha256"]:
            raise SystemExit(f"merged checkpoint pin mismatch: {path}")


def verify_checkout(llama_cpp):
    git = ["git", "-C", str(llama_cpp)]
    actual = subprocess.check_output(git + ["rev-parse", "HEAD"], text=True).strip()
    if actual != LLAMA_COMMIT:
        raise SystemExit(f"llama.cpp HEAD {actual} does not match b{LLAMA_BUILD} ({LLAMA_COMMIT})")
    if subprocess.check_output(git + ["status", "--porcelain"], text=True).strip():
        raise SystemExit(f"llama.cpp checkout has local changes: {llama_cpp}")


def verify_split_layout(architecture, names):
    if architecture != "qwen35":
        raise SystemExit(f"unexpected GGUF architecture: {architecture!r}")
    for layer in (index for index in range(24) if index % 4 != 3):
        prefix = f"blk.{layer}."
        for suffix in ("ssm_alpha.weight", "ssm_beta.weight", "attn_qkv.weight", "attn_gate.weight"):
            if prefix + suffix not in names:
                raise SystemExit(f"missing split tensor: {prefix}{suffix}")
        for suffix in ("ssm_beta_alpha.weight", "attn_qkv_gate.weight"):
            if prefix + suffix in names:
                raise SystemExit(f"unexpected fused tensor: {prefix}{suffix}")


def verify_gguf(path, reader_class):
    reader = reader_class(path)
    field = reader.get_field("general.architecture")
    architecture = field.contents() if field else None
    verify_split_layout(architecture, {tensor.name for tensor in reader.tensors})


def run(cmd, log_path):
    print(f"Running {Path(cmd[0]).name}, log at {log_path}", flush=True)
    with log_path.open("x") as log:
        result = subprocess.run(cmd, stdout=log, stderr=subprocess.STDOUT)
    if result.returncode:
        raise SystemExit(f"{Path(cmd[0]).name} failed ({result.returncode}), see {log_path}")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--llama-cpp", type=Path, required=True)
    ap.add_argument("--merged", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True, help="new internal-disk output directory")
    args = ap.parse_args()
    if args.out.exists():
        ap.error(f"output directory already exists: {args.out}")
    verify_checkpoint(args.merged)
    llama_cpp = args.llama_cpp.resolve()
    verify_checkout(llama_cpp)
    converter = llama_cpp / "convert_hf_to_gguf.py"
    quantize = llama_cpp / "build/bin/llama-quantize"
    if not converter.is_file() or not quantize.is_file():
        ap.error("expected convert_hf_to_gguf.py and build/bin/llama-quantize in the pinned checkout")
    sys.path.insert(0, str(llama_cpp / "gguf-py"))
    from gguf import GGUFReader

    args.out.mkdir()
    f16 = args.out / "open-jev-2b-merged-b11081-f16.gguf"
    q4 = args.out / "open-jev-2b-merged-b11081-q4_k_m.gguf"
    run([sys.executable, str(converter), str(args.merged), "--outfile", str(f16),
         "--outtype", "f16", "--use-temp-file"], args.out / "convert.log")
    verify_gguf(f16, GGUFReader)
    quantize_log = args.out / "quantize.log"
    run([str(quantize), str(f16), str(q4), "Q4_K_M", "2"], quantize_log)
    if LLAMA_COMMIT[:7] not in quantize_log.read_text(errors="replace"):
        raise SystemExit(f"quantizer did not report the pinned commit, see {quantize_log}")
    verify_gguf(q4, GGUFReader)
    receipt = {"llama_commit": LLAMA_COMMIT, "ollama_version_pin": "0.34.4/0.35.0",
               "artifacts": [{"file": path.name, "size": path.stat().st_size, "sha256": sha256(path)}
                             for path in (f16, q4)]}
    out = args.out / "rebuild.json"
    with out.open("x") as stream:
        json.dump(receipt, stream, indent=1)
        stream.write("\n")
    print(f"Rebuild receipt written to {out}")


if __name__ == "__main__":
    main()
