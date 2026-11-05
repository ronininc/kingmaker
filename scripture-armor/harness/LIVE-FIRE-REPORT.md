# LIVE-FIRE REPORT — Scripture Armor vs the real internet

**Order:** Robbie Glover, 2026-10-25 — "make sure that Script Armor is actually able to
interact with the internet. The last thing I need is to be DOA." Plus the constraint
addendum: no exposure "any more than I have specifically requested in the code."
**Proving command:** `node live-fire/run-live-fire.mjs` (run twice; final run: **19 of 21
checks passed**). Raw evidence: `live-fire/results.json`, `live-fire/capture-live-relay.c2s/.s2c`,
`live-fire/capture-live-peer.c2s/.s2c`, per-leg provenance in `live-fire/state-engine/armor/`.
**Method discipline:** only the code's own paths — `createArmorEgress` (relay / package /
refused modes), the v3 frame format, and the `proof/relay.mjs` estate-relay pattern with its
**default real `fetch`** (instrumented for timing only; no URL substitution, no stub API).
Nothing published, nothing deployed.

---

## Verdict

**Can it interact with the internet today? YES — on the relay leg, proven end-to-end.**
A real GET to `https://api.github.com/zen` and real POST/GET calls to `https://httpbin.org`
completed through the wrap: status 200, response opened by the engine and return-matched by
canary, request body recovered byte-for-byte at the far end (echo hash match), and a
secret-looking `Authorization` value reached the API while never appearing on the tapped
engine→relay wire — no plaintext, no secret, no target hostname on that leg. The same calls
attempted under native policy without the relay **fail closed** (L6), so the live path taken
was the governed one. Speed is usable: on the fast legs the full wrapped round trip took
140–540 ms, of which the relay→API internet hop was 59–505 ms — the wrap's own overhead is
on the order of a hundred milliseconds, not seconds.

**Does it stay inside the exposure envelope the code defines? On the sealed package itself,
exactly** — the captured frame carries precisely the v3 field set `FRAME_FIELDS_V3`
(`scripture-armor/armor.mjs:316`) plus its signature, nothing more. **Two low-severity
exposures beyond the letter of the spec** were found, both from the Node fetch stack's
default headers riding *outside* the wrap (Findings 1–2 below). Neither carries identity —
no Kingmaker, install, or armor identifiers reach the API or the wire observer.

**One test did not complete — headline, not footnote:** the package round trip to an
enrolled peer on this VM's non-loopback interface was **blocked by this sandbox's network
layer, not by the armor** (Test 3). Plaintext controls fail identically, so cross-machine
peer reachability remains **unproven here** — it needs the two-machine run that was already
the named residual.

---

## Test 1 — Relay leg to real public APIs (the DOA test) — PASS

Engine → armor package (tapped) → estate relay on this VM → **real outbound HTTPS** →
response sealed back → engine opens it, canary-matched. Relay provenance for all three
calls: `mode: relay`, `return_match: true`, `answered_by_sign_fp` = the relay identity,
`via_relay: estate-relay`.

| Call | Result | Total round trip | Relay→API leg |
|---|---|---|---|
| GET `https://api.github.com/zen` | **200** — body: "Approachable is better than simple." (run 1: "It's not fully shipped until it's fast.") | 1,212 ms | 1,112 ms |
| POST `https://httpbin.org/post` (JSON body) | **200** — echoed `data` SHA-256 `6aa96d3be5a37f07…` == sent hash, byte-for-byte; parsed JSON intact | 540 ms (run 1: 10,860 ms — see note) | 505 ms (run 1: 10,698 ms) |
| GET `https://httpbin.org/headers` | **200** — API-side header echo captured for the exposure audit | 140 ms | 59 ms |

Notes:
- The POST body contained a unique marker and nested JSON; both survived the round trip
  exactly (hash match on the raw echoed body, not just the parsed form).
- The envelope carried `Authorization: Bearer LIVE-FIRE-SECRET-…`. httpbin confirms the API
  **received** it — it crossed inside the sealed envelope and was applied by the relay,
  which is the design. Test 2 proves it never crossed the engine→relay leg in the clear.
- Speed note: run 1's ~10.9 s POST was the public endpoint's own latency (the relay→API leg
  alone was 10.7 s of it); run 2 to the same endpoint took 505 ms on that leg. Pre-test
  plain-`curl` baselines from this VM: GitHub ≈ 1.0 s total, httpbin ≈ 0.8 s. The wrapped
  path is the same order as the naked path.

## Test 2 — Wire capture, engine→relay leg — PASS

Tap capture (`capture-live-relay.c2s/.s2c`, 6,158 / 15,502 bytes) read the way any observer
of that leg would read it:

- Contains `SCRIPTURE-ARMOR v3` packages and glyph bodies (PUA / Linear A / Cuneiform
  ranges present). **PASS**
- Does **not** contain the secret header value, the POST payload marker or any payload
  plaintext, the zen response plaintext, or either target hostname (`api.github.com`,
  `httpbin.org` — the destination lives inside the sealed envelope only). **PASS ×4**
- The captured package parses as a v3 frame; its field set is recorded in the exposure
  audit below. **PASS**

The relay→API last hop is plain HTTPS by design — the code says so in so many words
(`armor-egress.mjs` module header; the envelope itself carries a `relay_note` naming it).
Nothing in this report dresses that hop up as wrapped.

## Test 3 — Package mode over a non-loopback path — DID NOT COMPLETE (environment)

**What was attempted:** an enrolled armor peer bound to this VM's non-loopback interface
address `198.19.0.2` (interface `host0`), tapped on that interface, package round trip via
`armor-egress` package mode (classify → wrap → POST to the peer endpoint → return-match).

**What happened:** `fetch failed — cause=ECONNRESET read ECONNRESET`. Zero bytes crossed
(both capture files are 0 bytes — the connection was reset before the package crossed).

**Attribution — this is the sandbox, not the armor.** Controls run against the same
address with **no armor anywhere in the path**:

- The peer **is** bound and accepts TCP on `198.19.0.2:19713` (handshake completes). (L5d PASS)
- A **plaintext** HTTP POST to the same address fails identically: `ECONNRESET` — via
  Node fetch, via a raw TCP socket writing a hand-built HTTP request, and via `curl`
  ("Recv failure: Connection reset by peer"). (L5e PASS)
- The IPv6 ULA address (`fd8b:4f84:7d32:99::2`) is refused even earlier: `connect EPERM`.

This VM's only global interface is a `/30` veth to its sandbox host (`198.19.0.1` is both
gateway and DNS resolver); same-host connections addressed to the machine's own external
IP are reset at the data stage by that layer, for every protocol tested. **Honest label:**
this test proves interface *addressing* was attempted and the peer *binds* on the external
interface; it does **not** prove — or disprove — package traversal of a real network path.
Cross-internet peer reachability requires a second machine (or a host pair with a working
route) and remains an open residual, exactly as before this test.

## Test 4 — Negative control (fail closed) — PASS

- Native policy, engine state *with* the relay enrolled but no `relayName` given:
  `gather('https://api.github.com/zen')` → refused, `egress-refused-unenrolled` beacon
  written. (L6)
- A fresh state with **no enrollments at all**: `gather('https://httpbin.org/get')` →
  refused the same way. (L6b)
- Both refusals are in the beacon record. (L6c) The live calls in Test 1 therefore happened
  because — and only because — the governed relay path was enrolled and selected.

---

## Exposure audit — what leaves, vantage by vantage, diffed against the code

Spec sources: v3 frame field list `FRAME_FIELDS_V3` (`scripture-armor/armor.mjs:316-320`,
+ `sig` appended at signing); relay semantics in `engine/lib/armor-egress.mjs` (module
header and the envelope `relay_note`); provenance modes in the same file.

### (a) Wire observer on the engine→relay leg

**Sealed package:** frame JSON + glyph body. Frame fields actually on the wire — exactly
the specified set, no additions:

`v, canary, created, expiry, commit, sender_sign_fp, sender_sign_pub, recipient_seal_fp,
armor_seed, eph_pub, key_nonce, key_ct, file_nonce, scan_verdict, scan_digest, scan_report,
scan_override, armor_tier, sig`

That is: a per-call canary UUID, a creation timestamp, keyed commitment (not a plaintext
hash — v3 removed the cleartext sha256 oracle by design), the sender's *public* signing
key + fingerprint, the recipient's seal fingerprint, the ephemeral key-exchange material,
and the scan block. No payload, no destination, no plaintext hash, no identity beyond the
sender's armor public key (which the recipient needs to verify the frame signature).

**Outside the package, on the same leg — FINDING 1 (beyond spec, low severity):** the leg
is an HTTP POST made by the fetch stack, and its outer headers ride in the clear alongside
the package (verbatim from the capture):

```
POST / HTTP/1.1
host: 127.0.0.1:19712
content-type: application/vnd.scripture-armor; v=3
accept: */* · accept-language: * · sec-fetch-mode: cors
user-agent: node · accept-encoding: gzip, deflate · content-length: …
```

`armor-egress.mjs:91` sets **only** `content-type` on that call; every other header is a
Node fetch (undici) default the code never specifies. On this test's loopback leg only a
local observer sees them, and they identify nothing beyond a generic Node client — but on
any future non-loopback engine→estate hop, the same unspecified defaults would announce
the client stack and the leg's timing/sizes to a path observer. Also observable on this
leg, by design of the format (no padding is specified anywhere in `armor.mjs`): package
sizes and timing.

### (b) The public API endpoint's view of the relay's call

From httpbin's own echoes (Tests 1–2), the API sees an ordinary HTTPS request from the
relay host containing:

- The request itself — method, URL, and the headers/body the engine sealed into the
  envelope **for the API** (`Authorization`, `Content-Type: application/json`, the JSON
  body). The API is their intended recipient; this is the design working, not a leak.
- The relay host's public egress IP as origin: `87.81.238.3` (this VM's). In production the
  API learns the *estate relay's* address — never the engine's (the engine made no public
  connection at all in this test).
- **FINDING 2 (beyond spec, low severity):** the relay's outbound fetch sends Node's
  default header profile — `User-Agent: node`, `Accept: */*`, `Accept-Language: *`,
  `Sec-Fetch-Mode: cors`, `Accept-Encoding: br, gzip, deflate`. `proof/relay.mjs:42`
  passes the envelope's headers through `fetch` and the code specifies no UA/header
  profile of its own, so the API can fingerprint the relay's stack as "Node.js fetch."
  Generic — it names a runtime, not Kingmaker, not an install, not a user — but it is
  exposure the code did not specifically request. (`X-Amzn-Trace-Id` in the echo was added
  by httpbin's own AWS infrastructure, not by anything on this side.)
- The API does **not** see: the canary, either armor fingerprint, the frame, or any
  Kingmaker/armor identifier string. The envelope is opened at the relay; nothing
  armor-shaped is forwarded.

### (c) DNS resolver / network path

- The **engine made zero public DNS lookups and zero public connections** — its only
  sockets were to `127.0.0.1` (relay tap) and the (reset) external-interface attempt.
- The **relay process** resolved `api.github.com` and `httpbin.org` through this VM's
  resolver (`198.19.0.1`, per `/etc/resolv.conf`) over plain DNS — so the resolver sees
  those two names, their timing, and that this host asked. That is inherent to the relay
  making ordinary HTTPS calls, which the code specifies openly.
- A path observer of the relay→API hop sees what any HTTPS observer sees: destination IPs,
  TLS SNI hostnames (`api.github.com`, `httpbin.org`), sizes, timing. **By design** — the
  code names this hop ordinary HTTPS and never claims otherwise. The observer learns
  nothing about the engine, the payload, or the armor from it beyond "this relay called
  this API."

**Envelope verdict:** the sealed artifact itself exposes exactly what the code specifies —
field-for-field. The beyond-spec residue is confined to fetch-stack default headers on
both HTTP legs (Findings 1–2): real, worth a header-profile fix in `armor-egress` /
the relay, and in both cases stack-generic rather than identity-bearing.

---

## Timings (final run; baselines from plain curl, same VM)

| Path | Time |
|---|---|
| Plain curl → api.github.com (no armor) | 996 ms total (DNS 3 ms, TLS 367 ms) |
| Wrapped relay round trip → api.github.com/zen | 1,212 ms (relay→API leg 1,112 ms) |
| Wrapped relay round trip → httpbin.org/post | 540 ms (relay→API leg 505 ms) |
| Wrapped relay round trip → httpbin.org/headers | 140 ms (relay→API leg 59 ms) |

The wrap, both seal/open cycles, and the local relay hop together add roughly
80–100 ms on the fast legs — interaction at usable speed is not in doubt on this evidence.

## Residuals — precisely what this test does not prove

1. **Cross-machine / cross-internet peer-to-peer (package & flow modes): UNPROVEN.**
   Test 3 was blocked by this sandbox's refusal of same-host→own-external-IP traffic
   (plaintext controls fail identically). A two-machine run — enrolled peers on separate
   hosts, ideally separate networks — is still required. Flow mode (Addendum K) was not
   re-run live at all; its loopback proof stands from the integration run only.
2. **The estate relay here is a local process** (the `proof/relay.mjs` pattern) on the
   same VM. A production estate relay on a separate host adds a real network leg between
   engine and relay; that leg's transport (the fleet-door pattern uses HTTPS) was not
   what was tested — what was tested is the wrap on the leg, which is transport-agnostic
   in the code and was verified byte-for-byte on the tap.
3. **Production fleet-host enrollment** (the real front door accepting armor packages) is
   untouched by this test — unchanged from the armor-native build report's residual list.
4. **Findings 1–2 are unfixed.** This was a test, not a patch: no code was changed. A
   specified header profile for `armor-egress` package POSTs and for the relay's outbound
   fetch would close both.
5. httpbin and GitHub were the only public endpoints exercised, chosen because they are
   neutral echo/utility services. Nothing about authenticated third-party APIs beyond
   "the API receives exactly the headers/body the envelope carries" (proven via echo)
   is claimed.
