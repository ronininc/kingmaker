# WORKLOG

Channel between the Claude seat (text, catalog, inventory) and the Codex seat (lib/, harnesses, installer, engine plumbing). Append only. Never rewrite another seat's entry.

## 2026-11-24 — Claude seat — K1 README cascade draft (DRAFT, awaiting owner approval)

- Branch `kingmaker-joint`, cut from `main` at b44cea4. This seat is running in a cloud container (Linux), not on the Mac; there was no WORKLOG.md, so this file starts here.
- Changed: `README.md`, section "The system, in its own terms", four passages: **Kingmaker**, **The Core Loop**, **The Fleet**, **Pipelines and Daemons**.
- Removed: "not an autonomous agent… no skill is acquired and no skill is used unless a person requested it."
- Now says: harness for local brains with extra abilities; each program works by itself, united by the launcher they work together; one owner command is the activation and the cascade follows; fleet-level autonomy traced to that activation; skills absorbed during each task a daemon handles without the owner; learning at every level; autonomy stops at installation, the human's act.
- Left alone on purpose, for the owner to rule: the Seeker passage ("money, outbound messages, connector writes and every proposal wait for the owner's word") and the approval wording lower in the README. The doctrine as issued did not revoke those gates.
- Public face: no launcher or union marketing added; the launcher is named once, as a fact.
- Proof: `grep -c "not an autonomous agent" README.md` returns 0; `git diff main -- README.md` shows 4 lines changed.

## 2026-11-24 — Claude seat — K8 version drift + public-face proposal (PROPOSAL, nothing applied)

- File: `docs/proposals/K8-version-and-public-face.md`.
- Headline: the published release is **4.5.2** (GitHub latest release, tag `v4.5.2` = 4a453cc), and `main` is 38 commits behind it. `docs/CURRENT-VERSION.md` and `AGENTS.md` on `main` still say 4.4.4.
- Codex seat, for your side: build scripts already take the version from `package.json` (`scripts/build-app.sh:12`, `scripts/build-installer.sh:33`). The proposal keeps that as the one source. Merging `candidate/kingmaker-4.5.2` into `main` touches your files; I did not do it.
- Not verified from this seat: the Mac dev shell plist reading 4.5.3 (no Mac attached). The command to check it is in the proposal.
- Also flagged: README says "notarized" and "downloads the models"; the 4.5.2 release notes say not notarized and inventory-only.

## 2026-11-24 — Claude seat — K6 tools wiring inventory

- Files: `docs/inventory/K6-tools-wiring.md` (the readable inventory) and `docs/inventory/K6-tools-wiring.json` (every one of the 1,561 file paths with its skill and state).
- Headline: **0 WIRED.** 13 of 13 platform entries NOT WIRED; 106 of 106 skills NOT WIRED. Each row carries its reason.
- Tools index: 5 staged, 8 declared-not-staged (matches the brief). Staged ones can be pulled but are never registered: `toolDescriptor()` has no caller, `tools/list` returns the frozen list, and no production caller passes `addConnector`.
- Skills: the loader lists all 106 and marks all 106 callable (ran it: `106 106`). They are skill connectors with name and purpose but no parameter schema, so not tool-call registrations. `dagster-expert` loads with an empty description. 63 nested SKILL.md files in 5 folders are never listed.
- Codex seat, these are in your files and I did not touch them: (1) `lib/k-office.mjs` and `light-runtime/ask.mjs` say their tools are registered in `lib/mcp.mjs`; `lib/mcp.mjs` imports neither. (2) `lib/bench-cli.mjs:233` and `lib/tool-streaming.mjs:107` create the provider without `addConnector`. (3) `skillMeta` in `lib/core-pack.mjs` misses multi-line YAML descriptions.
- Not covered: the engine's own brain manifest (`brain-tools.ts`); its source is not in this repo.
- Proof commands are at the bottom of the inventory; all three were run on this branch.

## 2026-11-24 — Claude seat — K7-prep sovereignty removal branch (PREPARED ONLY, DO NOT MERGE)

- Branch `k7-prep/remove-scripture-armor` (from `main`, commit 8806b3e): `git rm -r scripture-armor`, 236 files, nothing else.
- Headline: **Kingmaker does not start on that branch.** `lib/cli.mjs` and seven other modules fail with `ERR_MODULE_NOT_FOUND scripture-armor/armor.mjs`; all eight load on `main`.
- Codex seat: the importers are yours — `lib/install-docking-runtime.mjs`, `lib/launcher-crm-identity-client.mjs`, `lib/armor-native.mjs`, `lib/armor-egress.mjs`, `surface/kernel/armor-bridge.mjs`, `light-runtime/artifact.mjs`, `light-runtime/voice-artifact.mjs`, plus `lib/payload.mjs:19` (ships four subtree files) and four tests. I edited none of them.
- Report and the three options for the owner: `docs/proposals/K7-sovereignty-removal.md`.

## 2026-11-24 — Claude seat — K4 model catalog refresh: BLOCKED, nothing measured

- Headline: **no measurement was taken and no catalog number or label was changed.** This seat is a cloud Linux container; the 8 GB Mac was not reachable (no machine attached; the Ollama registry is also blocked from here).
- Delivered instead: `docs/proposals/K4-model-catalog-remeasure.md` — the runbook for the Mac using the existing `catalog/bench/bench_models.py` and `eval_models.py`, and the proposed label rule.
- Codex seat: the "8GB+" label and the missing Qwen 3.5 / Gemma 4 entries live in `lib/models.mjs` (`MODEL_CATALOG`, `minGb`, line 61), which is yours. `catalog/HARDWARE_OUTCOMES.md` already recorded on 2026-10-09 that 8B models and `qwen3:4b` are mislabelled; that was never carried into `lib/models.mjs`.
- Open: run the runbook on the Mac and hand back the two `.jsonl` files.

## 2026-11-24 — Claude seat — K4 update: partial measurement on the 8 GB Mac

- The owner ran the bench on the 8 GB Mac (`hw.memsize` 8589934592, Mac15,3, Ollama 0.34.4) and pasted the rows. Three models measured: qwen3-abliterated 0.6b and 1.7b, qwen2.5-coder-abliterate 1.5b. All three: 0 MB swap growth, resident and score identical to 2026-10-09, speed 2–3 times higher (cause not measured).
- Recorded in `catalog/HARDWARE_OUTCOMES.md`, new section "Re-measured 2026-11-23". Raw `.jsonl` files are on the Mac under `catalog/bench/`, to be committed there.
- Still unmeasured, blocked by disk (1.7 GB free): the installed 8B and 7B models, `qwen3:4b`, `granite-code:3b`, all of Qwen 3.5 and Gemma 4. No entries added, no labels changed.
- Codex seat: nothing new for `lib/models.mjs` yet. The 8B "8GB+" correction still rests on the 2026-10-09 record until the 8B run happens.
