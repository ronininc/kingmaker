# v0.4.1 Installer Changes — Knowledge Library Delivery

**Status:** SPEC + PATCH, 2026-10-20. Requirements: `~/workspace/kingmaker-v041-build-package.md` §1.
**Patch:** `engine-knowledge.patch` (against `installer/engine.sh` of the public mirror — **dry-run verified clean; applied copy byte-identical to the tested build, `bash -n` clean**).
**Schema:** `library-manifest.schema.json` (`kingmaker.library/1`).

> **Apply-at-source rule:** the survey tree is a mirror of the public repo, whose source of truth is **kingmaker-os**. Every change below marked **[source]** is made in kingmaker-os and re-mirrored; the patch in this folder is the exact diff to apply there. Nothing in this package edits the mirror.

## 0. What is wrong today (v0.4.0, verified in `engine.sh`)

- Preflight adds the full library (`knowledge.totalMB` × 1 MiB) to the disk-room gate and **hard-fails the install** when it doesn't fit — the delete-to-fit problem.
- Step 5 (phase 88) runs the app's corpus bootstrap and **fails the install** if receipts are incomplete. There is no delivery choice and no persisted setting: the library is not part of the payload as files, but it *is* part of the install as a gate.
- Corpora are fetched by the bundled bootstrap (`Contents/Resources/<runtime>/scripts/solomon-bootstrap-corpus.mjs`) from its own sources, with no release-signed, file-level manifest governing them: receipts prove a corpus *arrived*, not that its bytes are the release's bytes.

## 1. Where the corpora go (payload / release side) **[source]**

1. Corpus objects move to the update host: R2 bucket **`kingmaker-releases`**, prefix **`library/`**, one object set per corpus: `library/<corpus-id>/<file>` for every file the corpus receipts cover. The release's tag folder (parts, app archive) no longer carries corpus payloads or corpus-sized anything; the app's `knowledge-runtime` (the bootstrap code itself) stays in the app — code ships, data streams.
2. `scripts/release-parts.mjs` **[source]**: `knowledgePlan()` additionally emits `kingmaker-library-manifest.json` per the schema in this package (corpora from the same TIER1 confirmed+licensed filter; per-file `path`, R2 `object`, `size`, `sha256` computed at release build time from the staged corpus files), and the release step uploads the per-corpus objects under `library/` next to the tag folder. Corpora that cannot be hashed at build time refuse the release (same spirit as the existing payload checks).
3. Signing **[source]**: after the parts are written, sign the library manifest with the **same offline release key and the same scheme** as the app manifest (`scripts/kingmaker-release-sign.mjs` pattern: RSA-PSS/SHA-256, base64, detached) → `kingmaker-library-manifest.json.sig`. Both files publish with the release (GitHub release assets *and* the update-host tag folder — see Open Question 1).

## 2. Release manifest schema delta (`kingmaker-manifest.json`) **[source]**

`knowledge` gains two optional fields; everything else is unchanged:

| Field | Type | Meaning |
|---|---|---|
| `knowledge.libraryManifest` | string | Asset/object name of the library manifest (e.g. `"kingmaker-library-manifest.json"`). Absent → the release predates signed libraries; the engine keeps the exact 0.4.0 bootstrap path. |
| `knowledge.libraryBase` | string (URL) | Absolute prefix URL for corpus objects (the public face of `library/`). Optional: when absent the engine derives `${KINGMAKER_UPDATE_URL}/library` on enrolled/update-host installs. |

`knowledge.corpora.<i>.sizeMB` and `knowledge.totalMB` **stay** — the install screen sizes the choice from them before anything is fetched.

## 3. `engine.sh` changes — `engine-knowledge.patch`, in order **[source]**

| # | Hunk | Change |
|---|---|---|
| 1 | Header comment | Step 5 documented as a delivery choice, not a gate. |
| 2 | Globals + arg parse | New `--library-delivery full\|stream` (env `KINGMAKER_LIBRARY_DELIVERY`), paralleling `--pack`. `LIBRARY_DELIVERY_SET` records whether the owner picked explicitly on this run. |
| 3 | `--inspect` output | Adds `libraryTotalMB`, `libraryCorpora`, `libraryDelivery` (the persisted setting on this Mac, default `stream`) — the install screen's inputs for the choice, same channel that already feeds the pack picker. |
| 4 | Preflight | Resolves `EFFECTIVE_DELIVERY`: explicit arg → env → persisted setting (`calibration.json` `libraryDelivery`) → `stream`. Invalid value fails early, like a bad part name. Computes `LIB_BYTES` once. |
| 5 | Preflight room math | The library's bytes join `NEED` **only when delivery = full**. Stream prints the honest note (library size, streams later, not part of the room this install needs) and never fails on library room. |
| 6 | New section after `fetch()` | The library-manifest machinery: `lmf`/`lmfn` accessors (same pattern as `mf`), `verify_detached` (stock macOS openssl, RSA-PSS/SHA-256, pinned release key — the release manifest's own verification pattern), `fetch_library_manifest` (resolves the manifest + `.sig` from the **same source as the parts** — `--source` dir, update host `BASE_URL`, GitHub API asset ids, or the public release URL — using the existing 0600 `AUTH_HEADER`; checks `schema == kingmaker.library/1`, then the signature; **a present-but-unverifiable manifest fails the install**, an absent one returns quietly), `verify_library_files` (every listed file under the staged sources: present, size equal, sha256 equal; paths with a leading `/` or a `..` segment are refused). |
| 7 | Step 5 (`full`) | Before the bootstrap runs, `fetch_library_manifest` is attempted; on success the bootstrap is invoked with `SOLOMON_LIBRARY_MANIFEST=<verified file>` and `SOLOMON_LIBRARY_BASE=<base>` (see §5), and after `receipts_complete` passes, `verify_library_files "$KNOW_STAGE"` runs — a mismatch fails with the house resume wording (what came down is kept; pressing the button again resumes). On absence, a note says the library is fetched the 0.4.0 way, and behavior is otherwise identical to 0.4.0. |
| 8 | Step 5 (`stream`) | New branch ahead of the live/dry-run branches: **nothing is staged, nothing is fetched, the step cannot fail.** `KNOW_STAGED` stays 0, so commit leaves any existing on-disk library untouched and moves nothing. A complete library already on disk still wins earlier (`KNOW_REUSE`) in both modes — the installer never deletes or strands the owner's library. |
| 9 | Post-commit | Persists `libraryDelivery` into `$DATA/calibration.json` as a plain top-level key beside `macProfile` (plutil replace, else insert, else create the file with `{schema: 1}`), recording `EFFECTIVE_DELIVERY`, and notes it is changeable in Settings. It is **not** written into the cemented `install.json` — delivery is a preference, not an identity. |

Phases, progress spans, the journal/rollback machinery, and the commit step are untouched.

## 4. Where the delivery choice lives: the installer UI (not a first-run prompt)

**Decision: the choice is made on the install screen, through the pack-picker bridge that already exists.** `KingmakerInstaller.swift` already runs `engine.sh --inspect` before the button exists, renders choices (the packs) as cards above its one button, and passes the pick as an engine argument (`--pack`). The library choice rides the same rails **[source]**:

- `inspect()` reads the new `libraryTotalMB` / `libraryCorpora` / `libraryDelivery` fields.
- A `LibraryDeliveryPicker` under the pack picker, two cards, sizes stated plainly: **“Download everything — Kingmaker (X GB) + the knowledge library (Y GB), all of it with this install”** vs **“Install now, stream the library later — Kingmaker (X GB) now; the library (Y GB) streams in after, or in full whenever you say so in Settings”**. The card matching the persisted setting is pre-selected (first install: **Stream** is pre-selected).
- `start()` appends `--library-delivery <pick>` to the engine arguments, exactly like `--pack`.

Why not the app's first-run prompt: the choice decides *preflight disk math and step 5 of this install* — by first run, the install has already either demanded the room or skipped the fetch, so a first-run prompt can't be the decision, only a second one. The app still owns the setting afterwards (§5); the installer merely seeds it. The one-button contract is preserved: choices sit above the button, as the packs already do.

## 5. The persisted setting and the in-app change path (app side) **[source]**

- **Home:** `calibration.json` in the data dir (`~/Library/Application Support/sol-ghost`), top-level string `libraryDelivery: "full" | "stream"`. Read by the app with the same precedence the engine uses: the file's value is the owner's current choice; the installer never overwrites it with its default on an update run (it re-records the *effective* value, which on an update without an explicit pick *is* the persisted one).
- **stream → full** (“Download everything”, Settings → Knowledge library): the app fetches `kingmaker-library-manifest.json` + `.sig` from the update host (`libraryDelivery` change is the owner's act; no installer involved), verifies the signature against the pinned release public key, then fetches every missing corpus file from `<libraryBase>/<object>` with Range-resume, checking size + sha256 per file against the signed manifest, writing the corpus receipts as files complete — so `receipts_complete` passes and the *next* installer run sees `KNOW_REUSE`. Runs in the background with progress; an interrupted fetch resumes from partial files; the app never blocks on it.
- **full → stream**: the app offers (never does silently) to reclaim the local copy — corpora move to the Trash (recoverable, the installer's own convention for replaced knowledge), receipts go with them so nothing half-believes the library is present, and the setting flips. Kingmaker keeps working: a skill that needs a corpus queues its fetch — a missing corpus is a queued download, never an error wall.
- **Enforcement**: any corpus file served to the engine is hash-checked against the signed library manifest before first use after a fetch; an unsigned or mismatched library is refused, the same rule the installer applies.
- **Bootstrap contract (step 5, full mode):** when `SOLOMON_LIBRARY_MANIFEST` is set, the corpus bootstrap **[source]** fetches per-corpus objects from `SOLOMON_LIBRARY_BASE` (Range-resume, per-file sha256 against the manifest, receipts as today) instead of its historic sources; when either variable is empty it behaves exactly as 0.4.0. The engine still post-verifies the staged tree itself (§3.7), so the guarantee does not rest on the bootstrap alone.

## 6. Verification summary (what proves what)

| Guarantee | Proved by |
|---|---|
| The hashes can be trusted | Detached RSA-PSS signature over the library manifest, pinned release key, fail-closed (engine §3.6; app §5) — same construction as the release manifest's signature, which 0.4.0 already ships. |
| Every fetched file is the release's file | Per-file size + sha256 vs the signed manifest: engine post-check on staged files (full install), app check on streamed files (post-install). |
| Interrupted fetch loses nothing | `fetch()`'s existing `.partial` + Range resume for engine downloads; bootstrap/app fetchers keep partial corpus files + receipts, resume on the next press/run. |
| The app launches regardless | Stream mode stages nothing and cannot fail step 5; full mode failing keeps the verified parts and resumes — and a *fetched-later* library is never on the launch path at all. |
| No silent state change | Setting flips are owner acts in Settings; the installer records, never cements, and an update run without an explicit pick re-records the owner's existing value. |

## 7. Acceptance (maps to the build package's step 5)

1. Fresh install on the 8 GB M3, delivery = stream: install completes **without deleting anything**; app launches with no library present; the library streams in from Settings on demand.
2. Fresh install, delivery = full: behaves like 0.4.0, plus every staged file verified against the signed library manifest.
3. Kill the network mid-library (both modes): resume completes; hashes verify; no reinstall.
4. Flip stream → full → stream in Settings: fetch completes in the background; reclaim is offered, Trash-recoverable, receipts consistent (next installer run's `KNOW_REUSE` agrees with reality).
5. Tamper with one byte of the library manifest: installer and app both refuse it and install nothing from it.

## 8. Out of scope for this package

Payload assembly and signing (Mac-side, Robbie's tap), the R2 upload mechanics beyond §1.2's contract, and the SPACE/LittleBrother wiring (§§2–3 of the build package).

## 9. Open questions for Robbie

1. **Where does the signed library manifest live?** The patch resolves it from the same source as the parts (update host, GitHub assets, or local folder), so it works either way — but release tooling must decide: publish `kingmaker-library-manifest.json` + `.sig` as GitHub release assets too, or only on the update host (GitHub-direct installs would then fall back to the unsigned 0.4.0 bootstrap path)?
2. **Streaming granularity:** the design streams whole corpora on demand (receipt-grained, matching `receipts_complete`). Is that fine for 4.1, or does any single corpus large enough need file-level laziness now? (File-level would be bootstrap/app work, not engine work.)
3. **Update installs with a complete library:** the patch always reuses a complete on-disk library regardless of the delivery setting (stream-on-update never auto-reclaims). Confirm that's the wanted rule — reclaim only ever happens as the owner's explicit act in Settings.
