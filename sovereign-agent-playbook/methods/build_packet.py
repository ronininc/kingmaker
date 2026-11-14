#!/usr/bin/env python3
"""Context Ladder packet builder (method m07). Assembles a 5-level context
packet from named local source files. Every level cites its source file.
Usage: build_packet.py TOPIC QUESTION OUTFILE --l1 f --l2 f --l3 f --l4 f
Missing levels are emitted as EMPTY (never silently filled)."""
import argparse, pathlib, sys

def read(path, cap=4000):
    p = pathlib.Path(path).expanduser()
    if not p.exists():
        return f"[MISSING FILE: {path}]"
    return p.read_text(errors="replace")[:cap]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("topic"); ap.add_argument("question"); ap.add_argument("outfile")
    for lv in ("l1", "l2", "l3", "l4"):
        ap.add_argument(f"--{lv}", default=None)
    a = ap.parse_args()
    levels = [
        ("Level 1 — Identity & facts", a.l1),
        ("Level 2 — Current state", a.l2),
        ("Level 3 — History & decisions", a.l3),
        ("Level 4 — Constraints & rules", a.l4),
    ]
    out = [f"# Context Packet: {a.topic}", ""]
    for name, path in levels:
        out.append(f"## {name}")
        out.append(f"Source: {path}" if path else "Source: none provided")
        out.append(read(path) if path else "[EMPTY — answer must label this level a guess]")
        out.append("")
    out += ["## Level 5 — The question", a.question, "",
            "Rule: answer from Levels 1-4 only. Anything outside the packet is labelled a guess."]
    pathlib.Path(a.outfile).write_text("\n".join(out))
    print(f"packet written: {a.outfile} ({sum(1 for n,p in levels if p)} levels sourced)")

if __name__ == "__main__":
    main()
