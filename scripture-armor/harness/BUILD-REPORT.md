# BUILD REPORT — Scripture Armor as Kingmaker's Native Behavior

**Order:** Robbie Glover — "go code it for real so we can stop saying were done when were not."
**Spec:** `~/workspace/kingmaker-armor-native-build-order-2026-10-25.md` (read first, governed this build)
**Tree:** `~/workspace/kingmaker-armor-native/` — built fresh for this order. Nothing published, pushed, or deployed.
**Base copies (byte-identical at copy time, `diff -rq` = 0 lines):** engine ← `kingmaker-engine-build/src-private/`; armor ← `scripture-armor-refit/` (the current armor, v2's successor); kernel lane ← `kingmaker-engine-build/surface-src/surface/kernel/`. The source trees were not modified — the refit tree still diffs 0 against this build's copy after all runs.

---

## What was built

Three new modules, one patched module, one bridge — 626 lines of new integration code, zero lines of new cryptography. Every cryptographic act is the bundled armor's own (armor.mjs v3 packages; refit-net.mjs Addendum K flows), resolved as the engine's sibling directory — the same relationship the shipped install unit has.

### `engine/lib/armor-native.mjs` — the instrument (new)
The engine's handle on the armor. Loads/creates the engine's armor identity (armor's own `createIdentity`/`loadIdentity`, 0600 store under `state/armor/`), keeps the enrolled-peer address book, and provides:
- `wrapEgress()` — seal a traffic payload to an enrolled peer (armor `sealPlaintext`: X25519-sealed file key, ChaCha20-Poly1305, keyed-commitment frame, per-package permuted glyph body). Every wrap registers its issuance with armor's own `registerIssuances` (issued-log immediately; daemon sync when a vault daemon listens — see Residual 4).
- `openInbound()` — parse + frame-signature verify + recipient check + unseal, refusing anything else.
- Return-match ledger — a response is trusted only when it names the canary of a request this install sent that has not been answered before. Unknown canary → beacon `return-unknown-canary`; second answer → beacon `return-replay`.
- `publishHashWrapped()` — hashes travel inside a sealed package; the visible frame carries only the v3 keyed commitment.
- Provenance + beacon ledgers (`provenance.jsonl`, `beacons.jsonl`, estate-event mirror) — the sensing read surface.
- `wrapSubject()` — the Addendum D guard, below.

### `engine/lib/armor-egress.mjs` — the one governed egress point (new)
Every outbound call is classified before a byte leaves: **local** (loopback — direct, recorded) · **package** (enrolled armor peer — package round-trip, return-matched) · **flow** (enrolled flow peer — Addendum K stream, chain-receipt verified) · **relay** (unenrollable target — sealed to the estate relay, which unwraps estate-side and makes the plain call) · **refused** (native policy, unenrolled — fail-closed, recorded) · **direct-residual** (only under an explicit non-native policy — unwrapped, and the provenance record says `unwrapped: true` in so many words). `gather()` is the sensing surface: it returns the interaction receipt (who answered, which mode, return-match/receipt verdict) as data for the research tools.

### `engine/lib/fleet-transport.mjs` — patched
When the fleet config carries an enrolled armor peer (`fleet.json "armorPeer"` or `KINGMAKER_FLEET_ARMOR_PEER`) and the install has an armor identity, contribute/forget ride inside the wrap: the packet **and the install proof** (which legacy mode exposed as a cleartext header) travel inside the sealed package; the host's receipt returns inside one, return-matched by canary before the existing Ed25519 pinned-key receipt verification runs — unchanged, inside the skin. With no enrolled peer, the legacy path runs exactly as before (proven compatible, Phase C of the proof).

### `surface/kernel/armor-bridge.mjs` — the armor on the kernel lane (new)
Two of the three designed legs, at the depth this host can prove:
- **Witness:** verifies the kernel lane's hash-chained load-event log and mirrors each event into the armor's signed estate-event log (`kernel-load-attested`). A quietly rewritten kernel log fails verification by name.
- **Accounting:** audits observed outbound connects against the armor's egress ledger. A connect with no wrapped-egress record raises beacon `kernel-egress-unaccounted`. `decide()` is the policy seam an LSM program would enforce.
- **Not built:** kernel-level denial (BPF-LSM). See Residual 2 — it is named, not faked.

### Addendum D — held, and proven as a battery case
The armor is Kingmaker's instrument, never its governor. `armor-native` exposes **no** subject-wrap/cell/govern path at all; `wrapSubject()` exists only to refuse by name (`addendum-d-refusal: Kingmaker is never a subject of the armor…`). Phase H of the proof: the armor refuses Kingmaker's own code as a subject, and carries the same bytes without objection as *traffic*. Kingmaker's code in this tree is unwrapped and uncelled, exactly as shipped.

---

## Proof — in this tree's own layout, runs executed by the builder

**Integration proof:** `node proof/run-proof.mjs` (output: `proof/proof-output.txt`)
**Result: 36 passed, 0 failed.** (First run was 34/36 — see Failures below.)

- **Fleet through the wrap (B1–B9):** contribute + forget complete end-to-end through a TCP tap. The signed receipt verifies *through* the wrap. The tap capture — what an observer sees — contains `SCRIPTURE-ARMOR v3` packages and glyph bodies (PUA / Linear A / Cuneiform ranges), and does **not** contain the packet's plaintext marker, the transmitted manifest hash, or the install proof secret. Capture excerpt (fleet leg, client→server):
  `SCRIPTURE-ARMOR v3\n{"v":3,"canary":"537b071b-…","commit":"cacc3cbc…","sender_sign_fp":"8c00d9a7…",…}` followed by the glyph body (full capture: `proof/capture-fleet.c2s`, 2,730 bytes).
- **Legacy control (C1–C2):** the same packet through the same door *without* enrollment still completes — and the control capture **does** show the plaintext marker. The wrap is the difference, demonstrated both directions.
- **Return-match negatives (D1–D3):** a response naming a never-sent canary is refused and beaconed; a second answer to an answered request is refused as replay; both are in the beacon record.
- **Return-hash loop (E1–E4):** a payload round-trips a real socket flow; the peer's signed chain receipt verifies against the sent chain (`head=5f9265a5…`). One flipped byte kills the flow with an AEAD beacon (`flow-aead-failure`). A correctly-signed receipt with the wrong chain head is refused.
- **Relay leg (F1–F4):** a public-API call completes through the estate relay; the API key crossed **inside** the wrap (the stub saw it; the engine↔relay capture contains no key, no prompt, no response plaintext); provenance names the answering relay by its armor fingerprint.
- **Policy + sensing (F5–F7):** native policy refuses an unenrolled target fail-closed and records the refusal; the residual-direct leg works and is named unwrapped in its own record; the sensing ledger is readable back with fleet, relay, and refusal entries naming who answered (transparency of media, as data).
- **Hashes (G1–G3):** a published hash appears nowhere in its package; the visible frame's digest kind is `commit` (keyed commitment — no checkable relation); the enrolled target opens the package and recovers the hash inside.
- **Addendum D (H1–H3):** subject refusal, traffic carriage, no cell/govern surface.
- **Kernel lane (I1–I4):** `prove.sh` ran (verbatim output in `proof-output.txt`); the bridge verified the hash-chained log (1 record) and attested it into the armor estate log; accounting accounts the wrapped fleet connect and beacons a stranger connect (`203.0.113.99`). **The load verdict inside that record is `ok:false` — see Failures/Residuals.**

**Armor batteries (in the copied refit tree):**
- `node test/run-tests-refit.mjs` → **173 passed, 0 failed**
- `node test/run-tests.mjs` (armor core) → **53/53 checks passed**

**Engine side:** the copied engine tree ships no `test/` directory (the staged private tree has none), so there were no in-tree engine suites to run; the touched modules were exercised end-to-end by the proof itself (fleetTransport's real `send`/`forgetRemote`, the sharing seam's `{send, forgetRemote}` shape unchanged), all new/patched files pass `node --check`, and `sharing.mjs` + the patched `fleet-transport.mjs` import cleanly together.

---

## Failures encountered (written in, per orders)

1. **Proof run 1: 34 passed, 2 failed.**
   - *E4 failed* — the harness built a flow receipt without ever delivering the packet, so the honest receipt reported count 0. Harness bug, not armor: fixed by delivering the frame before demanding the receipt; E4 passes on run 2.
   - *F7 failed* — refusal records reached the beacon ledger without a `mode` field, so the sensing readback couldn't see the refusal as a mode. Integration bug, in `armor-egress` (fixed: refusal beacons now carry `mode: 'refused'`).
2. **Kernel load on this host: FAILED, for real.** `prove.sh` exit 2. The probe reports the lane *can* load in principle (CAP_BPF present, BTF present, `observationCanLoad: true`), but the actual `km-load` returned `errno 1 — Operation not permitted` in this container. The failure is recorded in the hash-chained kernel log with `verdict.ok: false` — attested into the armor estate log as a failure, not laundered into a pass. The observation load is therefore **unproven on this host** (it was proven in the RC2 chain on its own host; it is not proven here).

## Named residuals — what is NOT claimed

1. **TypeScript runtime unwired.** The compiled `solomon/server` runtime (where additional provider calls live) is a separate surface and was **not** wired in this build. This build wires the `.mjs` engine layer: fleet transport end-to-end, plus `armor-egress` as the governed egress point the TS runtime must still adopt. Claiming the whole product's egress is wrapped today would be false; the .mjs layer's is, and the rest is this residual.
2. **Kernel enforcement not built.** BPF-LSM denial of unarmored egress remains **designed-only** (the lane's own probe says so verbatim: "nothing in this package blocks, drops, or mediates at the kernel boundary"). The bridge adds witness + accounting + the policy seam. Additionally the observation load itself is unproven on this host (Failure 2). M.5's HARD-cell execution leg and the other refit residuals are untouched and remain open in their own lanes.
3. **Public-API last hop.** On the relay leg, the relay→API hop is ordinary HTTPS and every relay provenance record says so. End-to-end armor to an unenrolled API is impossible by construction; the wrap covers the leg that identifies Kingmaker (engine→estate edge). The catalog of what an observer at the relay's egress sees is unchanged from any proxied call.
4. **Daemon registration leg unexercised.** Wraps register issuances via armor's `registerIssuances`: with no vault daemon run during the proof, the recorded outcome was `{"synced": 0, "queued": 1, "refused": 0}` — the issued-log was written immediately and daemon sync queued, exactly armor's own semantics. A live-daemon sync (and the daemon's owner-approval return path for file packages) was not exercised in this build.
5. **Fleet enrollment is per-door.** Wrapped fleet mode activates only when the front door enrolls (holds an armor identity and accepts package posts). The production `fleet-host/worker.js` must be enrolled before production traffic wraps; until then the legacy path runs (compatibility proven). This is an enrollment step owed on the fleet host, not a code gap here.
6. **Tor/darkweb leg untouched.** `lib/darkweb-search.mjs` rides tor under the egress-guard's tor-only policy; `.onion` counterparties cannot unwrap armor packages and the armor flow transport is enrolled-endpoint TCP. The wrap is not applied to that leg; its governing control remains the egress-guard. Named, not solved.
7. **Ghidra pen test not run here.** Build order §5's break-in attempt against the *shipped archives* belongs to the shipped-unit stage (RC2 chain), not this source-tree build. The break-in attempts run here were protocol-level: bit-flipped flow packets (killed + beaconed), forged chain receipts (refused), forged canary responses (refused + beaconed), cleartext responses to wrapped calls (refused + beaconed).

## Open design point — treated as ordered, not resolved

**Wrapped hashes vs. launcher verification (build order §4) stays open.** This build routes *fleet-side* hash transmission through `publishHashWrapped`. It changes **nothing** about the Ronin Launcher: owner-side install verification on the matching device still works exactly as before, against the local manifest, untouched by the wrap. A wrapped-manifest verification mechanism — owner verifies on the matching device without exposing a checkable relation — is designed nowhere in this tree and awaits Robbie's review before anyone builds it.

## File inventory

- **New:** `engine/lib/armor-native.mjs` (252 lines), `engine/lib/armor-egress.mjs` (255), `surface/kernel/armor-bridge.mjs` (119)
- **Patched:** `engine/lib/fleet-transport.mjs` (armor-native mode added; legacy path unmodified)
- **Proof:** `proof/run-proof.mjs`, `proof/fleet-host.mjs`, `proof/relay.mjs`, `proof/tap.mjs`, `proof/proof-output.txt`, wire captures `proof/capture-{fleet,legacy,relay}.{c2s,s2c}`, proof state under `proof/state-*/`
- **Untouched:** everything else in the tree (armor tree byte-identical to `scripture-armor-refit`; engine tree identical to `src-private` except the one patched file and two added files)

## Proving commands

```sh
node ~/workspace/kingmaker-armor-native/proof/run-proof.mjs        # 36 passed, 0 failed
cd ~/workspace/kingmaker-armor-native/scripture-armor && node test/run-tests-refit.mjs   # 173 passed, 0 failed
cd ~/workspace/kingmaker-armor-native/scripture-armor && node test/run-tests.mjs        # 53/53
sh ~/workspace/kingmaker-armor-native/surface/kernel/prove.sh       # kernel lane (exit 2 on this host — load EPERM, recorded)
```
