# TWO-ENDPOINT PROOF — Scripture Armor, machine to machine

**Order:** Robbie Glover, 2026-10-25 — after the live-fire test left cross-machine package/flow reachability UNPROVEN: *"no you have to prove it"* … *"run a vm."*
**Run:** 2026-10-25, in `~/workspace/kingmaker-armor-native/two-endpoint/`. **Result: PROVEN on Rung 1 — 16 of 16 proof checks passed, 0 failed; 2 security findings confirmed live (both were predicted by the daemon-conformance audit).**

**Topology, stated exactly.** Endpoint A is the engine side on this sandbox host (Node v24.22.1, the real `engine/lib/armor-egress.mjs` + `armor-native.mjs`). Endpoint B is a **real, separate virtual machine**: QEMU 8.2 booting Alpine Linux 3.24.3 (guest kernel `Linux version 6.18.58-0-virt`, its own kernel, its own TCP/IP stack, its own armor identity created inside the guest) running Node v22.14.0 (musl). The link between them is QEMU's slirp user-networking: the guest holds DHCP address 10.0.2.15 behind QEMU's emulated NAT, and the host reaches the guest's three listeners through host-forwarded loopback ports (18731 package, 18732 flow, 18733 rogue, 18899 file exchange); a logging TCP tap proxy sits in the package and flow paths on the host, and tcpdump independently captured the host loopback link. Packets therefore traversed: host socket → tap proxy → QEMU process → slirp NAT → emulated virtio NIC → guest kernel stack → guest process, and back. This is a genuine two-operating-system, two-kernel, two-identity exchange over a NAT'd virtual network. It is **not** two physical machines and it is **not** the open internet: no WAN latency, no third-party network, no physical wire. What it proves and does not prove is itemized at the end.

---

## The ladder, as actually climbed

**Rung 1 — QEMU (USED).** `/dev/kvm` does not exist in this sandbox (verified), so the guest ran under QEMU TCG software emulation — slow, but a full real machine. QEMU was installed via apt (`qemu-system-x86 1:8.2.2`). Guest: Alpine virt ISO 3.24.3, booted from its extracted kernel/initramfs with the ISO attached, serial console driven by a pexpect driver (`drive-vm.py`, full console log in `drive-vm.log`).

Three honest failures on the way up, each diagnosed before moving on:

1. **Tap networking was built, then abandoned on evidence.** A tap device + 10.77.0.0/24 subnet was created (the design the task brief's Rung 2 also describes, applied to the VM). But direct TCP connects from agent processes to *any* non-loopback address return **EPERM** in this sandbox (raw `net.connect` to 10.77.0.1 → `EPERM`, immediate; a Node fetch to the same address hung to a headers timeout), while loopback connects succeed instantly (HTTP 200 in 35 ms). The sandbox's only sanctioned egress is its HTTP proxy (visible in the environment) plus loopback. The engine side could never have opened a socket to a tap-subnet guest. This is also the same wall behind the live-fire hairpin resets (connections to the sandbox's own external address, 198.19.0.2, reset at the data stage). → Slirp host-forwarding keeps every host-side socket on loopback and lets QEMU's own NAT carry the traffic into the guest.
2. **The ISO's apk route cannot install Node.** The Alpine *virt* ISO's repo carries only 96 base packages — no `nodejs`, no `libstdc++` (verified by extracting `/apks`: *"ERROR: unable to select packages"* on the first run was the repo genuinely lacking the package, not a mount problem).
3. **The 55 MB musl Node tarball over slirp did not finish in 300 s under TCG.** Replaced by a **virtio-9p share**: the guest mounts a host directory read-only and runs the official Node v22.14.0 musl binary in place — zero bulk network transfer. One more fix after that: the musl build dynamically links `libstdc++`/`libgcc`, absent from the minimal guest; the two `.so` files (unpacked on the host from the Alpine 3.24 main-repo apks, GCC 15.2.0) rode the same share and were copied into the guest's `/usr/lib`. Node then ran in the guest, verified by version output on the guest console.

**Rung 2 (netns/veth) was not needed** — the VM rung succeeded. Rung 3 not reached.

**Guest contents.** The peer bundle (≈128 KB: `peer-server.mjs`, `rogue-server.mjs`, `engine/lib/armor-native.mjs`, the `scripture-armor/` library) and the engine's public identity block reached the guest over the 9p share. The peer created its identity *inside* the guest; its public block came back to the host over the link (through the forwarded file port) and was enrolled by the engine from that transfer — the host never touched guest state by any side channel.

Identities: engine sign_fp `1f369256…b1b5d3`; guest peer sign_fp `1aa82fb3…8579f03`; guest rogue sign_fp `db1ee6b5…3613874`.

---

## The proof — every check, with its evidence

Full machine-readable results: `two-endpoint/results.json`. Wire evidence: `capture-vm.c2s/.s2c` (package leg, via tap proxy), `capture-flow.c2s/.s2c` (flow leg, via tap proxy), `lo.pcap` (independent tcpdump of the whole run's host-side links). Console evidence: `drive-vm.log`.

### Package mode (Addendum: engine egress `package`)

| # | Check | Result | Evidence |
|---|---|---|---|
| P1 | Round trip host→guest→host completes via `armor-egress` package mode | **PASS** | status 200, 1,384 ms |
| P2 | Guest recovered the payload **byte-for-byte** (guest's own SHA-256 of what arrived == host's SHA-256 of what was sent) | **PASS** | both `f9169164fc1a9e4f075c68ef1f15099d63316b3f5767be55e22172ecffaabf74` |
| P3 | Engine recovered the guest's reply payload byte-for-byte (ack-carried hash == hash of the body the engine opened) | **PASS** | guest payload composed inside the VM |
| P4 | Provenance: response return-matched by canary, answered by the **enrolled guest peer** identity | **PASS** | `answered_by = 1aa82fb3…` == peer fp |
| P5 | Guest-side evidence (the peer process's own `evidence.json`, fetched afterward) independently records the same payload hash | **PASS** | `last_payload_sha256 = f9169164…`; shutdown dump: `packages_opened: 2` |

### Flow mode (Addendum K)

| # | Check | Result | Evidence |
|---|---|---|---|
| F1 | Flow round trip across the link echoes the payload | **PASS** | `echo:vm-flow-payload-1`, 442 ms |
| F2 | **Return-hash loop:** the guest's signed chain receipt verifies against the sent chain | **PASS** | `receipt_verified: true`, chain head `5bbef9d9…cf47a` == sent head |

### Negatives — what refuses, and what does not

| # | Check | Result | Evidence |
|---|---|---|---|
| N2 | Response naming a **never-sent canary** is refused by return-match | **PASS** | `return-match failed (return-unknown-canary) — response not trusted` |
| N2b | That refusal is recorded as a beacon | **PASS** | engine `beacons.jsonl` |
| N3b | Package **addressed to a different recipient** is refused by the guest peer | **PASS** | HTTP 400, recipient check |
| **N1** | **FINDING — a response forged by an UNENROLLED keypair naming the real canary was ACCEPTED by the engine.** The rogue server (fresh identity, in the guest) could not open the request and didn't need to: the canary is readable in the cleartext frame header, so it named it in a reply sealed with its own keypair. The engine opened it, return-matched it, and delivered the forged body as the answer. Provenance shows `answered_by = db1ee6b5…` — the rogue's fingerprint, recorded *after* acceptance, never compared to the enrolled peer's. | **CONFIRMED LIVE** | reply body received by the engine: `FORGED-RESPONSE-PAYLOAD-51bd::composed by an unenrolled keypair` |
| **N3** | **FINDING — the guest peer OPENED a well-formed package from an unenrolled sender.** Sender pinning is absent on the peer side too (its `openInbound` call passes no expected-sender, same as the fleet door's). | **CONFIRMED LIVE** | guest evidence `packages_opened 1→2`, stranger's fp in `senders_seen` |

N1/N3 are the daemon audit's responder-pinning finding, reproduced end-to-end across a real link — not a regression discovered here, and not fixed here (this was a proof run, not a patch). The mechanism to fix it already exists in the code — `openInbound`'s `expectSenderSignFp` parameter — but no call site passes it, on either side.

### The wire, from an observer's chair

| # | Check | Result |
|---|---|---|
| W1 | Package-leg capture shows `SCRIPTURE-ARMOR v3` packages | **PASS** |
| W2 | Capture shows **no** payload marker and **no** payload plaintext | **PASS** |
| W3 | Capture shows **no** forged payload in the clear (it crossed sealed) | **PASS** |
| W4 | Wire bodies are glyph armor (PUA / Linear A / Cuneiform ranges) | **PASS** |
| W5 | Flow-leg capture carries sealed flow frames (hello + `body_b64`), no plaintext payload, no echo text | **PASS** |
| W6 | Independent check: `strings` over the tcpdump `lo.pcap` of the entire run — 0 hits for the payload marker, the flow payload, the forged payload, and a payload sentence; 11 `SCRIPTURE-ARMOR v3` frames present | **PASS** |

(Scope note on W6: the pcap covers host loopback, so it also contains the test *scaffolding* in the clear — public identity blocks and hash-only evidence files. No armor payload plaintext of any leg appears in it.)

---

## What this proves, and what it does not

**Proven now:**
- Scripture Armor **package mode** and **Addendum K flow mode** work machine-to-machine: two separate operating systems, two kernels, two TCP stacks, two armor identities, enrollment exchanged over the link, payloads recovered byte-for-byte in both directions, chain receipts verifying, refusals beaconing — with an observer of the transit seeing only v3 frames and glyph bodies.
- The refusal machinery (unknown canary, wrong recipient) fires correctly across a real link, not just on loopback.
- The audit's responder-pinning gap is real in the wild, in both directions (N1, N3) — stated here so it is never mistaken for a suspicion again.

**Not proven by this run:**
- **Traversal of the public internet between two physical machines.** The guest sat behind QEMU's NAT on one physical host. The live-fire test proved the *relay* leg against real internet endpoints (api.github.com, httpbin) from this host; this run proves *enrolled peer-to-peer* across a real OS boundary. The composition — an enrolled peer reached across the open internet, with real WAN latency, NATs not of our making, and fremd networks in between — has still never been run. It needs a second real host (a VPS, Ramiro's machine, or the Mac on a routable path) and is the natural next proof.
- **Performance.** Timings here (package 1,384 ms, flow 442 ms) are dominated by TCG emulation and a 200 ms flow settle delay; they say nothing about speed on real hardware or real networks.
- **The tap/routed-subnet topology.** It was blocked by the sandbox's connect policy (EPERM), not by anything in the armor; on an unrestricted host the same peer bundle runs unchanged against a routable address — the peer binds `0.0.0.0` and neither side's code knows slirp was involved.

## Residuals

1. **Responder pinning (N1/N3)** — the one code change this proof argues for: pass `expectSenderSignFp` at the `packageRoundTrip` and peer-side `openInbound` call sites. Until then, return-match alone authenticates a response only against someone who never saw the request.
2. **Two-physical-machine / open-internet peer run** — still owed, as itemized above.
3. The guest was console-driven (pexpect) and has been powered off; all guest state was tmpfs and is gone. The peer/rogue sources, driver, captures, and results remain in `two-endpoint/` and the whole run is reproducible from them.

## Evidence inventory (`two-endpoint/`)

`results.json` (sha256 `8c41304a…`) · `capture-vm.c2s` (`3e3b2184…`) · `capture-vm.s2c` · `capture-flow.c2s` (`f8d9a0cf…`) · `capture-flow.s2c` · `lo.pcap` (`64724f72…`, 47,425 bytes) · `drive-vm.log` (full guest console) · `driver.out` · `run-two-endpoint.mjs` · `drive-vm.py` · `guest-src/` + `guest-bundle/` (the exact code the guest ran) · `share/` (what the guest mounted) · `staging/` (engine block + bundles as served)
