# Kingmaker v0.4.2 — BUILD ORDER

**Robbie's order, 2026-10-20 19:55 MST:** ship 4.2 with LittleBrother and the rest of the Kingmaker set. Nothing executes until Robbie is in front of his laptop. This document is the whole job; every other 4.2 action waits.

## What's in 4.2 (all built and verified — this is assembly + ship, not new builds)

1. **LittleBrother** — installed in-stack 2026-10-20 (`kingmaker-stack/littlebrother/`, 13/13 green against the installed copy). Ships in the payload as `lib/stack-littlebrother` via `kingmaker-v041/kingmaker-stack-drop-v2.zip`.
2. **Harness²** — governed reconstruction folded in alongside LB (`kingmaker-stack/harness2/`, 11/11 green). Same drop zip, lands as `lib/stack-harness2`.
3. **The 4.2 fold-in set** — `kingmaker-v042/kingmaker-v042-foldin.zip` (verify-42: 8/8 suites, 145/145): scrapling adapter, obscura contract, blender-mcp contract, whatsapp-mcp gate, angelslim job, freemocap external, triage records (MiMo/Hy-MT2 DO NOT USE). Lands as `lib/stack-<name>` entries like the rest.
4. **Updated STACK.md** (22/22 suites, 377/377 checks) — inside drop v2.

**Explicitly NOT in 4.2 unless Robbie says so at the laptop:** slash-command buckets (specced 2026-10-20, a build, not a fold), King's Keep (doctrine only), notarization (separate track), Obscura Tor profile (its buff is still owed — the contract ships, no onion browsing does).

## Phase 0 — Unblock the ground (before any assembly; from the 2026-10-20 findings)

The 4.1 ship proved the release can be perfect and still uninstallable: the R2 mirror went to a lookalike bucket and every install 404'd. 4.2 does not repeat that.

1. **Identify the update worker's Cloudflare account.** Probe: `wrangler --profile <each> kv namespace list` — the account holding KV `DEVICES` id `e08bbab74ec941059f6b6570d8795232` is the worker's account. If no profile sees it, `wrangler login` a new profile against the dashboard account. Record the winning profile name here: ______
2. **Read the worker bucket's root `latest.json`** and write its schema into this order before touching it. Never guess its fields.
3. **Confirm the site download target.** ronininc.org/kingmaker's button served a 0.3.0 installer while the page said 0.4.0 — find what it actually points at (repo page source or an unversioned `public/` object) so Phase 4 flips the real target.

## Phase 1 — Assemble the 4.2 tree (Mac, sol-ghost checkout)

4. Land drop v2 at the app root; verify `lib/stack-littlebrother/` and `lib/stack-harness2/` exist with their `lib/*.mjs` inside.
5. Land the fold-in set as `lib/stack-scrapling`, `lib/stack-obscura`, `lib/stack-blender-mcp`, `lib/stack-whatsapp-mcp`, `lib/stack-angelslim`, `lib/stack-freemocap` (+ triage records where the fold-in puts them).
6. **Smoke-import on the Mac tree:** node import checks for `stack-littlebrother/lib/littlebrother.mjs` (construct both modes; solomon object must lack the full methods) and `stack-harness2/lib/harness2-governed.mjs` (construct an improver). Import-resolution failures get fixed here, with evidence — not discovered by a customer.
7. Version bump 0.4.1 → 0.4.2 everywhere the tree stamps it (installer tag, engine TAG, manifest source).
8. Re-run censuses if the tree changed (stack census + stack42 census); both verify suites already green on the VM (377/377 + 145/145) — the Mac tree is what must match them.

## Phase 2 — Build + sign (Robbie's tap at the sign step)

9. release-parts run → parts + manifest for v0.4.2.
10. **Sign the manifest** with the release key. His fresh per-event word; the key never leaves the Mac; path-only in chat; NO keygen, ever.
11. Build the installer DMG (enroll env lifted as in the 4.1 build).
12. Byte-verify: parts vs manifest sizes/sha256, signature vs the pinned fingerprint `A689 DD94 00E8 F7B2 563C 1C88 6B20 BA39 4CA6 68E4 A734 8EF7 05AC 5F48 2AB8 E182`.

## Phase 3 — Publish

13. GitHub release **v0.4.2** on ronininc/kingmaker: parts, DMG, manifest, signature, launcher zip, SHA256SUMS. Release notes drafted by Muse and **shown to Robbie in full before publish** (public-content gate). Notes state what 4.2 adds (installed component count only for the private-side tooling — never named).
14. **R2 mirror into the WORKER'S bucket** (the Phase 0 profile, `--remote` on every put): `v0.4.2/` objects + `public/` DMG. Verify with a remote listing showing remote location + sizes.
15. Write the bucket-root `latest.json` for 4.2 in the schema read at step 2.
16. **Worker probe before "shipped" is said:** a fresh enrolled fetch of `v0.4.2/SHA256SUMS` + part01 range request against the live update host must return 200/206. This step exists because 4.1 skipped it.

## Phase 4 — Site + acceptance

17. **Site flip to 0.4.2** — blocked until Robbie grants the GitHub App **Contents: write** on `ronininc/ronininc-site` (pending since 2026-10-18). Flip: version strings ×2, requirements → lean wording (~10 GB, library streams/downloads post-install by choice), fleet-learning line corrected to opt-in, download target → the 4.2 DMG (per step 3). Verify the button actually serves the 4.2 DMG.
18. **From-site acceptance on the 8 GB M3** (Robbie's V4 condition): download from the site → install with NO deletions of his files, 8 GB LEAN pack + Stream the library → launch → Kingmaker drives the read→replicate→ask→improve loop end to end. "It launches" is not the bar. This also clears Jester Episode 7's second gate.
19. **Discord announcement** (4.2 version of the verified 4.1 draft; shown to Robbie before posting; links must match the flipped site).
20. Sweep the ~2.3 GB of wrangler local-state junk left by the bad 4.1 mirror run.
21. Log the release in the goal tracker + memory; the 4.1 ship record gets a pointer here (4.2 supersedes 4.1 as the installable release).

## Standing rules pinned to this order

- Signing and any key operation: Robbie's fresh word, per event. Never run keygen for the release key.
- Purge/delete commands NEVER include `~/.solomon-secure/`.
- Nothing public (release notes, site, announcement) posts without Robbie reading it first.
- Release-key USB backup confirmation is still owed — one known copy is a release risk; raise it at the laptop session.
- Muse's desk guardrails unchanged (no approve/send/submit_trade/move_money/change_settings); usage cap 70%.
