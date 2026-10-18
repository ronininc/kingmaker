# Community learning

Owner, 2026-10-15:
- "That's why it's source available in the first place, so that it can be used to train [Kingmaker] with community data, and also it needs to be able to learn, period."
- "give it the permissions box in Kingmaker colors matching the custom or default settings."
- On the design: "go with option B and build the permissions box."

## The decision: on by default, with a real choice (option B)

Every Kingmaker learns on its own Mac (`lib/learning.mjs`, on by default). **Sharing** what it learned with the community is a separate switch, decided in the permissions box:

- **Share is the default.** In the box, "Share and get improvements" is highlighted, and Return chooses it.
- **Nothing leaves a Mac until the box has been shown,** whatever the setting.
- **"Keep it on this Mac" stops sharing at once.** That Mac keeps working and keeps learning locally. It just gets no community improvements, which is the reciprocity the collective already enforces.
- **In the bar at any time:**
  - "sharing on" and "sharing off" switch it.
  - "what have you shared" shows the last packets, exactly as sent.
  - "forget what I shared" asks the collective to erase this Mac's contributions.
- **"learning off" stops sharing too,** because nothing new is learned, so nothing new is shared.

This replaces the 2026-10-07 terms, which said collective learning was "a condition of the licence … not a setting". `TERMS.md` now says it is on by default and can be turned off. Counsel should still read `TERMS.md` before the public release (not legal advice).

## What is shared, and what never is

The engine's fleet-learning core builds a **closed packet**. Every field is one of:
- an enum,
- a bounded number,
- a random install id,
- a day,
- a version,
- a coarse device class (`darwin-arm64-24gb`),
- or a word from a public vocabulary that ships with the code.

The build fails if any packet field could carry free text. An allowlist sanitizer scrubs personal data and secrets, applies k-anonymity (two or more requests per word), clips counts, and logs exactly what was sent to `fleet-learning/contributed.jsonl`.

The packet carries these artifacts:

| Artifact | What it carries |
|---|---|
| `route_stats` | counts of public task words per route |
| `skill_package` | procedure skeletons, with slots instead of values |
| `device_eval` | pass rates and latency |
| `model_trial` | model family, size, speed, pass rate (never the local model's name) |
| `preference_stats` (new) | counts of how owners like work done, from a fixed list (shorter/longer, bullets/prose, price first, …), never the owner's words |

Never shared: what anyone said, typed, saw or stored. That includes transcripts, files, screens, contacts, keys, names, addresses, business records, host names and model names.

## The permissions box

It appears once, in the bar, the first time this Mac has something to share. Afterwards it is a row in the gear's **Connectors & keys → Access on this Mac**, "Share what Kingmaker learns", beside the macOS permissions (one settings surface, no duplicate).

It matches the bar, because it reads the same settings:

| Setting | Default | In the box |
|---|---|---|
| Look (`km.look`): Black / Dark glass / Match the Mac | Black | the card's background |
| Kingmaker's replies (`km.replyColor`): Green / White / Blue / Amber | Green | the title, the default button's fill, the link and the focus ring |
| Text size (`km.textSize`): 13 / 14 / 16 | 14 | body text; the title is 2 points larger |

> **Help every Kingmaker get smarter**
> Kingmaker learns how to do things better on this Mac. With your OK, it shares what it learned, never what you said or stored, so every Kingmaker improves, including yours.
> **Shared:** counts of common task words, how well models and skills worked, and your Mac's type (for example "M5, 24 GB"). **Never shared:** your words, files, screen, contacts, keys, names or business records.
> [See exactly what's sent]  [Keep it on this Mac]  [**Share and get improvements**]

- Return chooses the highlighted default, and Esc means "Keep it on this Mac": declining is never harder than accepting.
- It never steals focus while the owner types, and never appears during a recording (the ad's stage mode).
- The choice is kept locally with its date and the wording version (`sharing.json`).

## How it moves

1. **On the Mac, once a day,** when sharing is on and the box has been shown: build the packet, sanitize it, validate it, log it, then send it.
2. **The `kingmaker-fleet` Worker** (Cloudflare, beside `update-host`):
   - `POST /contribute` validates the packet, rate-limits per install, stores it and returns a signed receipt.
   - A scheduled job runs the aggregator and signs per-install bundles.
   - `GET /bundle` returns the bundle, for contributors only.
   - `POST /forget` erases this install's contributions.
3. **Back on the Mac:** each Mac verifies a bundle (pinned key, addressed to it, fresh), trials it on its own records, and adopts it only if it helps there. Nothing from the collective can change governance, approvals, keys or code.

Federated LoRA, meaning on-device fine-tuning with differential privacy, is a later lane and needs its own approval.

## Fixes made alongside

- `crm-export.json` no longer carries the Mac's host name. The learning line no longer claims "shared with the CRM agents", because nothing sends that file (a CRM export stays owner-only).
- A stale "off until learning on" comment in `lib/cli.mjs` was corrected.
- The product name in `TERMS.md` is Kingmaker throughout.

## Built (2026-10-15), and what's left before it's live

| Piece | Where | State |
|---|---|---|
| The switch, the box request, the bar words, the local log | `lib/sharing.mjs` (+ `test/sharing.test.mjs`) | built, tested |
| The permissions box and its Access row, in the bar's colours | `app/Kingmaker.swift` | built, typechecks; needs an install to be seen |
| `preference_stats` (kept preferences → closed kinds) | the engine's fleet-learning core (`packet.ts`, `sanitizer.ts`) | built: sanitizer 34/34, guard 7/7, e2e 52/52 |
| The engine's packet code on the Mac | `vendor/fleet/fleet-packet.mjs`, generated by `scripts/build-fleet-vendor.sh` | built |
| The daily packet, built and sent | `lib/cli.mjs` (once a day, never before the box, never with sharing off) | built |
| The Mac's side of the connection (install proof, pinned-key receipts, erasure) | `lib/fleet-transport.mjs` | built, tested |
| The collective's front door | `fleet-host/worker.js` (Cloudflare Worker `kingmaker-fleet`; + `test/fleet-host.test.mjs`) | built, tested in memory, dry-run builds (21 KB); **not deployed** |

**Until the Worker is deployed and configured, nothing leaves any Mac.** The daily packet is logged locally as "not sent: no community server yet", and "what have you shared" shows it.

**To go live (the owner's go):**
1. Create the store:
   ```bash
   wrangler r2 bucket create kingmaker-fleet
   ```
   ```bash
   wrangler kv namespace create FLEET
   ```
   Put the namespace id in `fleet-host/wrangler.jsonc`.
2. Make the signing key, once and kept offline:
   ```bash
   node scripts/fleet-keygen.mjs <dir outside the repo>
   ```
   The public key goes into `FLEET_PUBLIC_KEY`. Load the private key as a secret:
   ```bash
   wrangler secret put FLEET_SIGNING_KEY
   ```
3. Deploy, from `fleet-host`:
   ```bash
   wrangler deploy
   ```
4. Ship `fleet.json` (`{url, publicKeyPem}`) with Kingmaker. Its presence is what turns sending on; the public key in it is pinned.
5. Aggregation runs on Ronin's side over `packets/`, using the engine's stand-in (quorum, trimmed FedAvg, validation). Its signed bundles go to `bundles/<install>.json`, and each Mac fetches its own. The scheduled aggregation job and the Mac's bundle fetch-and-trial are the next slice.
