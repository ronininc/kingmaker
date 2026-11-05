# PUSH-TO-PRODUCTION — Scripture Armor v2 readiness fixes

Ordered by Robbie, 2026-10-26 09:02 MST ("Do that push into production").
Executed via the GitHub connector `push-files`, one commit, one lane.

## Result

- **Repo / branch:** ronininc/scripture-armor, main
- **Parent:** `b5546b26c1dfc083db27144a982f37a2a8eb5e5e` (verified as live head
  immediately before the push; it had NOT moved)
- **New head / commit:** `6085fcecad22d9a6d7e6621377fa9795e8fd056a`
  (list_commits confirms it sits directly on b5546b26)

## Push set — exactly the FIX-REPORT-419 files

FIX-REPORT-419.md names two changed product files and no others. Both differed
from production; both were pushed. Nothing else was pushed.

| File | Remote blob @ b5546b26 (before) | Local blob (git hash-object) | Remote blob @ 6085fcec (read-back) | Match |
|---|---|---|---|---|
| `airlock.mjs` | `544ef210e2b81173c117a7862a66ba3244219e3d` | `a4e260e5b8199c7b1db7418bd9532bffcc8f6428` | `a4e260e5b8199c7b1db7418bd9532bffcc8f6428` | ✅ exact |
| `vaultd.mjs` | `bbdf715a8caa729de133675c32e0d2c587da56a1` | `11e665c2986bb1148c1bea2db4e8ce3b27b8d75c` | `11e665c2986bb1148c1bea2db4e8ce3b27b8d75c` | ✅ exact |

Contents of the fixes (per FIX-REPORT-419.md):
- **airlock.mjs — case 4:** custody bookkeeping (`unsettled` map), deferred
  close with disposition precedence, 10-minute failsafe with pre-wipe
  testimony to the daemon, scan-error as a recorded disposition, immediate
  close only on SIGTERM/SIGINT. No custody bytes can be destroyed silently.
- **vaultd.mjs — case 11:** egress drain — `egressInFlight`/`egressConns`
  tracking on the activation run object, in-flight wrapping in
  `startEgressServer`, `drainEgress(run)` awaited between `cell.done` and
  `finish(...)`, so a clean emission's promotion (candidate package, registry
  entry, `candidates/` placement) settles before the activation record is
  finalized.

## ⚠️ Ride-along disclosure — vaultd.mjs exit-78 (NOT part of FIX-REPORT-419)

The pushed `vaultd.mjs` is the current local file whole, and it carries two
lines from the later Linux-correction pass, which edited the same tree:

- `serve()`, socket-directory refusal (production line 250): `process.exit(1)`
  → 4-line comment + `process.exit(78)` (local lines 250–254).
- `serve()`, no-identity refusal (production line 257): `process.exit(1)`
  → comment + `process.exit(78)` (local lines 261–262).

Why they're in: 78 is EX_CONFIG — a configuration-class refusal restarting
cannot fix — and the corrected systemd units carry
`RestartPreventExitStatus=78` for exactly these two exits; with exit 1 the
unit would have restart-looped a daemon that can never start. The file was
NOT surgically reverted, on instruction: Muse's independent confirmation
(airlock 61/61, cell 94/94, CONFIRMED, 2026-10-26) ran against this exact
tree state, exit-78 lines included. The pushed bytes are the verified bytes.
A byte-level diff of production vs local vaultd.mjs (7 change blocks) shows
the delta is exactly these two hunks plus the case-11 drain fix — nothing
else rides along. The same diff discipline on airlock.mjs (10 change blocks)
shows only the case-4 fix.

## Delta confirmation

Full recursive tree walk (connector `get_file_contents`, path→blob maps) at
parent and at new head: **51 files → 51 files; the only changed paths are
`airlock.mjs` and `vaultd.mjs`**, each moving from its parent blob to the
local blob above. No other file changed; nothing added or deleted.

## Exclusions (per scope, all held)

Not pushed: `linux/`, `windows/`, `mac/` (beyond what production already
has), `README.md`, `MULTIPLATFORM-INSTALLER-REPORT.md`,
`CORRECTION-2026-10-26.md`, `INDEPENDENT-RERUN-2026-10-26.md`, and all
report/log files. The v2 fixes' test files were unchanged by the fix lane
(FIX-REPORT-419: "No test files were changed"), so none were in the set.

## Notes

- No 429s; single push, single commit.
- Snapshot sync record updated
  (`~/workspace/scripture-armor-v2.muse-github-snapshot-sync.json`, entry for
  commit 6085fcec, paths [airlock.mjs, vaultd.mjs]).
- Per instructions, the full suite was NOT re-run against production bytes in
  this pass; a fresh-clone verification is a separate order if Robbie wants it.
