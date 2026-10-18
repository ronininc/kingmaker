# The release loop, step by step

The driver keeps one ledger across all steps: claim → check → result seen → evidence → README line → open or
closed. Keep it in a scratch file outside the repository.

## Step 1: clean tree (kingmaker-repo-hygiene)

```bash
git status
git diff --stat
node -v                        # 22 or newer
```

Nothing generated, personal or secret may be in the change. For a real reproducibility check, clone the repository
into a temporary folder and run the suite there (see `kingmaker-repo-hygiene`). If a fresh clone fails where the
working tree passes, something the code needs is untracked: fix that first, because every later result runs on this
tree.

## Step 2: full suite (kingmaker-proof-runner)

```bash
node --test test/*.test.mjs
```

Copy the summary counts (tests, pass, fail, skipped) into the ledger. List each skipped test with the reason it
printed (for example `engine-wiring`: the engine's source not imported). Each failure, with its assertion and file:line, is a
worklist item.

`npm run proof:owner-voice` and `npm run proof:owner-keys` need the engine's source, which this repository doesn't
have. From a public checkout they exit 2 (SKIP): record them UNVERIFIED.

## Step 3: live checks

With Kingmaker.app installed:

```bash
KM="/Applications/Kingmaker.app/Contents/Resources/sol-ghost/bin/kingmaker"   # or ~/Applications/...
"$KM" version
"$KM" doctor
"$KM" status
```

`version` must match `package.json`'s version for the release being checked. Each ✗ from `doctor` goes in the ledger,
marked either "this Mac's setup" (a tool not installed, a permission not granted) or "code" (something that should
work and doesn't).

## Step 4: missing tests (kingmaker-proof-authoring)

Walk the README top to bottom. For each claim, find its test in
`kingmaker-proof-runner/references/proof-taxonomy.md`. A claim with no test gets one, seen failing on broken code
and passing on the real code, or the claim is reworded to what is actually shown.

## Step 5: verify the parts (kingmaker-engine-verifier)

For each part in `kingmaker-engine-verifier/references/engine-checklists.md`: tests, live checklist, screen recording
with audio, sha256, verdict. Voice goes through `kingmaker-voice-verification`; web research through
`kingmaker-native-internet`. A part not done is UNVERIFIED in the ledger, not left blank.

## Step 6: fix from evidence

Fix the root cause in `lib/` from the failing assertion or what the recording shows, not from a guess. Re-run that
area's tests, then the whole suite. Never loosen a test to get green.

## Step 7: sync the words (kingmaker-readme-sync, kingmaker-doc-author)

- README.md: the command table, the "Measured on…" numbers (dated), the "Known gaps" section.
- docs/*.md pages that describe the same things.
- The usage block at the top of `lib/cli.mjs`: every command there exists in its `main()` switch.
- `package.json` version.

Downgrade anything the ledger doesn't show passing.

## Step 8: run it all again

Re-run steps 2 and 3 on the final tree. The release is ready to hand to Ronin when:

- the suite shows 0 failures and every skip is explained;
- each part is VERIFIED with a CAPTURED recording, or DEFERRED with its reason in the README;
- the README, docs and usage block say exactly what the ledger shows.

Otherwise go back to the first open ledger row.

## Committing and pull requests

Only on the owner's explicit yes, one coherent change per commit, signed off (`git commit -s`). Before a commit:
`git status` and `git diff --staged --stat`, and nothing from the never-commit list in `kingmaker-repo-hygiene`.
Push and pull requests need their own yes. See `repo-access.md`.
