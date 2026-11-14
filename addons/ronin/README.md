# The Ronin add-on

Kingmaker's paid Ronin Launcher add-on. The free, source-available Kingmaker runs without it; with it on the Mac,
`lib/addons.mjs` loads `index.mjs` and Kingmaker gains:

| What | Where | Docs |
|---|---|---|
| Pairing this Mac with Ronin CRM (`kingmaker pair`, `kingmaker://pair`) | `ronin-pairing.mjs` | `docs/ronin-pairing.md` |
| The Ronin desk and the Build Room brains' desks, docked to the CRM (`kingmaker office ronin …`) | `ronin-desk-dock.mjs`, `brain-desks.mjs`, `office.mjs` | |
| The Muse office and the agent offices (`kingmaker office muse …`) | `muse-office.mjs`, `agent-offices.mjs` | |
| Delegated approvals with Kingmaker's CRM seats (`:approvals on|off|status`, "stop approving") | `approvals.mjs` | |
| The inbound DM bridge (`:dms on|off|status`, "stop forwarding") | `dms.mjs` | |
| CRM jobs and CRM skills | `crm-jobs.mjs`, `crm-skills.mjs` | |
| Owner calls (`kingmaker owner-call …`) | `owner-call.mjs` | `docs/OWNER-CALL.md` |
| The unanswered-text watch: when a watched client's text (Brent first) waits an hour with no reply, Kingmaker flags the CRM once (ronininc-crm #346 shape, never the text) and the CRM calls the owner; it never contacts the client (`kingmaker text-watch …`) | `text-watch.mjs` | |
| One Kingmaker, one company's CRM (`kingmaker crm-lock …`), its engine settings and key classes | `crm-lock.mjs` | `docs/crm-tenant-lock.md` |
| The Ronin CRM's do-not-call list for the iPhone bridge | `ronin-pairing.mjs` (`DNC_URL`) | |
| The Ronin office's own app profile | `app-profile.mjs` | |

## How it reaches a customer's Mac

The Ronin office is a paid add-on in Kingmaker's add-on format (`ronin.addon/1`, id `ronin-office`, sku
`addon.ronin-office`), the same path as meeting notes (`addons/meeting-notes/`). Kingmaker.app never carries it.

1. **Package** (operator): `node addons/build-addon.mjs ronin` zips what the add-on runs (not `test/`, `docs/`,
   `scripts/`, this README or `addon.json`) and writes `dist/addon/ronin-office/manifest.json` (every file's size and
   SHA-256, the archive's, `entry: { module: "index.mjs", export: "register" }`), unsigned.
2. **Sign** (operator, offline): sign `manifest.json` with the Kingmaker Release key, exactly as for meeting notes and
   `kingmaker-manifest.json`. Upload the zip behind the update host's entitlement gate.
3. **Install** (Ronin Launcher): on a Mac that holds a licence for `addon.ronin-office`, fetch, check, and hand the folder
   to `kingmaker addons install`, the licence on stdin. Kingmaker checks everything again and places it in its data folder.
4. **Load** (Kingmaker, at start): `loadAddons` checks it again and calls `register(host)`. The add-on binds the core
   modules it was handed (`host.services.lib`, `core.mjs`; it never imports core by path) and exposes itself to the core
   as `ronin` (`host.expose`). Nothing installed, or anything refused: the free edition.

In an owner's checkout, `addons/<id>/addon.json` lets it load straight from source (no licence check: it is the source).

The core reaches it only through `lib/addons.mjs` (a test holds that line). `KINGMAKER_ADDONS=off` runs a checkout
with add-ons as the free edition. `npm test` runs `addons/*/test/` too. The public export
(`scripts/public-export.mjs`) never carries `addons/`.
