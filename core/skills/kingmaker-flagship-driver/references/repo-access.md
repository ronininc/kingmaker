# What you can reach, and committing

The driver reads the repository, runs tests, and (only with the owner's yes) commits and opens a pull request.
Tests need a real checkout and Node; reading alone can't produce a verified result. Say which of these you are on.

## A: a local checkout (verifies tests)

```bash
git clone <this repository's URL> kingmaker && cd kingmaker
node -v                        # 22 or newer
node --test test/*.test.mjs    # no install step needed
```

If the shell can't reach the network or has no git credentials, the owner clones it once in their own environment
and you work in that folder.

## B: an installed Kingmaker.app (verifies live behaviour)

Its command line is inside the app: `/Applications/Kingmaker.app/Contents/Resources/sol-ghost/bin/kingmaker` (or
under `~/Applications`). `kingmaker doctor`, `kingmaker status` and the engine checklists run against it. A checkout's
own `bin/kingmaker` has no runtime of its own (it borrows an installed Kingmaker.app's engine), so live results come from the
installed app.

## C: reading only (plans, never verifies)

With only a browser or a code viewer you can read files and build the worklist. Every result is UNVERIFIED on this
path. Say so in the report.

## Committing (owner's yes required)

Follow `kingmaker-repo-hygiene`. One coherent change per branch:

```bash
git switch -c fix/<short-name>
git add <only the source, test and doc files you changed>
git status && git diff --staged --stat     # nothing generated, personal or secret
git commit -s -m "<what changed, in plain words>"
```

## Pull requests (a separate yes)

With GitHub's `gh` CLI signed in:

```bash
git push -u origin fix/<short-name>
gh pr create --title "<what changed>" --body "<see the checklist below>"
```

Without it, hand the owner the branch name, the diff and a ready-to-paste title and body.

## Pull request body

- What changed and why, in plain words.
- The test that covers it, and that it was seen failing on broken code and passing on the fix.
- The suite result (`node --test test/*.test.mjs`: pass, fail, skipped).
- Any README or docs line it changes, and why that line is now true.
- That nothing generated, personal or secret is included.

A change that adds a capability without a test is incomplete. Say so rather than asking for a merge.
