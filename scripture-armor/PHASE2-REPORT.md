# Scripture Armor v2 — PHASE 2 REPORT (Closures 2 + 3)

Built in `~/workspace/scripture-armor-v2/` (the v1 standalone tree untouched).
Local files only; no GitHub calls were made.

## Final test tally (all run against the final tree)

| Suite | Result |
|---|---|
| v1 regression (`test/run-tests.mjs`) | **53/53 passed** |
| Closure 1 scan battery (`test/run-tests-v2-scan.mjs`) | **83 passed / 0 failed / 4 deferred** (the 4 deferrals are the Phase-2 halves; their notes now point at the cases below) |
| Closure 2 cell battery (`test/run-tests-v2-cell.mjs`) | **94/94 passed** |
| Closure 3 airlock battery (`test/run-tests-v2-airlock.mjs`) | **61/61 passed** |

## Closure 2 — activation inside the shell (§2): DONE

- **DONE** — Activation store + grants: `armor.mjs wrap --for-activation` and
  `wrap-repo --for-activation` register origin `activation-store`. Egress-origin
  packages refuse activation as `not-activatable` (battery case 9, airlock case 8).
  First activation pends; approval writes a revocable grant
  (`vaultd.mjs revoke-grant`); later activations under a live grant launch
  tap-free; every run is appended to the entry's `activations` record with a
  lease bounding concurrency (`max_instances`, battery case 15).
- **DONE** — Materialization in memory only: `executeUnwrap` was refactored to
  expose `openPackage(frame, payload)` (AEAD open + digest re-verify, unchanged
  logic); activation opens once at the gate — digest mismatch is a first-class
  `image-mismatch` beacon, and classification judges the verified plaintext,
  never the sealed bytes. Plaintext is staged into the cell only; no persistent
  path ever holds it (case 3 sweeps the store for the fixture bytes).
- **DONE** — Cells: `cell.mjs` implements the substrate interface
  (`probeCells` / staging / markers / destroy-with-proof). SOFT cells run on
  this host via `unshare -Urmpfn` (tmpfs scratch = RAM-only, image bind-mounted
  read-only, fresh network namespace with no route, CPU/wall caps, process-group
  kill). Proven: image writes fail (case 4), direct TCP fails (case 2), scratch
  exists during the run and the whole staging is destroyed after (cases 5+10),
  wall-clock kill recorded (case 10).
- **DONE** — Egress: length-prefixed frames on a per-run Unix socket; the
  daemon seals + registers emissions under its own identity (programs hold no
  keys), registering live at the peer's daemon when the address book carries a
  `daemon_socket`, else the v1 outbox. Return-match proven end-to-end at the
  peer (case 1). Unresolvable destinations drop + log (case 13). Tier binding
  enforced in the handler (Tier-2 ⇒ airlock-only; see PARTIAL note below).
- **DONE** — Promotion/mantrap door: emitted programs are never delivered as
  programs. Clean emissions become activation-store candidates behind scan +
  their own grant (case 11, incl. the candidate itself pending and then
  running); critical emissions are refused promotion. The exact-sample-hash
  rule lives in scan.mjs's binary lane only, so the daemon consults the owner's
  `badhashes.txt` directly on this path — a listed sample is refused whatever
  its lane (case 11, spawner-bad).
- **DONE** — Grants/leases/orphans: daemon death mid-run leaves the cell
  running as a real separate process; the next daemon start reaps it at lease
  expiry (`cell-orphan-reaped`, staging destroyed, process dead — case 14).
- **DONE** — Scan gate at activation (§1.6): frame-vs-registry scan-block
  equality (`scan-mismatch` beacon), critical refuses, overridden-critical and
  warn pend with notices, unscanned executables pend for a one-time logged
  override that never grants. Per-access report re-verification (deferred 22b)
  runs at activation — Tier 1/2 every activation, Tier 0 at first — and Tier-2
  freshness re-scans stale reports and demands the bound digest reproduce.

### Deferred Phase-1 halves — landed

- **Case 11 (v1 package ⇒ refusal): DONE** — a v1-wrapped package registers at
  the v2 daemon classified untiered (tier null, non-activation origin) and
  activation refuses; nothing runs (cell battery D11).
- **Case 21 (Tier-2 placement): PARTIAL — substrate limit.** The Tier-2 params
  snapshot (min_cell hard, egress airlock-only, downgrade forbidden, dual
  approval) is asserted in both batteries, and on this host the enforcement is
  proven in its strongest available form: Tier-2 activation REFUSES
  (`cell-unavailable … forbids downgrade`) and nothing runs. The airlock-only
  egress branch for a *running* Tier-2 program is implemented in the egress
  handler but cannot be exercised end-to-end here — it needs a HARD substrate
  this host does not have.
- **Case 22b (report re-verification at activation): DONE** — tampered reports
  refuse activation before any cell boots, at Tier 0 (first activation) and
  Tier 1 (every activation) (cell battery D22b).
- **Case 26 (untiered repo part): DONE** — repo activation refuses NAMING the
  untiered part(s); the same tree wrapped with tiers activates whole, sibling
  files staged (cell battery D26).

## Closure 3 — docking airlock + Strip Outside Influence (§3, A.3): DONE

- **DONE** — Process-per-session: `airlock.mjs` is spawned/supervised by
  vaultd, one child per session. The child holds no identity keys, no registry
  handle, and no path into the store — proven from outside (battery case 12:
  cmdline/environ carry only the session dir; no identity/registry files in the
  session tree). Session dirs live under the OS temp dir, never in the store.
- **DONE** — Crossing records BEFORE movement: OUT crossings are appended to
  `airlock.jsonl` (with the delivered bytes' SHA-256) before the child frames
  them to the peer — the battery compares record vs receipt timestamps
  (case 2). IN crossings record after the daemon seals + registers, before the
  chamber copy is wiped.
- **DONE** — Inbound gates in order: size/type → Closure-1 scan on the CHAMBER
  copy → wrap-on-entry (origin `airlock-in`; inside the shell the data exists
  only as an armored package). Critical scans seal into `quarantine/` custody,
  beacon `airlock-scan`, and close the session on first strike (case 4).
  Violations 1–2 drop and the session survives; the third closes it; budget
  exhaustion is a clean close with no violation and no beacon (cases 5, 10).
  Peer death mid-frame discards the partial frame (`closed: peer-gone`,
  case 6). Killing the airlock child −9 closes that session as
  `airlock-fault`; the daemon, registry, pendings, and other sessions are
  unaffected (case 9).
- **DONE** — A violation in a session serving a Tier-2 program sets that
  program's registry anomaly (case 11).
- **DONE** — Programs OUT cross as `.scripture` packages by default; plaintext
  code only under a profile that declares it, shown in plain words at the
  dock-open pend (case 7).
- **DONE** — Addendum A.3 default: with no dock open there is no crossing
  surface at all (no sockets exist). The owner-opened dock is the request;
  inbound executables are scanned in the chamber before crossing; request
  (open record), verdict (crossing record), and outcome (registry entry) are
  all logged (case A3: a warn-verdict payload crosses only with its verdict
  on the record).
- **DONE (Addendum I, CAPABILITY)** — an agent process in a cell wrote and
  dynamic-imported a plugin-shaped module from scratch, ran CLI tools via
  child_process, and emitted the combined result through the governed egress;
  the peer unwrapped exactly that result (cell battery CAP). Capability
  intact; crossings governed.

## Substrate limits — stated as limits

- **HARD (Firecracker) cells are implemented-not-provable on this host.**
  `/dev/kvm` is absent and no `firecracker` binary exists. `probeCells()`
  reports HARD unavailable NAMING the missing pieces; `runHardCell()` refuses
  with those names. Nothing fakes a HARD run: Tier-2 (HARD-only) work refuses
  here by design. The Firecracker host runner remains the separate SPACE-layer
  component per SPEC §2.9; what ships here is the interface, the probe, and
  honest refusals.
- **SOFT here is the `unshare` form** (bwrap is not installed): it confines
  network (no route), image writes (read-only bind), and persistence (tmpfs
  scratch dies with the namespace). It shares the host kernel AND host
  filesystem read visibility for the owner's uid — it is not full filesystem
  confinement, and activation records name the class `soft` so the limit rides
  the record.
- **The airlock chamber is the named degraded form** — a 0700 scratch dir in
  the session dir (`chamber: dir (degraded)` in every session record), because
  no cell substrate is available to the airlock child on this host.
- **Cell emissions are registered at the peer via its daemon socket** when the
  address-book entry carries `daemon_socket`; otherwise they queue into the
  v1 offline outbox (`registry-outbox.jsonl`) — v1 semantics, unchanged.

## Deviations from spec sizing/shape (named plainly)

1. The `activate` / `dock-*` streaming clients live in the **vaultd CLI**
   (`vaultd.mjs activate|dock-open|dock-send|dock-close|revoke-grant`) rather
   than in armor.mjs (SPEC §2.9 split the ~LOC differently). armor.mjs gained
   only `--for-activation` on wrap/wrap-repo. Functionality is identical.
2. **Dual approval + Tier-2 on this host:** the cell decision runs before the
   pend, so a Tier-2 activation here refuses at the cell gate without reaching
   the dual-approval pend; the dual-approval flow itself is Phase-1-proven on
  the unwrap path and wired identically for activation pendings.
3. Two daemon-side hardening additions beyond the letter of the spec, both
   closing real holes found by the batteries: (a) classification at the
   activation/airlock gates sniffs extensionless source text so a script
   cannot cross or activate classified as data; (b) the promotion path checks
   `badhashes.txt` directly (see Closure 2 notes).

## Files

- `~/workspace/scripture-armor-v2/cell.mjs` (new, 183 lines) — cell substrates,
  staging, markers, SOFT runner, HARD probe/refusal.
- `~/workspace/scripture-armor-v2/airlock.mjs` (new, 304 lines) — per-session
  airlock child: peer framing, gates, chamber, violation ladder.
- `~/workspace/scripture-armor-v2/vaultd.mjs` (1,963 lines) — activation RPC +
  grants/leases, `openPackage` refactor, egress handler + promotion, report
  re-verification, orphan reaper, airlock supervisor + dock RPCs, CLI clients.
- `~/workspace/scripture-armor-v2/armor.mjs` (1,558 lines) — `--for-activation`
  on wrap / wrap-repo.
- `~/workspace/scripture-armor-v2/test/run-tests-v2-cell.mjs` (710 lines) +
  `test/fixtures-cell/` (8 fixtures) — Closure 2 battery, 94 checks.
- `~/workspace/scripture-armor-v2/test/run-tests-v2-airlock.mjs` (544 lines) —
  Closure 3 battery, 61 checks.
- `~/workspace/scripture-armor-v2/test/run-tests-v2-scan.mjs` — only the four
  deferred NOTES changed (text); counts unchanged.
