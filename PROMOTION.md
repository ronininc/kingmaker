# Promotion — how Kingmaker moves from proven to public

The mantrap has two doors and a room behind them. Nothing reaches a user's
machine except through both doors, in order:

```
kingmaker-private          ronininc/kingmaker            update host
(the proving ground)  →    (the public repo)        →    (latest.json)
 PROVE                     PROMOTE                        RELEASE
 suites green              blob-SHA diff,                 version is the
 in this tree,             branch + PR,                   founder's call;
 in the shipped            founder merges                 issuance gate;
 layout                    (his tap)                        mirror flips last
                                                            ↓
                                              launcher update — app +
                                              launcher, one signed unit
```

## 1. Prove — in private, in the shipped layout

A component is proven when its own test suite passes **in the private tree,
in the exact layout it will ship in**. A suite that passed in some other
tree proves nothing about this one (learned 2026-10-21, twice in one
evening: relocated components whose sibling modules and shared `lib/`
stayed behind — green at home, dead on arrival).

`scripts/promote.mjs` runs the suites itself. There is no checkbox.

## 2. Promote — the door (`scripts/promote.mjs`)

```sh
node scripts/promote.mjs --version 0.5.0 --components components.json [--dry-run]
# components.json: [{ "path": "stack/littlebrother", "test": "tests/run-tests.mjs" }, ...]
```

- **Proof gate (mechanical):** every suite runs; any failure, missing
  suite, or nonzero exit refuses the promotion. Nothing is staged.
- **Diff:** the proven set is blob-SHA compared against public `main`.
  Only the delta travels; byte-identical files are named and stay home.
- **Stage:** the delta lands in `~/workspace/.gh-sync/promote/` with a
  `proof-manifest.json` and a PR body carrying the in-layout proof table.
  The connector snapshot carries UTF-8 text only — a binary in the set is
  **excluded and named in the PR body**, never silently dropped.
- **Push** (unless `--dry-run`): one branch + one PR against
  `ronininc/kingmaker`. The tool **never merges, never creates a release,
  and never picks a version** — `--version` is a required input with no
  default, because the version number is the founder's call.
- **Merge is the founder's tap.**

## 3. Release — the founder's version call

Built by `scripts/release-parts.mjs`, gated by `scripts/release-gate.mjs`,
flipped by `scripts/mirror-v2.mjs`:

- The manifest (`kingmaker.release/1`) now declares the release's
  **platforms** (`lib/release-platforms.mjs`): `macos` is always the parts
  built here; `linux`/`windows` may be declared `placeholder` (empty,
  unsigned) until real builds exist, or `ready` with pinned artifacts and
  a signature reference. Non-Mac artifacts are built on their own hosts —
  off-Mac Apple-side builds use **xtool** (xtool-org/xtool, MIT; the
  cross-platform Xcode replacement from the TSS work) — and only their
  pins are carried in the manifest. `latest.json` gains the same platforms
  map; its legacy top level (`version`, `tag`, `engineSha256`, `archive`)
  is written exactly as before, so enrolled Macs reading it today are
  unaffected.
- The mirror verifies every object (macOS parts under `v<version>/`,
  other platforms under `v<version>/<platform>/`) and flips `latest.json`
  **last, only on a fully verified set**.

### The issuance gate — the 2026-10-21 acceptance lesson

The 4.2 acceptance run failed at the installer's signature check: the
shipped 0.3.1 launcher ran the **old** installer, whose trust pin belonged
to the old release line, while the new installer existed only as source.
The release's artifacts had not been built from the release's own tree —
and the manifest couldn't even say so.

So the manifest now records **issuance provenance**: the source tree
(repo + commit) the release was built from, and the trees its installer
and launcher artifacts were built from. The staged gate
(`verifyStagedRelease`, `requireIssuance` — always on for release-parts)
refuses a release whose installer or launcher provenance is missing or
from another tree. An installer from another tree carries another line's
trust pin; that is now a build-time refusal, not an acceptance-day
surprise.

## 4. Update — one signed unit

Existing users update from inside the launcher: `latest.json` points at
the release, the signed manifest authenticates it, and the **app +
launcher move together** — never one without the other.
