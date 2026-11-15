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

## Final local integration checkpoint (supersedes earlier build status)

- `release-current-all-tests.txt`: `node --test --test-force-exit --test-concurrency=1 test/*.test.mjs` completed in 270.5 seconds: **1,488 tests, 1,434 passed, 7 failed, 47 skipped**. This is not a green aggregate.
- One failure was generated registry drift after restoring two exactly pinned governed source skills. Regenerated the inventory in `66bf05b`; the independent registry suite then passed **6/6**. Remaining six aggregate failures depend on absent stripped private-import metadata/scripts or non-Mac platform source. Do not substitute raw engine sources for generated import evidence or conceal these failures.
- Installer/archive production-signature tests independently passed **26/26**, including 20 internal deterministic archive checks. Fixture signatures remain unacceptable to the production trust gate. Installer tests use loopback-only transfer and isolated temporary state.
- Restored source governance and connector tests passed **25/25**. Restored third-party skill text remains quarantined rather than becoming automatically callable.
- A full 4,485,619,712-byte Mac app was built from the engine candidate with the existing voice, agent, browser, knowledge and guardrails resources, using APFS clones. No models or dependencies were downloaded. The existing pinned `Kingmaker Release` certificate signed it and the unmodified production app inspection gate passed. Bundled engine `/api/health` returned HTTP 200 in an isolated fresh profile; bundled voice, agent and Python executables launched. Fresh onboarding remains locked, so this is boot/closure evidence, not a completed user chat or production install.
- The final build preserves the exact established installed public authority-bootstrap bytes (SHA256 `516f86bc7e4c36b9f99de264bf3d22e1c2828125e0238bcf2eec7578472801b9`). The isolated engine source has additional detailed evidence in `docs/verification/PACKAGED-CANDIDATE-2026-11-15.md`. No private authority keys were read, exported or rotated.
- The built app predates the registry-only refresh above. Final release requires source/version freeze, refreshed CLI payload and signature, detached manifest signature, staged extraction/install validation, and website publication verification. Existing public 4.5.1 artifacts must not be silently overwritten. The app is not notarized; pinned self-signed release trust is not equivalent to Gatekeeper approval on a new Mac.
- Approximately 3.2 GiB remains free after removing only hash-verified regenerable test payload outputs. No writable external volume is mounted. Full staged extraction of the 4.49 GB app plus release parts cannot safely fit; the full gate has not been bypassed. Conservative working capacity is 8–10 GB free. Existing release and installed application remain untouched.

## Evaluated-signature and genuine-import checkpoint

- Integrated signer hardening in `93bd386`: packaging helper and staged-release gate require successful `codesign -R` evaluation of the exact pinned certificate. Requirement text is diagnostic only. Required pin, strict/deep verification, hardened runtime, bundle identifier and non-ad-hoc requirements remain enforced. No key, signature or app artifact was changed for this read-only verification.
- Independent signer/gate suite: **10/10**, including 11 internal gate checks. Both updated verification paths passed against the actual built candidate (`signer-integrated-real-candidate.json`, `staged-signature-real-candidate.json`).
- Generated the genuine stripped private engine import from engine candidate `494e0b4` using its supported importer, not a raw-source symlink. Preserved generated provenance and pruning metadata. Import/security suites pass **13/13**. This local private tree is excluded from Git staging and has not been published.
- Final aggregate `release-final-post-signature-tests.txt`: **1,496 tests, 1,459 passed, 1 failed, 36 skipped**, 270.8 seconds. The single failure is absent portable Linux/Windows sources, first reported as `platform/linux/kingmaker`; it is not silently skipped or replaced with incompatible old launchers. This does not certify native Linux/Windows installation. No Mac suite failures remain in this run.
- Actual bundled CLI `version` reports 4.5.1, `--help` exits successfully, and deep payload verification checks **2,023 files** with no missing or changed entries (`packaged-cli-integrity.json`). Final artifact refresh/version, release extraction/install proof, Gatekeeper/notarization limits and storage blocker stated above still apply. This is not a published or installed finished release.
