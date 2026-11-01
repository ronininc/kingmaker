# FIX REPORT — 4.3 Airlock Repair: responder pinning + peer sender-enrollment

**Order:** Robbie, 2026-10-25 — the airlock repair lands BEFORE the 4.3 publish (fix-first, confirmed 03:12 MST).
**Built in:** `~/workspace/kingmaker-armor-native-airlock-fix/` — a full copy of `~/workspace/kingmaker-armor-native/`. The original tree was NOT edited (the interop battery is running against it); verified after the work: its call sites still contain zero pinning.
**Closes:** daemon-audit gap #2 as reproduced live by the two-endpoint VM proof — findings **N1** (forged response accepted by the engine) and **N3** (guest peer opened a package from an unenrolled sender).

## The hole, in one paragraph

`openInbound` verified a frame's signature against the key embedded in the frame itself — self-asserted identity. The pinning parameter `expectSenderSignFp` existed in `armor-native.mjs` but **no call site passed it**, so any keypair could answer (or knock) as long as it named the right canary — and the canary rides in the cleartext frame header. The repair wires the pin at every call site and makes a pin refusal **beacon before payload handling**.

## The pin-resolution rule

Every expected fingerprint is computed by the new exported helper in `engine/lib/armor-native.mjs`:

```js
export function signFpOfBlock(blockText) {
  const parsed = armor.parsePublicBlock(blockText);
  return armor.fingerprintOfRaw(Buffer.from(parsed.sign_pub, 'base64url'));
}
```

i.e. SHA-256 of the raw Ed25519 public key from a public identity block **held locally** — the same fingerprint computation `flowExchange` already used for flow peers. Each call site's pin source:

| Call site | Pin source |
|---|---|
| `armor-egress.mjs` `packageRoundTrip` (package + relay modes) | The enrolled peer's block — `peerBlockText`, which comes from `peers.json` via `classify()` (the address book the egress itself used to decide the target is enrolled) |
| `fleet-transport.mjs` `wrappedCall` (armor-native fleet path) | `cfg.armorPeer` — the front door's public identity block from the fleet config (`fleet.json` / `KINGMAKER_FLEET_ARMOR_PEER`) |
| `proof/relay.mjs` | `engineBlock` — the engine block the relay is handed at startup (its only enrolled contact) |
| `proof/fleet-host.mjs` (both `/contribute` and `/forget`) | `engineBlock` — same rule |
| `proof/run-proof.mjs` D-section | `hostId.signFp` — the forged-canary probe is wrapped by the enrolled host; pinning to it isolates the return-match layer the section tests |
| `proof/run-proof.mjs` G3 | The engine's block (the host opens what the engine published) |
| `live-fire/run-live-fire.mjs` ext peer | `engineBlock` |
| `two-endpoint/guest-src/peer-server.mjs` (guest peer) | The engine block the guest fetched over the link into `engine-block.txt` — read per request, exactly as it already read it to seal its answers |

**No pin is ever derived from anything inside an arriving frame.** In `openInbound`, the pin check already sat after signature + recipient verification and **before** `unsealFileKey`/decode; it now also writes a beacon (`recordBeacon` → `beacons.jsonl` + estate event + provenance, the armor-native beacon path) before throwing:

```
event: package-unexpected-sender
expected_sign_fp / got_sign_fp / canary recorded
```

This one change makes every pinned refusal beacon on both sides — engine-side forged responses and peer-side stranger packages — with no per-harness beacon code.

## Files touched (9 source files + regenerated bundle artifacts)

1. **`engine/lib/armor-native.mjs`** (+21 lines changed) — added `signFpOfBlock()`; `openInbound` pin-mismatch branch now records the `package-unexpected-sender` beacon before throwing. Nothing else in the module changed.
2. **`engine/lib/armor-egress.mjs`** — `packageRoundTrip` passes `{ expectSenderSignFp: signFpOfBlock(peerBlockText) }` to `openInbound`; import updated.
3. **`engine/lib/fleet-transport.mjs`** — `wrappedCall` passes `{ expectSenderSignFp: signFpOfBlock(cfg.armorPeer) }`; import updated. Legacy (unarmed) path untouched.
4. **`proof/relay.mjs`** — relay opens with the engine pin; import updated.
5. **`proof/fleet-host.mjs`** — both armor opens pinned to the engine; import updated.
6. **`proof/run-proof.mjs`** — the two direct `openInbound` calls pinned to their actual enrolled senders (see table). No checks added or removed.
7. **`live-fire/run-live-fire.mjs`** — ext-peer open pinned to the engine.
8. **`two-endpoint/guest-src/peer-server.mjs`** — package listener pins to the engine block's fingerprint; refusals now also report `unexpected_sender_beacons` (count of `package-unexpected-sender` beacons in the peer's own beacon record) in `evidence.json` so the host can verify "refused **+ beaconed**" from guest-side evidence. Copied to `two-endpoint/guest-bundle/peer-server.mjs`.
9. **`two-endpoint/run-two-endpoint.mjs`** (host driver) — N1 and N3 converted from recorded *findings* to asserted *checks* (refusal + beacon); N2/N2b expectations updated for pin-first refusal (below).
- **Regenerated artifacts:** `two-endpoint/guest-bundle/engine/lib/armor-native.mjs` synced from the fixed engine module; `two-endpoint/share/bundle.tar.gz` (and the `staging/` copy) rebuilt from `guest-bundle/` in the original layout.

**Not touched, deliberately:** `interop/` (a diagnostic battery that names these very limits; out of the task's scope), the flow leg (Addendum K already pins: `openFlow` is constructed with the enrolled peer's sign fingerprint and receipts verify against it — VM checks F1/F2 re-prove it), cartography, the resolver, beacon homing, vault code — all 4.4, per orders.

## Proof — integration battery (host, in the copy)

Command: `node proof/run-proof.mjs`
**Result: 36 passed, 0 failed** — the same count as before the fix, now with the fleet leg (B1–B9), the relay leg (F1–F4), the return-match negatives (D1–D3), and the hash-publication open (G3) all exercising pinned opens. Legitimate traffic stayed green everywhere; the pin is a pin, not a wall. (The kernel lane's BPF load still returns its attested `ok:false` in this container — pre-existing, written into I1–I3 exactly as before.)

## Proof — two-endpoint VM harness (in the copy)

Topology identical to the original run: QEMU 8.2 (TCG, no /dev/kvm) booting Alpine, guest peer + rogue under slirp NAT with host-forwarded loopback ports, tap captures, guest bundle delivered over the 9p share. Driver: `two-endpoint/drive-vm.py`; host battery: `node two-endpoint/run-two-endpoint.mjs run`. Full results in `two-endpoint/results.json`, console in `drive-vm.log`.

**Result: 20 passed, 0 failed; findings: 0.** All 16 original proof checks stay green (setup, P1–P5 package round trip byte-for-byte both directions, F1–F2 flow + return-hash loop, N2, N2b, N3b, W1–W5 wire hygiene — payload hash `f9169164…` matched host/guest/evidence exactly as in the pre-fix run). The two findings flipped to asserted checks:

- **N1 — forged response REFUSED + beaconed.** The rogue (unenrolled guest keypair, real canary read from the cleartext frame) now dies at the engine's responder pin:
  `armor-native: package from unexpected sender b7b96f71… — refused` (rogue fp `b7b96f714e8d37f6baecc0b377c4f0ce816bcf77c22db314f0289f92e66ec900`). Engine beacon record, verbatim:
  ```json
  {"kind":"beacon","event":"package-unexpected-sender","expected_sign_fp":"8c3e5abdde8b847e22c9024cb3c08d12df0eeb536868a5b1ab23cbf0ce77c042","got_sign_fp":"b7b96f714e8d37f6baecc0b377c4f0ce816bcf77c22db314f0289f92e66ec900","canary":"e05ead51-9cb5-4adc-8ec0-b7d72be1e7b2","detail":"package signed by an identity other than the pinned enrolled sender — refused before payload handling"}
  ```
  (Check N1b asserts the beacon names the rogue fingerprint.)
- **N3 — unenrolled-sender package REFUSED + beaconed at the peer.** `http=400`, guest `packages_opened 1→1` (unchanged) while `packages_refused 0→1`, the rogue host's fingerprint never enters `senders_seen`, and the peer's own beacon count reported through guest evidence: `beacons=1`, last refusal `armor-native: package from unexpected sender f8a10515… — refused`. Guest-side evidence at poweroff independently shows `packages_refused: 2` (the stranger package + the N3b misaddressed control).

**One expectation change, stated plainly:** N2 (rogue response naming a never-sent canary) is still refused, but the refusal now happens **at the sender pin, before return-match is reached** — a rogue-signed response is dead at the door whatever canary it names. The driver asserts the pin refusal + its beacon. Return-match itself is unchanged and still refuses unknown canaries from the *genuine* peer — that layer is covered by the integration battery's D1 case, which passes.

## What did not pass / residual notes

- Nothing in either battery failed.
- The fix covers every `openInbound` call site in the tree outside `interop/` (surveyed by grep; interop's opens are diagnostic probes of the pre-fix legs and were left as-is by scope — if/when the interop battery is re-run against the fixed tree, its §11e-v text, which documents this exact gap as a named limit, will need its expectation updated the same way the driver's was).
- Pin granularity is per enrolled block (one expected signer per call). A future door that legitimately serves many enrolled senders would pin against its enrolled set; no such call site exists in this tree today — the fleet door harness serves the one engine it was handed, and the production door pattern follows the same enrollment model.
- This copy diverges from the original tree by exactly the 9 files above plus the regenerated guest bundle. Merge path: take the 9 files (and rebuild the guest bundle) — no GitHub operations were performed.

---

# WIDENING — expiry enforcement + replay protection

**Decision:** Robbie, 2026-10-25 10:07 MST — "Widen the repair — expiry + replay cache too."
**Closes:** the two remaining genuine failures from the interop battery (`~/workspace/kingmaker-armor-native/INTEROP-REPORT.md` §3/§5): **11e-iv** — the relay leg **served expired packages** (`openInbound` never checked `frame.expiry`); **11a-i** — the relay held **no replay cache**, so a captured request re-sent verbatim was **re-executed** against the target API. Built in the same fix copy; the original tree was again not edited (verified after the work: zero `claimServed`/`package-expired` matches in its `armor-native.mjs`, `proof/relay.mjs`, or `peer-server.mjs`). Deliberately NOT widened further: error-oracle uniformity, beacon homing, streaming — 4.4.

## 1. Expiry enforcement — in `openInbound`, so every leg gets it

One change in `engine/lib/armor-native.mjs`, inside `openInbound`, after signature + recipient + sender-pin verification and **before** `unsealFileKey`/decode (i.e., before any payload handling):

```js
if (frame.expiry && Date.parse(frame.expiry) < Date.now()) {
  recordBeacon(state, { event: 'package-expired', canary, expiry, sender_sign_fp, … });
  throw new Error(`armor-native: package expired ${frame.expiry} — refused`);
}
```

- **Semantics mirrored from vaultd** (`scripture-armor-refit/vaultd.mjs` L1112/L1423): the frame's own stamped `expiry` (an ISO timestamp or `null`) is compared against `Date.now()`; an unstamped frame carries no expiry to break and is unaffected. No new time source was invented. Because the check lives in `openInbound`, it lands on **every leg that opens inbound packages or responses** with no per-leg code: `armor-egress.mjs` `packageRoundTrip` (package + relay response paths), the relay opener (`proof/relay.mjs`), `fleet-transport.mjs` `wrappedCall`, the fleet host, the guest peer — and any future caller.
- **Beacon:** new event class **`package-expired`** via the same `recordBeacon` path the pinning fix used (canary, stamped expiry, sender fingerprint recorded), written before the throw.
- Ordinary traffic is untouched: `sealPlaintext` stamps `expiry: null` unless an expiry is explicitly requested, so engine/relay/fleet wraps carry no expiry and cannot false-fire (the 36/36 integration battery below exercises exactly those paths).

## 2. Replay protection — `claimServed` + the served ledger

New export in `engine/lib/armor-native.mjs`: **`claimServed(state, frame)`**. A serving door calls it after `openInbound` succeeds and **before** it acts on the payload. It records the request's canary in the **served ledger**; a canary already in the ledger is a verbatim re-send: the claim beacons (**`package-replay`**, canary + sender fingerprint) and throws, so the door refuses **before execution** — a replayed non-idempotent action never runs a second time. (The engine side already had its half: `matchReturn` refuses a duplicate *answer*. This is the serving side's half: refusing a duplicate *request*.)

**Ledger design:**
- **Storage:** `served-ledger.jsonl` in the armor state dir (`armorDir(state)`), beside `sent-ledger.jsonl`/`beacons.jsonl`, written 0600 with the same whole-file rewrite discipline `matchReturn` uses. **File-backed on every leg** — the protection survives restarts of the serving process (proven by the restart probe below; no leg got an in-memory-only cache).
- **Bounds (expiry-aware):** each entry is `{ canary, sender_sign_fp, until, served_at }` where `until` is the frame's own stamped expiry, or `served_at + 24 h` for unstamped frames. Every claim prunes entries whose `until` has passed before checking/appending. An entry never outlives its usefulness: once a frame's expiry passes, `openInbound`'s expiry check refuses that frame anyway, so the ledger entry has nothing left to guard.
- **Claim point:** the canary is claimed **on acceptance, before execution** — an in-flight duplicate is refused too, not just a post-completion one.

**Per-leg enforcement points (expiry via `openInbound` everywhere; replay via `claimServed` at):**

| Leg | Expiry | Replay claim point |
|---|---|---|
| `armor-egress` `packageRoundTrip` (response open) | `openInbound` | n/a — responses are governed by `matchReturn` (already refuses `return-replay`) |
| `fleet-transport` `wrappedCall` (response open) | `openInbound` | n/a — same, `matchReturn` |
| `proof/relay.mjs` (relay opener) | `openInbound` | after open, before `fetchImpl` — a replay never reaches the API |
| `proof/fleet-host.mjs` `/contribute` + `/forget` (armor branches) | `openInbound` | after open, before the packet is counted/acted on |
| `two-endpoint/guest-src/peer-server.mjs` (guest peer) | `openInbound` | after open, before the envelope is processed/answered; refusals also surface `expired_beacons`/`replay_beacons` counts in `evidence.json` (mirroring the pinning fix's `unexpected_sender_beacons`) |
| `live-fire` ext peer | `openInbound` | proof harness for the relay pattern, superseded by the relay leg above; it opens engine requests to *observe*, it does not execute them against an API |

Guest artifacts synced exactly as the pinning fix did: `guest-src/peer-server.mjs` → `guest-bundle/peer-server.mjs`, fixed `armor-native.mjs` → `guest-bundle/engine/lib/armor-native.mjs`, `share/bundle.tar.gz` + `staging/` copy rebuilt from `guest-bundle/`.

**Files touched by the widening (6 source files + 2 new proof scripts + regenerated bundle artifacts):**
1. `engine/lib/armor-native.mjs` — expiry branch in `openInbound` (+beacon); `claimServed` + served-ledger section.
2. `proof/relay.mjs` — import + claim after open.
3. `proof/fleet-host.mjs` — import + claim in both armor branches.
4. `two-endpoint/guest-src/peer-server.mjs` — import + claim after open; `expired_beacons`/`replay_beacons` in evidence.
5. `two-endpoint/guest-bundle/peer-server.mjs` + `guest-bundle/engine/lib/armor-native.mjs` — synced copies.
6. `two-endpoint/share/bundle.tar.gz` + `two-endpoint/staging/bundle.tar.gz` — rebuilt.
7. NEW `interop/run-interop-widening.mjs` — the widening battery (below).
8. NEW `interop/probe-served-ledger-restart.mjs` — the restart-persistence probe (below).

## Proof — integration battery (host, in the copy)

Command: `node proof/run-proof.mjs`
**Result: 36 passed, 0 failed** — unchanged with both widenings wired in. The fleet leg (B1/B3) now exercises `claimServed` at the fleet host; the relay leg (F1–F4) exercises it at the relay; each battery request is a fresh wrap with a fresh canary, and nothing false-fired.

## Proof — widening battery (new, in the copy)

Command: `node interop/run-interop-widening.mjs` — the interop §11 transit cases re-run against the FIXED code with flipped expectations. Fully local and deterministic (the relay's target is the proof API stub; the relay fetch is instrumented — the same "relay API calls" measure the original battery used). Guest-peer cases run the actual guest bundle host-side. Evidence: `interop/results-widening.json`.

**Result: 11 passed, 0 failed.**

- **W1** fresh legitimate request serves: HTTP 200, API calls +1, answer return-matches.
- **W2** second DISTINCT request (fresh canary) serves: 200, +1, matches — the ledger does not false-fire.
- **W3** replayed request **refused at the relay before execution**: HTTP 400, **API calls +0**, `package-replay` beacon for the canary. (Original behavior: API calls +2, recorded as a named limit.) Body: `relay error: armor-native: package canary already served — replay refused (83675…`.
- **W4** expired package **refused at the relay**: HTTP 400, **API calls +0**, `package-expired` beacon. (Original 11e-iv: opened and performed the call.)
- **W5** never-enrolled sender still refused at the pin: 400, +0, `package-unexpected-sender` beacon (the pinning fix, unregressed).
- **W6** bit-flipped packet still killed at the relay: 400, +0.
- **W7** frame-strip still useless both ways: body-only 400, frame-only 400, +0.
- **W8a–d** at the guest peer (bundle code): fresh package opens (opened=1, ack opens engine-side pinned); **verbatim replay refused** — 400, opened stays 1, `replay_beacons=1`, refusal `armor-native: package canary already served — replay refused`; **expired package refused** — 400, opened stays 1, `expired_beacons=1`, refusal `armor-native: package expired 2026-10-25T16:11:17.101Z — refused`; a second DISTINCT package then opens (opened=2) — no false refusal.

**Restart probe** — command: `node interop/probe-served-ledger-restart.mjs`. Serves one request through a relay instance, closes it, starts a **new relay instance on the same state dir**, re-sends the identical packet:
`PASS — first=200, after-restart replay=400, totalApiCalls=1`, ledger file on disk (0600) containing the served canary with `until = served_at + 24 h` (the unstamped-frame fallback). The replay cache is not an in-memory courtesy; it is a state file like every other armor record.

## What did not pass / residual notes

- Nothing in any battery failed: integration 36/36, widening 11/11, restart probe PASS.
- The widening battery is a NEW script; the original `interop/run-interop.mjs` was left byte-identical (in both trees) as the pre-fix record. If it is ever re-run against the fixed tree, cases 11a-i, 11e-iv and 11e-v will now FAIL *as written* — they assert the pre-fix behavior (re-execution +2, expired served, stranger served). That is the expected signature of the repair, the same expectation-flip the pinning fix made in the two-endpoint driver; the widening battery is the post-fix statement of those cases.
- The two-endpoint VM harness was not re-run for the widening (its asserted checks are the pinning set, 20/20 above; the guest peer's new expiry/replay behavior is proven host-side in W8 against the identical bundle code that the VM runs, and the rebuilt `bundle.tar.gz` carries it for the next VM run).
- Claim-before-execution means a request whose execution then *fails downstream* (e.g. the target API errors) still consumes its canary — a retry must be a fresh wrap, not a verbatim re-send. That is the conservative direction for a replay guard and matches how the armor already treats canaries (one issuance, one service); stated here so it is a known property, not a surprise.
- Merge path updates accordingly: the merge set is now the pinning fix's 9 files **plus** the widening deltas above (`proof/fleet-host.mjs` and `guest-src/peer-server.mjs` overlap both rounds; `interop/run-interop-widening.mjs` + `interop/probe-served-ledger-restart.mjs` are new proof scripts that travel with the tree).
