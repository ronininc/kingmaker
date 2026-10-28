---
name: clone
description: Clone any software — understand it, drive it, and rebuild it. Use to reverse engineer a shipped binary or package (REA, Ghidra), wrap any GUI app or repo as an agent-native CLI (CLI-Anything), and reconstruct or edit the code (Aider, TokenRing). For ordinary analysis of a complete source repository you already have, use normal repository tools, not this.
metadata:
  version: "1"
---

# Clone

One skill for the whole arc of cloning software: **understand → drive → rebuild**. It
is a conductor over five openly-licensed tools; it does not replace them. Read the
component methodology (under `references/`) when you reach that stage, and connect or
install a tool only when the task actually needs it.

Clone only what you have the right to clone: your own software, openly-licensed
software, or software whose owner has asked you to. Reverse engineering for
interoperability, security review, recovery, or learning is the use here. Do not use
this to defeat a license, strip protection, or pass someone else's work off as new.

## The five tools

| Tool | License | Role in cloning |
|------|---------|-----------------|
| **REA** (Reverse Engineer Anything) | MIT | Understand a shipped artifact: native/Electron/packaged binaries, firmware, browser targets. Decompile, explain features, compare versions, guide a reconstruction from evidence. `references/reverse-engineer-anything/SKILL.md`. |
| **Ghidra** | Apache-2.0 | The decompiler and disassembler REA leans on for native binaries (the SRE framework from the NSA). A separate install; see `references/tools.md`. |
| **CLI-Anything** | Apache-2.0 | Turn the target — a GUI app or a source repo — into an agent-native CLI harness with one-shot commands, a REPL, `--json`, and truthful previews. `references/cli-anything/SKILL.md`. |
| **Aider** | Apache-2.0 | AI pair programming in the terminal: make the reconstruction real, edit by edit, against a git repo with tests. See `references/tools.md`. |
| **TokenRing** | MIT | The agent framework (ModelRegistry, services, tools) when the clone needs a long-running agent of its own, not one terminal session. See `references/tools.md`. |
| **graphify** | Apache-2.0 | Turn the target codebase (or its docs, PDFs, media) into a queryable knowledge graph before a rebuild — the map of the "understand" stage. `references/graphify/SKILL.md`. |

## The arc

1. **Understand.** Point REA at the shipped artifact. For a native binary it uses
   Ghidra; for Electron/JS, packaged, firmware, or browser targets it uses its own
   paths. Keep the evidence (what was observed, where). Read
   `references/reverse-engineer-anything/SKILL.md` first; it tells you when REA is
   needed at all and when ordinary source tools are enough. When the target is a whole
   codebase or corpus, graphify (`references/graphify/SKILL.md`) turns it into a queryable
   knowledge graph first, so the rebuild has a map.
2. **Drive.** When you need to exercise the target to see what it does — or to give an
   agent hands on it — wrap it as a CLI with CLI-Anything. Read
   `references/cli-anything/SKILL.md`; everything its resource map names is vendored
   here, so it works offline.
3. **Rebuild.** Reconstruct the behaviour in a fresh repo, edit by edit with Aider
   (one-shot or chat, with tests), or stand up a longer-running agent with TokenRing
   when the job outlives a single session. `references/tools.md` has the install and
   the hand-off for both.

Not every clone needs all three. A feature explanation stops at step 1; a "let an
agent use this app" stops at step 2; a full reconstruction runs all three.

## Governance

Every outward or changing step keeps Kingmaker's gates: a tool that sends, pays,
publishes, changes credentials, or writes persistent config waits for the owner's go.
Installing Ghidra, Aider, or a TokenRing package is an owner-approved step, surfaced on
Kingmaker's setup screen like any connector. On this Mac the operator runs REA through the
R&D floor (`kingmaker rd`, `docs/RD-FLOOR.md`): free engines only, paid providers refused,
GPL and LGPL engines not dispatched, and Kingmaker does not download the toolkit. The
method in `references/reverse-engineer-anything/SKILL.md` still says how to read the evidence.

## Output

Report, every time: the target and where it came from; which tools ran and what each
found; the evidence kept; what was rebuilt and what was left; and any right-to-clone or
backend limit that constrained the work.
