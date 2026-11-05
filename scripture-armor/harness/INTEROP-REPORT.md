# INTEROP REPORT — Scripture Armor vs the internet as it actually works

**Order:** Robbie Glover, 2026-10-25 — *"verify that that works with the way that the internet currently functions because the issue that I'm worried about is basically that our shield will stop us from interacting with other services and it shouldn't"* — plus the 03:10 addendum: covered packets must not be blocked *for being covered*, and there must be **no attack surface in transit**.

**Run:** `interop/run-interop.mjs` (this tree), built directly on the live-fire harness — same `createArmorEgress` relay mode, same proof relay with its default real fetch (instrumented to count/time only), same tap discipline. Raw evidence: `interop/results.json`, `interop/run-output.txt`, wire captures `interop/capture-interop-relay.{c2s,s2c}`. **Battery: 27 passed, 3 failed, 7 observations.** The three FAIL lines are reported as-is below — read §5 before quoting the count: one is the battery's own over-strict assertion (substance verified working in the same check), two are genuine doctrine failures on the relay leg.

---

## Verdict — the three questions

**1. Can Kingmaker, behind the shield, still interact with other services the way the internet works today? YES — with named limits.** Redirects (multi-hop, cross-path), PUT/DELETE/HEAD, query strings with unicode/reserved characters/1500-char values, binary downloads (byte-for-byte hash match), gzip content, a real structured JSON API (GitHub, the project's own repo, full 84-key JSON, rate-limit headers visible), and Robbie's own Cloudflare-fronted production site (both pages, body hashes identical to direct fetches) all completed through the wrap, return-matched by canary, with the discrimination control in the same run refusing unenrolled direct attempts closed and beaconed. The shield does not strangle ordinary service interaction. What does **not** work on this leg today is named in §4: true streaming/SSE (buffered-only; never-closing streams die at the egress timeout), client-visible redirect chains, and websockets (no such path exists on this leg at all).

**2. Are covered packets deliverable — not blocked for being covered? YES, everywhere tested.** The actual site-test canary package POSTed raw to httpbin arrived byte-intact (hash-identical). At the Cloudflare edge (ronininc.org), a covered body and a plain body received **identical treatment** — same 405 from the static app, cf-ray on both, no bot challenge, no block page, no reset. A ~1.5 MB payload's covered form (5,281,830 bytes of glyph package, ~3.5× expansion) POSTed raw arrived byte-intact. A burst of 12 covered packets in rapid succession drew twelve 200s — the pattern itself triggered nothing.

**3. Is the in-transit attack surface zero? NO — it is named, and it is smaller than the doctrine's enemies list but larger than zero.** What a transit attacker gets is: **nothing from the traffic itself** (bit-flips die at frame-signature/AEAD before any processing, frame/body separation is useless both ways, replayed answers are refused by the closed loop and beaconed, captured answers are sealed to the engine and unopenable by anyone else). What they get **at the relay's HTTP surface, if they can actively POST variants to it**, is a failure-class oracle: four distinguishable refusal messages plus a served/refused timing split (§3, case 11e). And two genuine doctrine failures on this leg: the relay **serves expired packages** (its opener never checks `frame.expiry`) and **serves packages from never-enrolled senders** (no sender authentication — anyone holding the relay's *public* block can drive it to fetch URLs). Both are the daemon audit's known gaps, confirmed operationally here; the fix build's sender/responder pinning and an expiry check in the opener close them. The relay also holds **no replay cache** — a replayed request is re-executed against the API; the loop's defense is that the duplicate *answer* is refused engine-side and the answers are worthless to the capturer.

---

## 1. Service-interaction battery (all through the wrap, relay leg, canary return-matched)

| Case | Result | Evidence |
|---|---|---|
| 1a Redirect chain `absolute-redirect/2` | **FAIL (assertion) / substance works** — see below | status 200, return_match=true, final body is the `/get` echo |
| 1b `redirect-to` 302 → other path | PASS | status 200, final body correct |
| 2a PUT (JSON body) | PASS | echoed method=PUT, JSON intact |
| 2b DELETE | PASS | echoed method=DELETE, status 200 |
| 2c HEAD | PASS | status 200, body_len=0, headers present (content-type, content-length, …) |
| 3 Query: unicode `名前は値です`, reserved `a=b&c=d?e`, spaces/`+`, 1500-char value | PASS | all four echoed exactly |
| 4 Binary PNG download | PASS | wrapped sha `541a1ef5…` = origin sha `541a1ef5…`, 8,090 bytes |
| 5 Gzip endpoint | PASS | JSON parses, `gzipped:true`; body delivered **decoded** |
| 6 GitHub `api.github.com/repos/ronininc/kingmaker` | PASS | status 200, full JSON (84 keys), `full_name` correct |
| 6b Rate-limit headers engine-side | PASS | `x-ratelimit-limit=60, remaining=48` visible through the envelope |
| 7 GET `ronininc.org/` through the wrap | PASS | sha `94a5b56a…` = direct sha, 29,051 bytes, `server: cloudflare` |
| 7 GET `ronininc.org/kingmaker` through the wrap | PASS | sha `7a51842b…` = direct sha, 34,930 bytes |
| 8a Chunked `/stream/3` | PASS | 3/3 chunks delivered, all valid JSON lines, 150 ms |
| 8b Drip (4 s stream) | PASS (buffered) | 12/12 bytes, engine-side elapsed 5,178 ms — **nothing arrives until the stream closes** |
| 9 Discrimination control (same run) | PASS | unenrolled direct attempt at httpbin under native policy, no relay → refused, `egress-refused-unenrolled` beacon written |

**On 1a's FAIL line:** the check asserted the echoed final URL would read `https://httpbin.org/get`; httpbin echoes it as `http://httpbin.org/get` (its own view behind its proxy). The redirect chain itself completed through the wrap — status 200, the final body is the target's response, return-matched. The FAIL is the battery's string, not the armor's traversal; it is left as a FAIL in the tally because that is what the check printed, with the substance stated here.

**Behavioral notes the table compresses:**
- **Redirects are followed on the relay's last hop and are invisible to the engine.** Provenance carries the final status only; the intermediate hops, their statuses, and the `Location` chain are nowhere in the record. Fine for fetching; a flow where the *client* must act on an intermediate hop (OAuth-style browser dances) cannot be driven through this leg as-is.
- **Gzip:** the engine-visible headers are the origin's wire headers verbatim (`content-encoding: gzip`) while the body inside the envelope is already decoded (the relay's fetch decompresses). A caller that trusts the header and decompresses again would corrupt its own read — an interface honesty note, not a transport failure.
- **Binary:** byte fidelity is real at the envelope layer (`doc.body_b64` decodes to the origin bytes, hash-proven). Note the engine-facing response object of `egress.fetch` exposes `text()`/`json()` only — byte-grade consumers use the envelope layer (the same wrap/open/match primitives `armor-egress` composes). Recorded as an interface observation in the run.
- **GitHub from the relay's egress IP** is unauthenticated and shared: 60 req/hr budget, 48 remaining after this run's calls. That budget is the relay host's internet reputation, not something the wrap controls — services that rate-limit or bot-score the *relay's* address will answer the relay accordingly. Both GitHub and Cloudflare served it without complaint in this run.

## 2. Covered-form deliverability (Worry 1 — blocked *for being covered*?)

| Case | Result | Evidence |
|---|---|---|
| 10a Site-test canary package, raw POST → httpbin | PASS | status 200, echoed sha `fd9c590f…` = sent sha, 4,614 bytes, no challenge |
| 10b Covered vs plain POST → `ronininc.org/` (Cloudflare edge) | PASS — identical treatment | both 405 (static app's normal answer to POST), cf-ray present on both, no challenge markers in either body |
| 10c-i ~1.5 MB payload through the relay leg | PASS | echo sha `047d42f6…` = sent sha |
| 10c-ii Its covered form (5,281,830 bytes) raw POST | PASS | status 200, echoed sha = covered-form sha — no size/entropy block |
| 10c-iii Burst, 12 small covered packets, rapid | PASS | statuses: 200 ×12 |

The covered form is, to every intermediary tested, just bytes with an unusual content-type. Nobody along these paths inspected, challenged, or refused it.

## 3. In-transit attack battery (Worry 2 — surface between departure and arrival)

| Case | Result | Evidence |
|---|---|---|
| 11a-i Replayed **request** → relay | PASS (behavior recorded) | relay performed the API call **twice** for one genuine + one replayed packet — the relay holds no replay cache |
| 11a-ii Replayed **answer** → engine | PASS | first answer matched; second refused `return-replay`, beacon written |
| 11a-iii Captured answer in attacker hands | PASS | stranger identity cannot open it: "package not addressed to this engine" |
| 11b-i Bit-flip (one glyph) in transit → relay | PASS | relay HTTP 400, **zero** API calls made for it; frame signature covers the body, so the flip dies at signature check before AEAD is even reached |
| 11b-ii Bit-flipped **response** in transit (tamper proxy) → engine | PASS | call throws ("frame signature invalid"); tampered content never delivered as data |
| 11c-i Glyph body without frame | PASS | 400 "missing SCRIPTURE-ARMOR v1/v2/v3 header" |
| 11c-ii Frame without body | PASS | 400 "frame signature invalid" |
| 11d Reorder (flow mode) | NOT EXERCISED here | flow is the separate TCP leg, not this battery's surface; reorder/chain resistance on flow was proven in the armor-native integration proof (chain receipt verified; wrong chain head refused; `flow-aead-failure` beacon). Not re-run in this battery — stated, not implied |
| 11e-iv **Expired** package → relay | **FAIL — genuine** | relay **opened it and performed the call** (API count +1). `vaultd.mjs` enforces expiry (L1112/L1423); `armor-native.openInbound` — this leg's opener — never checks `frame.expiry` |
| 11e-v Package from a **never-enrolled sender** → relay | **FAIL — genuine** | relay opened it and performed the call (API count +1). The frame signature is verified against the key embedded in the frame itself; the recipient check passes; `expectSenderSignFp` exists in the opener and **no call site passes it** (daemon audit). Anyone holding the relay's public block can drive it |
| 11e-vi Response naming an **unknown canary** → engine | PASS | refused `return-unknown-canary`, beacon written |

**The error oracle, enumerated exactly** (case 11e — what an *active* attacker who can POST variants to the relay endpoint and read its replies learns; 8 variants → 5 distinguishable signals):

| Variant sent | Relay's answer | Time |
|---|---|---|
| Plain garbage | 400 `relay error: missing SCRIPTURE-ARMOR v1/v2/v3 header` | 3 ms |
| Glyph body, no frame | 400 `relay error: missing SCRIPTURE-ARMOR v1/v2/v3 header` | 5 ms |
| Bad frame signature | 400 `relay error: armor-native: frame signature invalid — package refused` | 2 ms |
| Bit-flipped body | 400 `relay error: armor-native: frame signature invalid — package refused` | 7 ms |
| Frame, no body | 400 `relay error: armor-native: frame signature invalid — package refused` | 3 ms |
| Wrong recipient | 400 `relay error: armor-native: package not addressed to this engine — refused` | 2 ms |
| Expired frame | **200 — served** (sealed answer) | 241 ms |
| Unenrolled sender | **200 — served** (sealed answer) | 248 ms |

So refusals are **not uniform**: the failure class is named in cleartext in the relay's 400 body, and served-vs-refused is also a ~240 ms vs ~5 ms timing split. Two qualifications, stated plainly: (a) this oracle is available to someone who can *submit* packets to the relay endpoint and read its HTTP replies — a purely passive observer of the sealed leg learns nothing from the traffic (it is packages; the same is not true of the relay's reply link if that link itself is observable in cleartext, as the loopback HTTP pattern here is); (b) nothing the oracle reveals opens a package — it classifies failures, it does not decrypt. It is still a surface the doctrine says should not exist, and it is named here as one.

**Beacon gap on transit kills:** neither the relay (request-side kills) nor the engine (armor-shaped tampered responses) writes a beacon for the bit-flip class on this HTTP leg — the kill happens, silently, as a thrown error / a 400. Flow mode beacons this class (`flow-aead-failure`, integration proof); the package/relay leg does not yet. Fix-build material.

**Cross-reference, confirmed on this run's own wire** (daemon audit, not hidden): the frame travels as cleartext JSON and **the canary is visible in it** (this run's capture: frame fields `v, canary, created, expiry, commit, sender_sign_fp, sender_sign_pub, recipient_seal_fp, armor_seed, eph_pub, key_nonce, key_ct, file_nonce, scan_verdict, scan_digest, scan_report, scan_override, armor_tier, sig`). Return-match on the generic leg trusts that canary. That is precisely why 11e-v matters: visibility of the canary plus absent sender pinning is the in-transit surface the fix build closes.

## 4. Named limits — what kind of service interaction still breaks

1. **Streaming / SSE / anything long-lived.** The relay buffers a response to completion before sealing; the engine receives nothing incrementally. A drip completes (buffered) in this battery, but a stream that never closes — real SSE feeds, live dashboards, log tails — dies at the egress timeout (20 s default in `armor-egress`). Websockets have no path on this leg at all.
2. **Client-driven redirect flows.** Redirects are followed silently on the last hop; flows requiring the client to see or act on intermediate hops (interactive auth dances) can't be driven through the leg today.
3. **Expired packages are honored by this leg's opener** (11e-iv) until the opener gains the expiry check the daemon already has.
4. **The relay answers any well-formed package addressed to it** (11e-v) until sender pinning lands — on a network where an attacker can reach the relay endpoint, the relay is drivable as a fetch proxy by anyone holding its public identity block, and its refusals explain themselves (oracle, §3).
5. **Replay re-executes at the relay** (11a-i). Idempotent GETs are unaffected in practice; a replayed non-idempotent POST would perform its API action again before the duplicate answer is refused engine-side. The answers stay sealed and worthless to the capturer, and the duplicate is refused + beaconed — but the *call* happens.
6. **Header/body asymmetry on compressed responses** (§1): wire headers verbatim, body decoded. Callers must read the body as delivered, not re-derive it from the headers.
7. **Size expansion:** covered form ≈ 3.5× payload size (1.5 MB → 5.28 MB). Services with request-size caps below the expanded size will refuse the covered form on size — a property of the form, observed at 5.28 MB with no refusal at httpbin or Cloudflare.
8. **The relay host's reputation is the leg's reputation** (rate budgets, IP bot-scores). Observed clean against GitHub and Cloudflare in this run; it is the services' call, not the wrap's.

## 5. Method and honesty notes

- Endpoints actually hit: httpbin.org (`/absolute-redirect/2`, `/redirect-to`, `/anything`, `/get`, `/image/png`, `/gzip`, `/post`, `/stream/3`, `/drip`), api.github.com (`/repos/ronininc/kingmaker`, `/zen`), ronininc.org (`/`, `/kingmaker`). Relay→API legs with per-leg timing/status are in `results.json` (30 legs, all 200).
- The discrimination control (case 9) ran **in this battery**, not inherited from live-fire: unenrolled + relay-less in native policy refuses closed and beacons, in the same state tree the interop cases used.
- Nothing was published or deployed; the only writes are this report, `interop/results.json`, `interop/run-output.txt`, the captures, and the battery's own state dirs under `interop/`.
- The 1a FAIL is an assertion artifact (httpbin's echoed scheme), substance verified in the same check; 11e-iv and 11e-v are genuine failures of the current code against the stated doctrine and are reported as FAIL without softening.
