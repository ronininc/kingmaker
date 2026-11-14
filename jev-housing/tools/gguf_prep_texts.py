#!/usr/bin/env python3
"""Phase 1 of the low-memory GGUF behavioral score: compile fixtures to
chat-templated candidate texts and write them to work/gguf_texts/ with a
manifest. Runs in the venv (transformers tokenizer), exits before any
embedding process starts, so the two never share the memory budget.
Tokenization: the fast tokenizer, proven string-identical (score.py).
"""
import json, sys
from pathlib import Path
sys.path.insert(0, "work/open-jev-src")
from jev.api import compile_request, candidate_prompts
from transformers import AutoTokenizer

OUT = Path("work/gguf_texts")
OUT.mkdir(exist_ok=True)
tokenizer = AutoTokenizer.from_pretrained("src/qwen3.5-2b-fasttok")
fixtures = json.load(open("work/fixtures.json"))
manifest = []
for fx in fixtures["requests"]:
    for rec in compile_request(state=fx["state"], questions=fx["questions"]):
        prompts = candidate_prompts(rec)
        files = []
        for ci, p in enumerate(prompts):
            s = tokenizer.apply_chat_template(
                [{"role": "user", "content": p}], tokenize=False,
                add_generation_prompt=True, enable_thinking=False)
            name = f"{fx['name']}__{rec['id']}__{ci}.txt"
            (OUT / name).write_text(s)
            files.append(name)
        manifest.append({"fixture": fx["name"], "key": rec["id"],
                         "kind": rec["kind"], "option_keys": rec["answer_keys"],
                         "files": files})
json.dump(manifest, open(OUT / "manifest.json", "w"), indent=1)
print(f"wrote {len(manifest)} records, {sum(len(m['files']) for m in manifest)} texts")
