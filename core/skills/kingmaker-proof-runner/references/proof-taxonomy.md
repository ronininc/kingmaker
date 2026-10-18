# Kingmaker's checks, by area

Where each part of Kingmaker is checked: the test files under `test/` (run one with
`node --test test/<name>.test.mjs`) and the live check on a Mac with Kingmaker.app installed. The source of truth is
always `ls test/` and the tests themselves: if a file here is missing or renamed, read the folder again before running.

The engine ships compiled inside Kingmaker.app. Its own internal tests are not in this repository, so what
Kingmaker can show about it is what crosses the line between the two: what Kingmaker sends, what comes back, and
what the owner sees and hears.

## The whole suite

| Check | What it tells you |
|---|---|
| `node --test test/*.test.mjs` (`npm test`) | Every Kingmaker test. Quote pass, fail and skipped; name each skip. |
| `kingmaker doctor` | Every piece this Mac needs (hands, Ollama, whisper, microphone tool, wake word, voice authority, Chrome connector, ArtCraft apps, memory), each ✓ or ✗ with its fix. |
| `kingmaker status` | Runtime up or down, its process tree's memory, how many proposals are waiting. |
| `kingmaker version` | The version that is actually running. Compare it with `package.json`. |

## By area

| Area | Tests | Live check |
|---|---|---|
| Voice loop (wake, sleep, push to talk, what reaches the transcript line, text only on small Macs) | `voice-authority`, `push-to-talk`, `transcript-line`, `text-only`, `lang` | `kingmaker doctor` voice rows; `kingmaker speak`; a spoken turn after `kingmaker start` |
| Verified owner voice | `owner-voice` (skips without the engine's owner-voice modules) | `kingmaker enroll`, `kingmaker voice verified`, then "yes, go ahead" in your own voice |
| Voice and permissions reported to the runtime's self-check | `self-check`, `permissions` | `kingmaker doctor` |
| Who can do what, approvals, the kill switch | `voice-authority`, `approvals`, `dms`, `flow`, `unit` | `kingmaker status` "this shell=…"; `kingmaker say` can only propose |
| Hands (driving the Mac's apps) | `hands`, `menu-click`, `macos-minimum` | `kingmaker doctor` hands row and its permission report |
| Brains and routing (local model, cloud CLIs) | `lanes`, `agent-lanes`, `claude-brain`, `fast-route`, `instructions`, `calibration` | `kingmaker brain`; `kingmaker models` |
| Web research sources and evidence windows | `browse`, `artifacts`, `knowledge`, `knowledge-vectors`, `rrf` | a research question at the console; only verified sources open |
| Connectors and the REA gate | `rea`, `connectors`, `core-pack`, `extensions`, `absorb`, `skill-create` | the Connectors page verdicts |
| Keys and vault | `keys`, `vault-key` | `:key <provider>` at the console (side-effectful: it stores a key) |
| Device scan and tools | `device-scan` | `kingmaker scan`, `kingmaker tools` |
| ArtCraft, ads, office | `artcraft`, `ad-video`, `office`, `muse-office`, `agent-offices` | `kingmaker craft status` |
| Markets (research only) | `trading-agents` | `kingmaker markets status` |
| Phone and calls | `phone`, `phone-voice`, `phone-ring`, `ring`, `phone-companion`, `phone-companion-argv`, `owner-call`, `iphone-bridge` | `kingmaker phone`, `kingmaker iphone status` |
| CRM link and pairing | `crm-lock`, `crm-jobs`, `crm-skills`, `ronin-pairing`, `ronin-desk-dock`, `follow-up` | `kingmaker crm-lock status`, `kingmaker pair --status` |
| Learning and sharing | `learning`, `sharing`, `fleet-host`, `memory-retire`, `next-suggest`, `brain-library` | the permissions box; `fleet/contributed.jsonl` in the data folder logs every packet as sent |
| Install, update, integrity | `installer`, `installer-look`, `ronin-installer`, `update`, `update-consent`, `integrity`, `first-run`, `install-config`, `aliases` | `kingmaker version`; the one-time "modified copy" notice |
| Data folders and background mode | `kingmaker-home`, `background-runtime`, `runtime-respawn`, `idle-gaps`, `metrics-history`, `bridge-metrics`, `mac-profiles` | `kingmaker background status` |

## Tests that skip on purpose

- `engine-wiring`: needs the engine's source imported beside this checkout, which the public repository does not have. Skipped here.
- `owner-voice`: some tests need the engine's owner-voice modules from an installed runtime. Skipped without them.
- A test may skip when a tool it drives is absent (for example `ffmpeg` for `ad-video`). Read the reason it prints.

A skip is reported as `SKIP (<reason>)`. It never counts toward a pass.

## The live proofs

| Command | Needs | From the public repository |
|---|---|---|
| `npm run proof:owner-voice` | The engine's source beside this checkout, and the app's voice runtime | exits 2 (SKIP): report `UNVERIFIED` |
| `npm run proof:owner-keys` | The engine's source with its headless owner console | exits 2 (SKIP): report `UNVERIFIED` |

Exit 0 means every check held, 1 means one failed, 2 means it could not run.

## Commands that act (not checks)

Never run these as part of "running the tests". Each needs the owner's explicit yes: `kingmaker update`,
`kingmaker installer install`, `kingmaker craft install`, `kingmaker markets install`, `kingmaker background
enable|disable`, `kingmaker enroll`, `kingmaker siri`, `kingmaker chrome`, `kingmaker pair`, the `scripts/build-*.sh`
builds, and any git commit, push or pull request.
