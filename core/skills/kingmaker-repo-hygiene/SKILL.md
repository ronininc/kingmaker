---
name: kingmaker-repo-hygiene
description: >-
  Keep a Kingmaker checkout clean and reproducible: nothing generated, personal or secret is committed, a fresh
  clone passes `node --test test/*.test.mjs` with no repair, and every contribution is signed off. Use when the owner
  says "commit this", "open a PR", "clean up the repo", "what should be gitignored", "why does a fresh clone fail",
  or before any commit is made. Commits, pushes and pull requests happen only on the owner's explicit yes.
---

# Kingmaker repo hygiene

A Kingmaker checkout should work the same on any Mac from a fresh clone. The fastest ways to break that, or to leak
something, are committing a build output, a local data file, or a secret. This skill keeps each commit clean.

## Never commit

- Build outputs: `dist/` (the built app, the installer, release parts), `node_modules/`, `*.log`, the binaries the
  build fetches into `app/Resources/bin/` (`ffmpeg`, `ffprobe`, `uv`, `uvx`). `.gitignore` already lists these;
  extend it rather than working around it.
- Local tool state and secrets: `.env`, `.env.*` (only `.env.example` is tracked), `.wrangler/`, API keys, tokens,
  signing certificates, desk keys.
- Kingmaker's own data: anything from `~/Library/Application Support/sol-ghost/` (the runtime, vault, memory,
  logs, the voice-turn ledger, an enrolled voiceprint) or from Kingmaker's Files folders. That is the owner's, not
  the repository's.
- The engine's source. It is not part of this repository and never belongs in a commit.
- Evidence recordings and screenshots from verification runs. Keep them outside the checkout.
- Personal data in any text: people's names, client names, home-folder paths with a user name, phone numbers,
  private email addresses.

## Before every commit

1. `git status` and `git diff --staged --stat`. Look for anything on the list above, and for unexpected large
   files (a multi-MB blob in a source diff is almost always a mistake).
2. Search the staged diff for secrets and personal data:
   `git diff --staged | grep -nE "sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|BEGIN [A-Z ]*PRIVATE KEY|/Users/[a-z]"`.
   Any hit is unstaged and fixed before going on.
3. Run the suite: `node --test test/*.test.mjs`. A commit that turns a test red is not ready.
4. If the change touches build scripts or `package.json`, ask: would a fresh clone still work? Code that now needs a
   file that only exists on this Mac is a bug to fix at the source.
5. Sign off: `git commit -s` (CONTRIBUTING.md asks for it on every commit).
6. Commit only when the owner said yes to this commit. Push and open pull requests only on a separate, explicit yes.

## If something was committed by mistake

1. Stop tracking it without deleting the local copy: `git rm --cached <path>`.
2. Add its pattern to `.gitignore`.
3. Commit that, with the owner's yes.
4. For a secret or a large file already in pushed history, tell the owner plainly: the secret must be rotated, and
   rewriting history is their decision. Never rewrite shared history on your own.

## Fresh-clone check

```bash
git clone <this repository> "$(mktemp -d)/kingmaker" && cd "$_"
node -v                         # 22 or newer
node --test test/*.test.mjs     # no install step: the suite has no npm dependencies
```

If it passes in your working tree but fails here, something the code needs is untracked, or something tracked
shouldn't be. That gap is the bug.

## Pull requests

- One coherent change per pull request, with its tests (`kingmaker-proof-authoring`) and, if it changes what the
  README says, the README edit (`kingmaker-readme-sync`).
- No build outputs, no reformat-everything noise mixed with logic.
- Changes to the engine can't be accepted here (its source isn't in this repository): report what you found
  in an issue instead.

## Report

`CLEAN-CLONE: PASS` or `CLEAN-CLONE: FAIL (<reason>)`, plus exactly what you unstaged or stopped tracking and why.
