# Obscura Cage Intake — Record

**Date:** 2026-10-20 (America/Phoenix, late evening)
**Authority:** Founder order — "pre signing addition" to Kingmaker v0.4.2.
**Upstream:** h4ckf0r0day/obscura, Apache-2.0, https://github.com/h4ckf0r0day/obscura
**Release pinned:** v0.2.5 (released 2026-10-17; 128 commits since v0.2.4)

## Artifacts fetched (from the official GitHub release, over HTTPS)

| Asset | Bytes | sha256 |
|---|---|---|
| obscura-aarch64-macos.tar.gz | 67,143,887 | fcca31eba4280cd67a2e226ef4b015e432d5c089f78cefd074ad12bbc8e23345 |
| obscura-x86_64-linux.tar.gz | 71,555,327 | 2116764b99bc084fae3668b68aa535b4cf456e4498845b47493ad4123e83ca36 |

- The macOS archive was fetched TWICE; both downloads hash to the
  identical value above. The contract pin rests on that agreement.
- macOS archive contents verified: `obscura` + `obscura-worker`
  (matches the upstream-documented layout).
- The pinned asset is the standard render build (no -stealth /
  -no-render suffix) — the variant the MCP surface was verified
  against at registration.

## Behavior tests (v0.2.5 Linux x86_64 build, run on the intake VM)

1. `obscura --version` → `obscura 0.2.5`. ✓
2. **Dead Tor proxy fails closed:** `--proxy socks5h://127.0.0.1:9050`
   with nothing listening → navigation error ("error connecting to
   socks proxy … failed to create underlying connection"). No direct
   fallback fetch. ✓
3. **socks5h is honored as a scheme** — the binary attempted the
   SOCKS connection (test 2). Plain `socks5://` instead resolves the
   target name LOCALLY first (observed via the SSRF guard firing on
   the local resolution) — the DNS leak the profile exists to prevent,
   and the reason the contract pins `socks5h` exactly. ✓
4. **No silent proxy-drop observed:** a parseable proxy on a closed
   port (http://127.0.0.1:1) → connection refused, hard failure. A
   garbage proxy string is treated as a proxy HOSTNAME (upstream
   parsing is lenient — it does not error), which is why the contract
   never accepts a caller-supplied proxy string at all: tor mode
   injects the pinned constant, and `--proxy` in caller args is
   refused in every mode. ✓
5. Environment caveat: the intake VM sits behind a transparent egress
   proxy with fake-IP DNS, which upstream's SSRF guard blocks — no
   successful page fetch was possible from that sandbox, baseline
   included. Fetch-success behavior was therefore not exercised
   there.

## Owed (recorded, not blocking the pin)

- **Live-Tor end-to-end** on a machine with a real Tor daemon: launch
  the tor profile, fetch through 127.0.0.1:9050, confirm the exit is
  a Tor exit and an .onion name resolves. This is the launcher
  preflight the contract now requires before any tor spawn.
- macOS binary smoke (the Linux build carried the behavior tests;
  the pinned macOS archive is the same release, hash-verified).

## What changed in the fold-in

- `obscura/lib/obscura-contract.mjs` — pin filled (tag, asset, hash,
  PINNED); Tor profile added (`OBSCURA_TOR_PROXY`,
  `validateTorProxy`, `tor` option in `buildLaunchConfig`, caller
  `--proxy` refused in all modes, governance records profile +
  preflight).
- `obscura/descriptor.json` — pin block synced; `torProfile` block
  added.
- `obscura/tests/run-tests.mjs` — pin checks now assert the pinned
  state; unpinned-refusal check uses an explicitly unpinned record;
  Tor section added. Suite: 32/32.
- `STACK42.md` — obscura note updated to the post-intake truth.
- Nothing else in the fold-in or the stack was touched.

## Live-Tor verification (2026-10-21)

Harness: `tests/live-tor-e2e.mjs` — bootstraps a real Tor client, runs the
contract's SOCKS preflight on 127.0.0.1:9050, spawns Obscura MCP with the
pinned `socks5h://127.0.0.1:9050` proxy, fetches
check.torproject.org/api/ip, and runs the no-proxy control.
Attempted on the Muse VM 2026-10-21: Tor reached Bootstrapped 45%
(consensus fetched; directory authorities reachable) but relay
microdescriptors stalled at 0/9101 — the VM's egress is proxy-mediated and
direct relay traffic does not flow, so no circuit could build. OWED: one
run on a direct-egress host (the Mac, with the aarch64 binary + a local
tor) — expected result IsTor=true via proxy, IsTor=false direct.
