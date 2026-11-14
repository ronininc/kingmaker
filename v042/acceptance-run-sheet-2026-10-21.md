# Kingmaker 0.4.2 — Acceptance Run Sheet

Prepared 2026-10-21 (America/Phoenix afternoon). One pass, in order. A FAIL on any line is the headline — stop and report that line, don't work around it.

## What is already verified (do not re-litigate)

- Corrected 4.2 release-parts run: signed **Kingmaker Release** (no adhoc bypass), whole-archive sha256 `491ffb341a11ed831697e7fafeb27ad7953b5e6b1d3c0d947926aa2fed9d33a7`, manifest signature verifies against the pinned key, fingerprint `A689 DD94 00E8 F7B2 563C 1C88 6B20 BA39 4CA6 68E4 A734 8EF7 05AC 5F48 2AB8 E182`.
- Recovery after the Cloudflare 502 completed 2026-10-21 17:02 UTC: part08, launcher zip, manifest, signature, SHA256SUMS, versioned DMG and unversioned public DMG all uploaded; `latest.json` repointed at archive sha `491ffb34…`; GitHub release assets replaced in place (13 assets). Script tail: "RECOVERY DONE. Corrected 4.2 is live on the update host and GitHub."
- KNOWN MISMATCH: as of 2026-10-21 ~21:00 UTC, the public page at ronininc.org/kingmaker still reads **Version 0.4.0**, ~25 GB free-space requirement, and the fleet-learning "on by default" line. The DMG behind the button was repointed to 4.2, but the page copy was not flipped. Record which path you used (site page vs direct update-host URL) on the run — they are not the same customer experience right now.
- SITE BUTTON (verified 2026-10-21 ~21:05 UTC): both download buttons on the page point to `https://ronininc.org/download/kingmaker?from=kingmaker`.
- NOT A FAILURE: a bare guest GET of `https://kingmaker-updates.robbiebrown2026.workers.dev/latest.json` returns only the text "Unauthorized" — the enrolled update path is keyed, so this probe neither confirms nor refutes the feed an installed Kingmaker sees. DMG content-length/ETag could not be obtained without starting the download, so the byte-size check in Step 1 still happens on the Mac at download time.

## The run

1. **Download fresh** — new browser session / cleared cache, from the site button (customer path). Note the DMG byte size before opening it; it must NOT match the old broken-signing build.
2. **Open the DMG, run the installer.** No terminal, no quarantine-strip, no Open Anyway workaround counts as a pass — if macOS blocks it, that is a FAIL line (notarization gap), record the exact dialog.
3. **Pack screen picks — exactly these:**
   - Profile: **8 GB · LEAN** (not 24 GB · FULL)
   - Library: **STREAM THE LIBRARY LATER**
   - Wake word: **Seeker**
4. **Install completes and Kingmaker launches** from the installed app (menu bar), not from the build tree.
5. **The loop — this is the bar, "it launches" is not:**
   - READ: Kingmaker reads a target it hasn't been handed the answer to.
   - REPLICATE: REA + CLI replicate the target **byte-for-byte** — verify with a hash/diff, not by eye.
   - ASK: it answers improvement questions about the target.
   - IMPROVE: it hands back a finished, improved product.
6. **Receipts to capture for each stage:** installer completion screen, selected profile/library lines, launch version readout showing 0.4.2, replicate hash match output, and the finished product's location. No receipt = stage not proven.

## After a full pass

- Jester Episode 7 un-gates (it was built and is held on this acceptance proving out).
- The site flip to 4.2 copy becomes safe to finish: page version, ~8 GB lean install size, library optional/streamed, and fleet learning described as opt-in.

## After a FAIL

- Name the stage (download / install / picks / launch / read / replicate / ask / improve), the exact error or dialog text, and the receipt. Do not re-sign, re-mirror, or re-upload anything off the back of a failed acceptance without a fresh go.
