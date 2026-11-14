---
name: rea
description: >-
  REA (Reverse Engineer Anything): read any program, repo, MCP server, CLI or skill before Kingmaker uses it, and say what
  it would do unprompted (phone home, read credentials, install itself at login, ask for admin rights, run downloaded or
  hidden code). Use when the owner asks "is this safe", "what does this do", "check this repo", wants something
  connected, or wants a binary or package reverse engineered.
---

# REA: read it before it runs

REA is built into Kingmaker (`lib/rea.mjs`, its rules in `lib/rea-rules.mjs`). It only reads: it never runs what it
inspects. Every connector, extension and core skill goes through it before Kingmaker uses it, and again whenever its
code changes.

## The three verdicts

| Verdict | Means | What Kingmaker does |
|---|---|---|
| clean | nothing reaches for access unprompted | runs it as itself |
| sandboxed | telemetry, credential reads, login items, admin rights, hidden folders in the home folder | runs it under macOS's sandbox with exactly those parts denied; the rest works |
| rejected | fetches code and runs it (a download piped straight into a shell), or runs hidden code (decoded or evaluated at runtime) | never connects it |

Every finding names the file and line. The owner can clear a finding REA got wrong from the Connectors page; the
clearance holds only for that exact code, so a later change brings it back. A rejected finding can't be cleared.

## When the owner asks

1. **"Is this safe?" / "check this repo":** connect it from the Connectors page (CLI, MCP server, skill or repo folder),
   or point at the folder. Report the verdict and each finding in plain words: what, which file and line, and what the
   sandbox would take away.
2. **"Connect X":** the same, through the Connectors page. A clean or sandboxed connector is added; say which. A rejected
   one is not, and say why.
3. **Reverse engineer a binary or package:** use the `clone` skill's method (`clone/references/reverse-engineer-anything`,
   MIT, from morluto/rea): map the surface, read the entry points, then drive or rebuild it.

## Boundary

REA judges code on this Mac; a remote MCP server's code isn't here, so it is reached only through the engine's MCP hub.
A verdict is about access, not quality: clean code can still be wrong. Never run what REA rejected to "see what
happens".
