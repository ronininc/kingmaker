# Operating Kingmaker (private repo only)

What only the operator does: building a release from TSS, importing Solomon's source, and the owner's own Ronin offices.
None of this is in the public export (`scripts/public-export.mjs` leaves this file, `solomon/` and the TSS tooling out).

## Building a release

Nothing here publishes anything; publishing is the operator's call.

```bash
# 1. The app, in TSS (≈4 GB, needs ~8 GB free while it builds):
cd ~/Projects/TSS && SOL_GHOST_SOURCE=~/Projects/sol-ghost npm run package:ghost        # → desktop/dist-ghost/Kingmaker.app
# 2. The release parts + manifest, in this repo (pins Ollama, Homebrew and the models from their own published digests):
node scripts/release-parts.mjs --app ~/Projects/TSS/desktop/dist-ghost/Kingmaker.app     # → dist/release/<tag>/
node scripts/release-parts.mjs --app … --dry-run                                         # every hash, no part written
# 3. The installer around that manifest, in a DMG:
scripts/build-installer.sh --manifest dist/release/<tag>/kingmaker-manifest.json        # → dist/Kingmaker-Installer-<tag>.dmg
# 4. (operator) gh release create <tag> --repo ronininc/Kingmaker --draft <parts> kingmaker-manifest.json SHA256SUMS <dmg>
```

- **Signing and notarization:** `KINGMAKER_SIGN_IDENTITY="Developer ID Application: …"` signs the installer (hardened runtime) and its DMG; with `KINGMAKER_NOTARY_PROFILE` (a `xcrun notarytool store-credentials` profile) the DMG is submitted, waited on and stapled. `release-parts.mjs --notarize` does the same for Kingmaker.app before it is archived, and refuses unless the app carries a Developer ID signature. Without those, both scripts say plainly the build is not notarized.
- **Dry-run an install** into a throwaway folder, nothing outside it touched (the shared tools are only checked): `installer/engine.sh --wake-word Kingmaker --prefix /tmp/km --source dist/release/<tag> --manifest dist/release/<tag>/kingmaker-manifest.json`.
- `swift scripts/make-icons.swift .` rebuilds the icons and the menu bar logo from `assets/ronin-inc-crest.png` (the Ronin Inc crest from ronininc.com).

## Solomon without his clothes

Kingmaker carries Solomon itself. `solomon/` is the TSS source tree with the UI stripped: the React app, the Electron window shell and the test suites that need them. It's made by one repeatable command:

```bash
node scripts/import-solomon.mjs --from ~/Projects/TSS --ref origin/main
```

- **Repeatable strip.** The script copies TSS at that commit (tracked files only, no history), removes what `solomon-strip.json` lists, and records the commit in `solomon/IMPORTED_FROM.json`. It fails if anything kept still imports a stripped path. Re-run it whenever TSS moves; Kingmaker keeps every engine fix and never drifts by hand edits.
- **No Solomon.app needed for the engines.** With `solomon/` present, Kingmaker runs Solomon's server straight from source on this Mac's Node ≥22 ("fork" mode). It uses the headless launcher's own environment and bootstrap code, on Kingmaker's own data folder.
- **Native runtimes the source doesn't build** (voice binaries and models, guardrails, the knowledge venv) still come from an installed Solomon.app's Resources, or from `SOL_GHOST_RESOURCES`. `SOL_GHOST_RUNTIME=app` forces the old mode.
- **Current import:** TSS `7759826` (`main`, 2026-10-09, the merge of #413), which carries #345/#347/#349 (opening closed apps, "open my Chrome.", the ghost-os 2.2.1 tree parser that makes clicks bind), everything through #406: the Hands of Horus (Peekaboo) under Solomon's governance (#382), acting on an app wherever it is open (#394), no CRM preloaded and "connect my CRM at …" for any CRM (#402, #403), WhatsApp by voice (#377) and the headless owner console (#378), and now all of #407–#413: the `DEV_NONCOMMERCIAL` edition (#407), the read-only CRM team status (#409: "CRM status", "where's everyone at"), the delegated approvals with Kingmaker's CRM seats (#410), the inbound DM bridge (#411), and the guardrail fix that stops long spoken requests being held as "encoded" and checks a CRM dock turn on the operator's question only (#413).
- **Nothing unmerged is imported.** Re-import from TSS `main` (`node scripts/import-solomon.mjs --ref origin/main`) for later changes. Team status reads the CRM's Seeker MCP (`/mcp/seeker`) when a Seeker token is in the vault; until the CRM's Seeker dock is deployed, Kingmaker says the CRM has no `team_status` yet.
- **One CRM key:** `:key ronin-crm` takes the CRM's Kingmaker master key (`ronin_admin_`, Connections → issue the Kingmaker master key) as well as a Solomon token (`ronin_solomon_`). With the master key there, every seat with no token of its own (approver, Seeker, local) uses it, on its own path of the same CRM; a seat's own token, if you added one, still wins. A Solomon token covers the CRM only. **Once ronininc-crm #346 is deployed, this one key covers everything:** the CRM and the approval tools on `/mcp/solomon`, the Seeker dock (`/mcp/seeker`), the local heartbeat (`/mcp/capital`), and the Kingmaker desk (`/mcp/desk`), which the text watch uses. On a CRM older than #346, the master key works everywhere except approvals. Kingmaker says that once and stops approving; add `:key ronin-approver` until the deploy.
- **Delegated approvals (Ronin CRM owners only; off by default):** with a Kingmaker approver token in the vault (the master key in `:key ronin-crm` once ronininc-crm #346 is deployed, or its own `:key ronin-approver`) **and** `:approvals on` typed at this console, Kingmaker approves, every few minutes, only what the CRM delegates inside the owner's server-enforced caps. A configured Seeker token (`:key ronin-seeker`) docks its read-only office answer loop by default, polls every 5 seconds as its heartbeat, re-docks after a lost lease, and undocks on stop or fatal error. Questions it cannot ground still fall back to the CRM's cloud answer. Every CRM pairing has its own local token and runtime profile; Ronin's seat does not authorize Orosolu and vice versa.
- **Inbound DM bridge (off by default):** with your CRM connected (`:key ronin-crm`) and `:dms on` typed at this console, every new inbound iMessage, SMS, WhatsApp and Instagram DM the comms watchers see is forwarded to the CRM once, tagged `prospect` (an unknown number or handle, or someone the CRM already knows) or `likely_personal` (saved in your Contacts, unknown to the CRM). It uses the CRM's `inbound_message` tool when it has one, otherwise `capture_contact` plus a note. Restarts never forward a DM twice, and failures retry with backoff, then alert once. It never sends a reply: acknowledgement drafts wait for "send the acks". "Stop forwarding" or "pause forwarding" (said or typed), or `:dms off`, pauses it at once, and it stays paused until `:dms on`. "Brief me" or "what came in" tells you the new DMs by channel. To forward business only, set `SOLOMON_DM_FORWARD_SCOPE: 'business'` in `lib/profile.mjs`. On the Mac it needs Full Disk Access (Messages' chat.db), Contacts access (for the tag), WhatsApp Web and Instagram signed in to Solomon's portal browser, and the comms autopilot armed. Not run live yet.
- **Unanswered-text watch (Ronin add-on; off by default; needs ronininc-crm #346 deployed):** `kingmaker text-watch on` watches Brent, whose CRM contact is `ct_brent_agencyhub`. Add others with `kingmaker text-watch add <name> [number or email] [--contact-id <CRM id>]`. Brent's number comes from Contacts if you don't give one. When one of their iMessages or texts has waited an hour (`kingmaker text-watch after <minutes>`) with no reply from you on any device, Kingmaker flags the CRM once with `{ from_name, contact_id, received_at, channel }`. The flag never includes the text or a preview, and the call never says it. The CRM then calls you, or sends an urgent push if owner calls are off, and says the text is waiting. Kingmaker sends the flag with `request_owner_call` on `/mcp/desk` using the Kingmaker desk key. If that fails it uses the REST route `/api/kingmaker/owner-alert/unanswered-text`. With no desk key, the engine sends it with your `:key ronin-crm` key (the master key) through `owner_alert_unanswered_text` on `/mcp/solomon`. You get one call per unanswered text, and a retry after a crash is the same alert, because the CRM dedupes on the contact and the time. It never contacts the person who texted. It reads Messages read-only, so it needs Full Disk Access.
- **CRM task judge (background, free):** with your CRM connected, every 15 minutes (`SOLOMON_TASK_JUDGE_INTERVAL_MS`, 60 s to 6 h) Kingmaker leases the CRM's `task_checks`, asks its local decide() model whether each task is still current, and answers `task_check_answer` with the probability and its confidence. A confident doubt goes to the owner's 10am queue on the CRM side; it never changes a task, sends anything or costs anything, and it is skipped while you are talking (the model load is held). Needs no console switch. Same rule as the DM bridge: inert until a CRM is connected. Not run live yet.
- **Measured in fork mode** (scratch data, voice off): ready in 12.7 s, 446 MB across its 3 processes. The extra over app mode is TypeScript compiled on the fly; a one-time build step can remove it.
- **Proven live in fork mode:** ghost-os live (21 Mac tools), rules enforced, "press Seven in Calculator" proposed as YELLOW, `n` cancelled.
- **Not re-tested since the 2026-10-09 import:** an approved click with another app in front came back REFUSED (the drift guard wanted the target frontmost). The Hands of Horus now act on an app in place (#382), but this has not been re-run live in fork mode; retest it on a Mac.

## Fork-mode notes from the imports

- **"open my Chrome." failed live.** Two causes, both fixed. The "Ghost" prefix wasn't stripped (fixed here). The real app directory scores "my Chrome." 0.63, below its 0.75 bar. That one is fixed in TSS `18bf05127` (real-folder case M10a3: 22/23 → 23/23), which the standalone app built by `package:ghost` carries.
- **Clicks not binding / opening a closed app (ghost-os).** Fixed in TSS (#349 tree parser, #345 opening closed apps); both are in the imported `solomon/` (fork mode). An installed Kingmaker.app has them only once it is rebuilt from current TSS. Not yet re-tested live on a Mac after the 2026-10-09 import.
- **CRM and hands wiring in fork mode.** Before the 2026-10-09 import, `solomon/` predated the engine that reads `SOLOMON_CRM_DEFAULT` and `SOLOMON_MAC_HANDS=peekaboo`, so a checkout fell back to the Ronin CRM and to ghost-os. The imported engine reads both (`test/engine-wiring.test.mjs` pins it). Still to check live on a Mac: "open my CRM" with nothing connected gives the offer to connect one; "connect my CRM at …" with the CRM's Solomon token; the Hands of Horus permissions and a governed click.
- **Engine test noted at this import:** TSS's own `conversation-terminal-feed` suite fails (its stub does not export `lastQuestionKey`, added by TSS#406). A test-only issue, to be fixed in TSS, not here.

## Putting the Ronin add-on on the owner's Mac (after Kingmaker 0.2.8)

The free app carries no Ronin code, so an updated Mac loses pairing, desks, approvals, the DM bridge and owner calls until the paid add-on (`addons/ronin`, sku `addon.ronin-office`) is installed. Run from a checkout of the installed version, after the Mac is on it:

```
node scripts/owner-install-ronin-addon.mjs --dry-run --sign-key <offline-release-private.pem>   # build, sign, mint, check; touches nothing installed
node scripts/owner-install-ronin-addon.mjs --sign-key <offline-release-private.pem>            # the same, then install into /Applications/Kingmaker.app
```

It builds the add-on (`addons/build-addon.mjs`), signs `manifest.json` with the offline release key (RSA-PSS), mints this Mac's entitlement with `scripts/mint-entitlement.mjs` (ES256, Ronin's install-certificate key from `~/.solomon-secure/ronin-install-cert/`), and installs with the installed app's own `kingmaker addons install` (the entitlement on stdin). Both signatures are checked against the pinned public keys before anything is installed, and again by the engine. Re-run it any time. Mint an entitlement alone: `node scripts/mint-entitlement.mjs --sku addon.ronin-office --this-mac --out ent.json`. Revoke at the update host with the KV marker `revoked:install:<installId>` (or `revoked:ent:<order or installId:sku>`).

## The owner's Ronin offices

| Command | What it does |
|---|---|
| `kingmaker office ronin enable\|disable\|status\|check` | Enables the Ronin desk only for this local Kingmaker profile, checks its authenticated lease, or disables it. An enabled profile auto-heartbeats while Kingmaker runs and handles only bounded status/pause/resume/disable-host commands. The token is read from Keychain service `ronin-crm-prod`, account `KINGMAKER_DESK_TOKEN`; it is never printed or accepted on argv. |
| `kingmaker office muse init\|status\|ask "<message>"` | Muse, Mr. Social: Robbie Glover's one-shot, local-only Ronin Inc office. Kingmaker writes Ronin's canonical inbox shape and reads its canonical outbox shape. Muse has private namespaced memory, may only read `~/workspace`, uses a loopback local model with immediate unload, and has no money, outreach, publishing, credential, billing, or TCPA authority. |

### Muse local office

`kingmaker office muse init` creates exactly one local Ronin office at `<Kingmaker state>/offices/ronininc/muse/`: `identity.md`, `permissions.json`, `lifecycle.json`, a private persistent `memory/`, and file-based `inbox/` and `outbox/`. Inbox files use Ronin's existing desk shape `{ id, asker_name, question, context, created_at, type }`; outbox files use its answer shape `{ ask_id, answer }`.

`kingmaker office muse ask "…"` is a one-shot route through Kingmaker. It writes the inbox file, marks lifecycle `working` with one worker, verifies the configured model is already installed, cold-loads that local Ollama model, writes and reads the outbox reply, requests immediate model unload (`keep_alive=0`), returns lifecycle to `idle` with zero workers, and exits with no Muse daemon. Concurrency is hard-bounded to one on this 8 GB host. It accepts only a loopback Ollama endpoint and makes no cloud call. `KINGMAKER_MUSE_MODEL` may select another already-installed local model; it never triggers a download or paid service.

Muse's workspace reader is path-confined and read-only under `~/workspace`, refuses absolute paths and symlink escapes, and exposes no general filesystem or mutation tool. Its code has no credential, billing, publish-state, outreach, money, or TCPA mutation path. Orosolu is deliberately absent from this office.
