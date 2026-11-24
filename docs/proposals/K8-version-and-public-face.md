# K8 — One true version, and the public-face lines (PROPOSAL — the owner rules)

Claude seat, 2026-11-24. Nothing in this file has been applied. Checked from a cloud clone of `ronininc/kingmaker`; the Mac itself was not reachable from this seat.

## Headline

**The published release is 4.5.2, not 4.5.1, and `main` does not contain it.** `main` is 38 commits behind the released tag. Every version statement on `main` is therefore wrong, including the file that exists to prevent this (`docs/CURRENT-VERSION.md`, which still says production is 4.4.4).

## What each place says today

| Place | Says | How it was checked |
|---|---|---|
| GitHub latest release | **4.5.2**, published 2026-11-16, 7 assets, not a draft | GitHub API, latest release of `ronininc/kingmaker` |
| Tag `v4.5.2` | commit `4a453cc` | `git ls-remote --tags origin` |
| `candidate/kingmaker-4.5.2` | `package.json` 4.5.2; tag + 2 commits; its README still says "Current release: 4.5.1" | `git show origin/candidate/kingmaker-4.5.2:package.json`, `git rev-list --count v4.5.2..origin/candidate/kingmaker-4.5.2` = 2 |
| `main` `package.json` | 4.5.1 | `grep '"version"' package.json` |
| `main` `README.md` line 7 | "Current release: 4.5.1" | read |
| `main` `docs/CURRENT-VERSION.md` | production 4.4.4, main 4.4.5, installed 4.4.6 (dated 2026-11-11) | read |
| `main` `AGENTS.md` line 6 | repeats 4.4.4 / 4.4.5 / 4.4.6 | read |
| `main` vs the release | 0 ahead, 38 behind `v4.5.2`; 0 ahead, 40 behind the candidate branch | `git rev-list --count main..v4.5.2`, `git rev-list --left-right --count main...origin/candidate/kingmaker-4.5.2` |
| A 4.5.3 branch or tag | none | `git ls-remote --heads --tags origin` |
| Mac dev shell plist | 4.5.3 (per the task brief) | **NOT VERIFIED from this seat.** No Mac attached. |

How a plist gets its number: `app/Info.plist` and `installer/Info.plist` carry `@VERSION@`; `scripts/build-app.sh` line 12 and `scripts/build-installer.sh` line 33 fill it from `package.json`. So a dev shell reporting 4.5.3 was built from a working tree whose `package.json` said 4.5.3. No commit on the remote says that. The 4.5.3 number exists only on the Mac, uncommitted.

## Proposal: one true version

1. **The version lives in one place: `package.json` at the repo root.** The build scripts already read it. Nothing else states a number of its own.
2. **A version is real only when a tag carries it.** `vX.Y.Z` on the commit whose `package.json` says X.Y.Z. Today that makes the true released version **4.5.2**.
3. **Bring `main` up to the release.** Merge `candidate/kingmaker-4.5.2` into `main` with a merge commit (repo rule: no squash, no rebase). This is the owner's or the backend seat's act; it touches `lib/`.
4. **4.5.3 gets a home or gets dropped.** Either cut `candidate/kingmaker-4.5.3` from the merged `main` with the `package.json` bump committed, so the dev shell's number traces to a commit, or rebuild the dev shell from 4.5.2. Run on the Mac to see what the 4.5.3 shell was built from:
   ```bash
   /usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" ~/Applications/Kingmaker.app/Contents/Info.plist; git -C <kingmaker checkout> status -sb; git -C <kingmaker checkout> diff -- package.json
   ```
5. **Everything else points, never states.** `README.md` line 7 becomes a link to the latest release without a number. `AGENTS.md` line 6 drops its numbers and says only "read `docs/CURRENT-VERSION.md`". `docs/CURRENT-VERSION.md` takes the candidate branch's version of the file (it already records 4.5.2 with evidence) and adds one row for the dev shell.

## Proposal: corrected public-face lines

The repo went private 2026-11-19 (per the brief). A private repo cannot be "open to everyone", and "source-available" is not true while the source is not available. The licence file is still PolyForm Noncommercial; whether that stays is the owner's call, so two options.

**README line 1** — now: `🤫 source-available: open to everyone, not for commercial use 🤫`

- Option A (recommended; true today): `🤫 free for personal use, not for commercial use 🤫`
- Option B (if the repo reopens): keep the current line.

**README line 5, last sentence** — now: "It is source-available under the PolyForm Noncommercial License 1.0.0."

- Option A: "It is free for personal and noncommercial use under the [PolyForm Noncommercial License 1.0.0](LICENSE). The source repository is private."

**README line 7** — now: "**Current release: [4.5.1](…/releases/tag/v4.5.1).**"

- Proposed: "**Current release: see [the latest release](https://github.com/ronininc/kingmaker/releases/latest).** One download: everything, or nothing."

**README line 370** — now: "Kingmaker is source-available, not open source: any commercial use…"

- Option A: "Kingmaker is not open source, and its source repository is private: any commercial use, by any company, needs a written licence from Ronin Inc."

**Also found, same class of error:**

- README lines 68 and 357 say the installer is **notarized**. The 4.5.2 release notes and the candidate branch's `CURRENT-VERSION.md` say the 4.5.2 artifacts are **not notarized** and a fresh Mac may see Gatekeeper. One of the two is wrong for the current release; the README should match the release.
- README line 60 says the installer downloads Ollama models. The 4.5.2 release notes say model and corpus installation is now inventory-only, no automatic downloads.
- `addons/ronin/README.md` line 3 says "free, source-available Kingmaker". Same fix as line 1.
- `v041/` and `v042/` launch copy says "source-available". Historical drafts; proposed: leave as history, do not reuse.

## What the owner rules on

1. True version = `package.json` + tag (4.5.2 today): yes or no.
2. Merge the 4.5.2 candidate into `main`: yes or no, and which seat.
3. 4.5.3: commit it to a branch, or discard it.
4. Public-face Option A or B.
