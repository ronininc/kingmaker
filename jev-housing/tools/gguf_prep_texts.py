#!/usr/bin/env python3
"""Phase 1 of the low-memory GGUF behavioral score: compile fixtures to
chat-templated candidate texts and write them to work/gguf_texts/ with a
manifest. Runs in the venv (transformers tokenizer), exits before any
embedding process starts, so the two never share the memory budget.
Tokenization: the fast tokenizer, proven string-identical (score.py).
"""
import argparse, json, sys
from pathlib import Path


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--jev-source", default="work/open-jev-src")
    ap.add_argument("--tokenizer", default="src/qwen3.5-2b-fasttok")
    ap.add_argument("--fixtures", type=Path, default=Path("work/fixtures.json"))
    ap.add_argument("--out", type=Path, default=Path("work/gguf_texts"))
    args = ap.parse_args()
    sys.path.insert(0, args.jev_source)
    from jev.api import compile_request, candidate_prompts
    from transformers import AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(args.tokenizer, local_files_only=True)
    fixtures = json.loads(args.fixtures.read_text())
    args.out.mkdir(exist_ok=True)
    manifest = []
    for fx in fixtures["requests"]:
        for rec in compile_request(state=fx["state"], questions=fx["questions"]):
            files, token_counts = [], []
            for ci, prompt in enumerate(candidate_prompts(rec)):
                text = tokenizer.apply_chat_template(
                    [{"role": "user", "content": prompt}], tokenize=False,
                    add_generation_prompt=True, enable_thinking=False)
                name = f"{fx['name']}__{rec['id']}__{ci}.txt"
                (args.out / name).write_text(text, encoding="utf-8")
                files.append(name)
                token_counts.append(len(tokenizer.encode(text, add_special_tokens=False)))
            manifest.append({"fixture": fx["name"], "key": rec["id"], "kind": rec["kind"],
                             "option_keys": rec["answer_keys"], "files": files,
                             "token_counts": token_counts})
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=1))
    print(f"wrote {len(manifest)} records, {sum(len(m['files']) for m in manifest)} texts")


if __name__ == "__main__":
    main()
