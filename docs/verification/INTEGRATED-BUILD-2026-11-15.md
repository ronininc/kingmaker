# Integrated 4.5.1 build evidence

Source: `ronininc/kingmaker` at b44cea4132ba4a569b724969152134bf80cee470 plus the isolated candidate commits. Engine: `ronininc/TSS` at 47482a2e59de0bc49a1ad7938a5464710ca401bd plus isolated readiness and SDK policy fixes (engine candidate 684ce15).

## Executed, not inferred

- Engine `NODE_OPTIONS=--max-old-space-size=2048 npm --prefix server run build`: passed, including postbuild desktop module copy. A prior 1 GiB cap exhausted its own V8 heap; the 2 GiB attempt then revealed and fixed an obsolete SDK `network` property.
- Engine `npm --prefix app run build` with 1.5 GiB heap: passed, with chunk-size/dynamic-import warnings.
- Existing dependency trees were compared to the pinned workspace lockfiles using `diffInstalledTree`: zero differences for server and frontend. Reused through symlinks; no dependency installation or model downloads. The user's TSS checkout and its modifications were not edited.
- Actual SDK create-call fixture: 3 policy variants all produce `networkPolicy: {defaultAction:'deny',egress:[]}`. No live sandbox was created. No unsupported tor-only allowlist is invented; posture readback must still pass before execution.
- Engine substrate gate: 90 checks passed. Machine board lock: 6/6. Readiness: 21 checks, including creative briefs addressed to Kingmaker.
- Release signature/output protection suite: 8/8. First install requires detached signature; raw CLI cannot substitute the embedded release public key; installer build checks supplied manifest against the pinned public key before compiling; explicit candidate build outputs refuse existing destinations before deletion.

## Not complete

The package dry-run requires 4 GB free; available space was 2.2 GB and later 1.9 GB. Its reserve was not overridden. No full bundle was signed or installed. No keys were migrated, exported, or created. No live product test or AAA/photorealism claim follows from compilation.

Full release suite after the baseline-repair merge: 1482 tests, 1396 passed, 39 failed, 47 skipped. This run exposed an alias-symlink conflict with strict archive admission, referred for correction. It is not a green release. Prior baseline had 50 failures; remaining baseline failures include missing imported sources, native profile wiring, release provenance and heartbeat integration. Preserve failures instead of bypassing release/security gates.

Reports live beside the isolated checkout: `engine-build-corrected-result.txt`, `engine-frontend-build.txt`, `engine-sdk-policy-test.txt`, `engine-substrate-test.txt`, `engine-board-lock-test.txt`, `engine-readiness-test.txt`, `engine-package-plan.txt`, `release-gate-focused.txt`, `release-integrated-gates-tests.txt`.

## Subsequent integration checkpoint

- Merged e75d6bd: regular executable alias trampoline, preserving exact arguments/exit codes after relocation. Strict archive type checks unchanged. Actual compiled Swift wrapper and fixture engine handshake passed again.
- Added the two existing public product identity-policy files to the exact Armor compatibility allowlist (six files including LICENSE), not any paid daemon/app/service. Updated the exact-list fixtures; `test/payload.test.mjs`: 7/7.
- Native explicit profile overrides now validate complete absolute distinct paths and port before saved-profile or link-key access; malformed input fails closed rather than selecting live state. Native helper test passed and full Swift compiled in the handshake suite.
- Launcher provenance remains its independently maintained repository/commit and is checked against the Launcher artifact pin; installer provenance still must match Kingmaker release tree. Issuance/assets suite: 9/9. Ledger/gate suite: 11/11, including 11 internal release-gate checks.
- Most recent full suite report `release-integrated-latest-tests.txt`: 1483 tests, 1404 passed, 32 failed, 47 skipped. Twenty original baseline failures resolved. Two new failures in that run were fixture manifests missing newly required Launcher source provenance; corrected with explicitly synthetic provenance in 62f80d4 and independently rerun successfully (`launcher-provenance-fixtures-tests.txt`). Do not represent this as a fully green full-suite run. Remaining 30 baseline failure names still require work.
- Test payload archive cleanup now removes only the archive created by that suite, avoiding accumulating repeated 57 MB temporary archives. No user files or preexisting artifacts deleted.
- Packaging still not attempted: free space ended near 770 MiB, below the unchanged 4 GB minimum. Both engine build outputs remain preserved.
