# DEFAULT-DAEMON-REPORT — always-on vaultd as the default install posture

Order: Robbie, 2026-10-26 03:25–03:26 MST — the always-on vault daemon
setup proven on his Mac "should be default," and an agent was set on it.
Scope: LOCAL trees only. Nothing pushed, nothing published.

## Inventory BEFORE any change

### `~/workspace/scripture-armor-v2/` (primary tree)
- `mac/install-armor.sh` — the only installer. It checked Node ≥ 24,
  created/loaded the identity at `~/.scripture-armor`, printed the
  public identity block, and ended with a manual hint:
  `Daemon (when you want it running): node ~/scripture-armor/vaultd.mjs`.
  It installed **nothing** system-wide and started **nothing**.
- `mac/breach-scan.sh` — read-only inventory scanner; not an installer.
- `mac/org.ronininc.scripture-vaultd.plist` / `mac/install-daemon.sh` —
  **did not exist in the tree.** (The daemon conversion proven on
  Robbie's Mac lived only on that Mac, placed there directly.)
- `launch.mjs` — Kingmaker's single-command launcher: creates identity,
  takes terms acceptance, serves vaultd in the **foreground**. Not a
  service registration.
- `package.json` — bin entries + `test` script only; no install hooks.
- Linux: **no** systemd unit, **no** Linux installer (only
  `dns-profiles/` resolver configs). Windows: **no** service material
  (only a DNS-over-HTTPS doc).

### `~/workspace/scripture-armor-standalone/`
- No `mac/` directory, no installer of any kind, no service material.
  Tree = `armor.mjs`, `vaultd.mjs`, `test/`, `dns-profiles/`,
  README/LICENSE/package.json. Its daemon section documents manual
  foreground `serve` only.

## Files changed (all in `scripture-armor-v2/`)

| File | Purpose |
|---|---|
| `mac/org.ronininc.scripture-vaultd.plist` (NEW) | launchd template for vaultd: label `org.ronininc.scripture-vaultd`, `RunAtLoad` + `KeepAlive`, owner `UserName`, explicit `--identity-dir`/`--socket`, HOME/PATH env, log path — with placeholders the installer renders. |
| `mac/install-daemon.sh` (NEW) | Renders the template with the owner's real paths and installs it: system LaunchDaemon by default (boots out + backs up — never deletes — any existing per-user agent plist; bootstrap/enable/kickstart; designated-host `pmset -a disablesleep 1`), per-user LaunchAgent only in explicit fallback mode. Prints every change it makes; `--render-only` prints the rendered plist for inspection. |
| `mac/install-armor.sh` (REWRITTEN) | The standard install now makes always-on vaultd its default outcome: identity, then the LaunchDaemon step via sudo'd helper. Adds `--designated-host`, `--user-agent` (fallback), `--no-daemon` (opt-out) + matching env vars; refuses to run as root; fails loudly with named fallbacks if the daemon step fails. |
| `README.md` (EDITED) | New "Default install posture — always-on vaultd" section in *The daemon*: per-platform table (macOS implemented-by-default; Linux/Windows NOT IMPLEMENTED with reasons), designated-host sleep policy + revert, all opt-out paths, daemon removal commands; new Files-table rows for the service files. |
| `DEFAULT-DAEMON-REPORT.md` (NEW) | This report. |

No daemon/client code (`vaultd.mjs`, `armor.mjs`, `launch.mjs`, tests)
was touched.

## Before / after install behavior

### macOS
- **Before:** install created the identity and stopped. vaultd ran only
  if the owner started it by hand, in the foreground; logout, reboot,
  or sleep ended it. The always-on conversion existed only as a
  one-off act on Robbie's Mac.
- **After (default):** `bash mac/install-armor.sh` creates/loads the
  identity, then installs vaultd as a **system LaunchDaemon** —
  starts at boot, **before login**, `KeepAlive`, runs as the owner
  user against the owner's identity store, survives logout. An
  existing per-user LaunchAgent for the same label is booted out and
  its plist moved to a `.agent-backup` (not deleted).
- **Designated host:** `--designated-host` (or
  `SCRIPTURE_ARMOR_DESIGNATED_HOST=1`) additionally runs
  `pmset -a disablesleep 1`; the installer prints that it changed the
  sleep policy and prints the revert. Without the flag, sleep is left
  untouched and the installer says so — no silent system changes.
- **Opt-outs:** `--user-agent` (login-level LaunchAgent fallback,
  labeled as such in its own output) or `--no-daemon` /
  `SCRIPTURE_ARMOR_DAEMON=off` (no service; manual foreground only).
  Removal commands are documented in the README.

### Linux
- **Before:** no service registration. **After:** unchanged —
  **NOT IMPLEMENTED**, recorded in the README table with the reason
  (no systemd unit or Linux installer exists in this tree to extend;
  inventing a new installer surface was out of scope). `vaultd.mjs
  serve` under an owner's own supervisor, or Kingmaker's `launch.mjs`,
  remains the path.

### Windows
- **Before:** no service registration. **After:** unchanged —
  **NOT IMPLEMENTED**, recorded in the README table with the reason
  (no Windows service wrapper exists in this tree). Manual
  `vaultd.mjs serve` under an owner's service host remains the path.

### Standalone tree
- **Inspected, NOT modified.** It ships no installer or service
  surface at all, so the default cannot be "applied" there without
  inventing a new installer for an already-shipped v1.0.0. Per the
  task's own rule, this is documented instead of forced: a future
  standalone version that gains an installer should adopt the same
  default (LaunchDaemon-first on macOS) at that time.

## Verification (light, by design — the 431 battery was NOT run)

Commands run on this VM against the local tree:

- `bash -n mac/install-armor.sh` → OK
- `bash -n mac/install-daemon.sh` → OK
- `bash mac/install-daemon.sh --render-only --owner-user tester
  --owner-home /tmp/fakehome --node-bin $(command -v node)
  --repo-dir ~/workspace/scripture-armor-v2` → rendered plist parsed
  with Python `plistlib`: Label correct, `RunAtLoad=true`,
  `KeepAlive=true`, `UserName=tester`, ProgramArguments =
  node → `vaultd.mjs serve --identity-dir … --socket …`,
  HOME env = owner home, log path correct. **PASS**
- Same render with `--mode agent` → plist parses, `UserName` absent,
  `RunAtLoad`/`KeepAlive` present. **PASS**
- README greps confirm the new section, the NOT IMPLEMENTED rows, and
  the opt-out flags are in the shipped text.

Not verified here: an actual macOS install run (no Mac in this VM) —
the scripts target the same launchd shape already proven live on
Robbie's Mac (same label, daemon mechanics, agent-backup behavior),
and the helper's render path is the part exercised above.

## NOT DONE / NOT PUSHED

- **NOT PUSHED anywhere.** No GitHub writes, no public-repo changes.
  Robbie's tap gates any push of this change.
- **NOT DONE:** Linux systemd default (not implemented — reason
  above). Windows service default (not implemented — reason above).
- **NOT DONE:** standalone tree changes (documented decision above).
- **NOT DONE:** a live macOS install/boot test of the new scripts —
  closes on the next real Mac install (Robbie's Mac already runs the
  equivalent daemon, installed 2026-10-25; its across-reboot proof is
  still the standing open item from that install).
- **NOT DONE:** full test battery — deliberately skipped to keep CPU
  light beside the Kingmaker gauntlet; no product code changed, and
  the changed surface (shell + plist + docs) is covered by the syntax
  and render checks above.
