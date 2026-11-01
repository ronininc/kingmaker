# MULTIPLATFORM-INSTALLER-REPORT — Linux + Windows armor installers at parity

> **CORRECTION NOTICE (2026-10-26, later the same day):** this
> report's Step 1 harvest conclusion — that no systemd unit
> existed anywhere in the ecosystem — was **wrong for Linux**.
> The service-material sweep found the original pattern
> (Solomon's `solomon.service` set, TSS `desktop/linux/`) inside
> this workspace at a depth both searches missed, and the minted
> Linux installer has been corrected against it. See
> **CORRECTION-2026-10-26.md** in this tree for what changed and
> why. The Windows and macOS conclusions below stand as written.

Order: Robbie, 2026-10-26 — build the Linux + Windows installers to
parity with the macOS one; his reasoning: "It shouldn't even be new
work" — harvest the ecosystem's existing patterns, don't invent.
Scope: LOCAL tree only (`~/workspace/scripture-armor-v2/`). Nothing
pushed, nothing published. Robbie's tap gates any production merge,
same as the macOS one.

Parity spec: `mac/install-armor.sh`, `mac/install-daemon.sh`,
`mac/org.ronininc.scripture-vaultd.plist`, and the README *Default
install posture* section — i.e. standard install = identity → boot-
level always-on vaultd; every system change printed as it happens;
sleep protection only behind `--designated-host`; labeled opt-outs
(fallback posture / no daemon).

## STEP 1 — Harvest: what already existed, and what each file is minted from

Surveyed before writing anything:

- **The only service registration in the entire ecosystem is the
  macOS LaunchDaemon** just merged to production
  (`ronininc/scripture-armor` main `b5546b26`; local copies in
  `mac/`). No systemd unit, no Windows service, no scheduled-task
  registration exists anywhere in the Kingmaker packaging — the
  engine's own posture is user-level install + a launcher command
  (`kingmaker`, `node launch.mjs`), never a boot service. Greps for
  `systemctl|systemd|New-Service|sc.exe|schtasks|
  Register-ScheduledTask|WinSW|nssm|node-windows|csc.exe` across
  `kingmaker-engine-build/src-private/{lib,scripts,bin}`,
  `pkg43-{linux,windows}/launch`, and `pkg43-windows/surface/
  armor-wsl` returned **zero service-registration hits**.
- **Linux installer shape** — harvested from the shipped Kingmaker
  Linux unit installer (`kingmaker-engine-build/pkg43-linux/
  install.sh`, RC2): POSIX-style disciplined shell, idempotent,
  step-narrated output, node-runtime resolution, "no silent system
  changes" ethos.
- **Windows installer shape** — harvested from the shipped Kingmaker
  Windows unit installer (`pkg43-windows/install.ps1`, RC2):
  `$ErrorActionPreference = 'Stop'`, `%LOCALAPPDATA%`-era dest
  conventions, `Write-Host` step narration, hashed/verified payload
  discipline; and from `pkg43-windows/launch/Launch-Windows.ps1`:
  the detect → install → launch door shape and the
  `-ExecutionPolicy Bypass -File` invocation line.
- **Windows cell precedent** — `pkg43-windows/surface/armor-wsl/
  armor-cell-wsl.ps1`: detect-and-report-first, owner steps printed
  rather than taken silently.
- **Ronin Launcher** — the local catalog copy
  (`kingmaker-engine-build/catalog-push/catalog/apps.json`) lists
  Scripture Armor as "ships through Kingmaker — no installer, one
  command: `node launch.mjs`" on all three platforms; the launcher
  carries **no per-platform service material** to harvest.
- **Windows service-host search came up empty on purpose:** stock
  Windows cannot host a Node script as a true SCM service without a
  service-host binary, and none (WinSW / NSSM / node-windows) ships
  in this ecosystem. The Windows default is therefore a **Task
  Scheduler boot task (AtStartup trigger, S4U principal)** — the
  mechanism the platform actually provides that delivers the same
  posture: starts at boot before any login, runs as the owner, no
  stored password, restart-on-failure without limit. The difference
  is stated in the script header and the README, never disguised.
- **A second Windows fact, found in the daemon itself:**
  `vaultd.mjs` has **no Windows transport path** — its control
  channel is a Unix-domain socket path and there is no named-pipe
  handling in the file (grep `win32|pipe|platform`: no platform
  code). The Windows installer is labeled accordingly (below).

### Source pattern per new file

| New file | Minted from |
|---|---|
| `linux/scripture-vaultd.service` | `mac/org.ronininc.scripture-vaultd.plist`, field for field: label/name, owner `User=` (the plist's `UserName`), `ExecStart` = the plist's ProgramArguments verbatim (`node vaultd.mjs serve --identity-dir … --socket …/vaultd.sock`), `WorkingDirectory`, `HOME`/`PATH` env, boot start (`WantedBy=multi-user.target` ≙ `RunAtLoad`), keep-alive (`Restart=always` + `RestartSec=10` ≙ `KeepAlive` + `ThrottleInterval 10`), log file ≙ `StandardOutPath`/`StandardErrorPath`. Placeholder/render discipline copied from the plist template. |
| `linux/install-daemon.sh` | `mac/install-daemon.sh`, structure for structure: same flags (`--mode`, `--designated-host`, `--owner-user/-home`, `--node-bin`, `--repo-dir`, `--identity-dir`, `--render-only`), same sed-render + `--render-only` path, same printed-changes narration, same identity-dir (0700) + log ensuring with owner chown, same **backup-never-delete migration** (a pre-existing per-user unit is disabled and moved to a `.user-unit-backup`, cf. the plist's `.agent-backup`), same sudo/root split (helper must run as root for the system path; standard installer sudo's only that step). Platform-native deltas: systemd commands for launchctl's, and designated-host = **mask the systemd sleep targets** (`sleep.target suspend.target hibernate.target hybrid-sleep.target`) — the standard systemd mechanism, cf. `pmset -a disablesleep 1` — with the unmask revert printed. |
| `linux/install-armor.sh` | `mac/install-armor.sh`, nearly line for line: refuse-root guard, repo location (tree-relative, then `~/scripture-armor`), Node ≥ 24 gate with the same wording, identity create/load, daemon step via the helper with loud failure + named fallbacks. Flag parity: `--designated-host`, `--no-daemon`, and the fallback as `--user-service` (alias `--user-agent`); `SCRIPTURE_ARMOR_DAEMON` accepts `service|user|off` and maps the macOS values `daemon|agent` to the same three postures so the env var means the same thing on every platform. |
| `windows/install-armor.ps1` | Two parents: the **flow and discipline of `mac/install-armor.sh`** (mode resolution incl. the shared `SCRIPTURE_ARMOR_DAEMON` vocabulary, refuse-to-run-unprivileged for the system step — here: elevation check with the exact elevated re-run command printed — repo location, Node ≥ 24 gate, identity step, printed migration of the fallback registration, designated-host printing + revert, opt-out text) rendered in the **house PowerShell shape of `pkg43-windows/install.ps1` + `Launch-Windows.ps1`** (`$ErrorActionPreference='Stop'`, `Write-Host` narration, owner-profile paths, Bypass invocation line). Registration mechanics are Task Scheduler cmdlets (`New-ScheduledTaskAction/Trigger/Principal/SettingsSet`, `Register-ScheduledTask`) — no harvested pattern existed; S4U principal chosen so the boot task runs as the owner **without storing a password**, mirroring why the LaunchDaemon runs as the owner user. Designated host = `powercfg /change standby-timeout-ac 0` + `hibernate-timeout-ac 0`, with a best-effort read of the previous standby value for the printed revert. Fallback migration mirrors mac: the old logon task is **exported to an XML backup** (`-Encoding Unicode`, matching Task Scheduler's export declaration) and only then unregistered. Pure-ASCII, PowerShell 5.1-conservative syntax (5.1 misreads non-ASCII in no-BOM files). |

## Files created / changed (all in `scripture-armor-v2/`)

| File | Change |
|---|---|
| `linux/scripture-vaultd.service` | NEW — systemd unit template (placeholders rendered by the helper; `__USER_ENTRY__` present only in system mode, `__WANTEDBY_ENTRY__` = `multi-user.target` / `default.target` per mode — the direct analog of the plist's `__USERNAME_ENTRY__` trick). |
| `linux/install-daemon.sh` | NEW — renders + installs the unit: system service by default (install to `/etc/systemd/system`, daemon-reload, enable, start; user-unit migration; designated-host sleep-target masking), per-user unit only in explicit fallback mode (with the linger caveat printed). `--render-only` supported. Fails loudly with a named manual fallback on a non-systemd host. |
| `linux/install-armor.sh` | NEW — the standard Linux install: identity, then the default always-on service via sudo'd helper; `--user-service` / `--no-daemon` opt-outs. |
| `windows/install-armor.ps1` | NEW — the standard Windows install: identity, then the default boot task (elevated), `-UserTask` logon fallback, `-NoDaemon` opt-out, `-DesignatedHost` powercfg posture. Header + runtime output carry the NOT RUN ON WINDOWS and socket-unverified labels. |
| `README.md` | EDITED — platform table: Linux and Windows rows flipped from NOT IMPLEMENTED to the implemented defaults (Windows row carries the NOT YET RUN label); new **Windows hosting note** (why a boot task, not an SCM service; the two honesty labels); **Designated hosts** gained Linux (systemd mask) and Windows (powercfg) sections; **Opting out** gained Linux and Windows sections with removal + sleep/power reverts; Files table gained 6 rows (the 4 new files + the installed service path + the installed task name). Zero `NOT IMPLEMENTED in this tree` rows remain. |
| `MULTIPLATFORM-INSTALLER-REPORT.md` | NEW — this report. |

No daemon/client code (`vaultd.mjs`, `armor.mjs`, `launch.mjs`,
tests) was touched. The macOS files were not touched.

## Before / after, per platform

### Linux
- **Before:** no service registration existed; `vaultd.mjs serve`
  under the owner's own supervisor, or Kingmaker's `launch.mjs`, was
  the only path (README said NOT IMPLEMENTED).
- **After (default):** `bash linux/install-armor.sh` creates/loads
  the identity, then installs vaultd as a **system systemd
  service** — enabled at boot (`multi-user.target`), before login,
  `Restart=always`, running as the owner user against the owner's
  identity store, surviving logout. A pre-existing per-user unit is
  disabled and its file moved to a `.user-unit-backup` (not
  deleted).
- **Designated host:** `--designated-host` additionally masks
  `sleep.target suspend.target hibernate.target hybrid-sleep.
  target`; printed, with the unmask revert. Without the flag, sleep
  is untouched and the installer says so.
- **Opt-outs:** `--user-service` (per-user unit fallback — starts
  with the user session; at boot only with owner-enabled linger,
  printed in the helper) or `--no-daemon` /
  `SCRIPTURE_ARMOR_DAEMON=off`. Removal commands in the README.

### Windows
- **Before:** no service registration existed; manual `vaultd.mjs
  serve` under an owner's service host was the only path (README
  said NOT IMPLEMENTED).
- **After (default):** `windows\install-armor.ps1` (elevated)
  creates/loads the identity, then registers the
  **`ScriptureArmorVaultd` Task Scheduler boot task** —
  AtStartup trigger, S4U principal running as the owner (no stored
  password), unlimited runtime (`ExecutionTimeLimit` zero),
  restart-on-failure (999 restarts, 1-minute interval),
  starts immediately. A pre-existing fallback logon task is
  exported to an XML backup (not silently deleted) and
  unregistered.
- **Designated host:** `-DesignatedHost` sets the AC standby +
  hibernate timeouts to never via `powercfg`, printing the change
  and — where readable — the previous standby value for the
  revert. Without the flag, the power plan is untouched and the
  installer says so.
- **Opt-outs:** `-UserTask` (AtLogOn fallback task
  `ScriptureArmorVaultdLogon`: starts at login, ends at logoff,
  no elevation needed) or `-NoDaemon` /
  `SCRIPTURE_ARMOR_DAEMON=off`. Removal commands in the README.
- **Labeled, not implied:** NOT RUN ON WINDOWS (no Windows host
  exists here; static review only) and vaultd's socket transport
  on Windows is unverified (see NOT DONE).

### macOS
- Unchanged. The merged production default stands as the spec the
  other two were minted from.

## Verification (light, by design — full battery NOT run; the Kingmaker gauntlet shares this box)

Run on this VM against the local tree:

- `bash -n linux/install-armor.sh` → **OK**
- `bash -n linux/install-daemon.sh` → **OK**
- `bash linux/install-daemon.sh --render-only --owner-user root
  --owner-home /root --node-bin /usr/bin/node --repo-dir
  ~/workspace/scripture-armor-v2` → rendered unit inspected:
  `User=root`, `ExecStart` = the plist's arguments verbatim,
  `Restart=always`, `RestartSec=10`, log path, `WantedBy=
  multi-user.target` all correct.
- `systemd-analyze verify /tmp/scripture-vaultd.service` →
  **exit 0.** (Warnings printed concern other VM units — an
  rsyslog drop-in name mismatch and two stock timers — not this
  unit.)
- Same render with `--mode user` → `User=` correctly absent,
  `WantedBy=default.target`; `systemd-analyze verify` → **exit 0**
  (same unrelated host warnings).
- **ExecStart proof:** throwaway identity created
  (`node armor.mjs identity --identity-dir /tmp/sa-verify-id`,
  exit 0), then vaultd started under the unit's exact ExecStart
  line. The socket appeared (`srw------- …/vaultd.sock`), the
  daemon logged `vaultd listening on /tmp/sa-verify-id/vaultd.sock`,
  and the stock client answered over that socket:
  `node vaultd.mjs status --identity-dir /tmp/sa-verify-id` →
  `{"ok":true,"label":"htch-runtime",…,"uptime_s":3,"pending":0,
  "registry_integrity":"ok",…}`. Daemon stopped and the throwaway
  identity deleted afterward; no `vaultd serve` process left
  running.
- **PowerShell:** `pwsh` / `powershell` are **not present** on
  this VM (`command -v pwsh powershell` → nothing), so no parser
  run was possible. `windows/install-armor.ps1` received a careful
  static pass instead — conservative PS 5.1 syntax throughout,
  pure ASCII, backtick-escapes and string expansions re-checked by
  eye, one defect found and fixed during the pass (task-export
  backup now written `-Encoding Unicode` to match Task
  Scheduler's XML declaration). **Labeled NOT RUN ON WINDOWS** in
  the script header, the README, and this report.
- README greps confirm: 0 remaining `NOT IMPLEMENTED in this
  tree` rows; Linux + Windows rows read "Implemented — the
  default"; the hosting note, designated-host sections, opt-out
  sections, and all 6 new Files rows are in the shipped text.

## NOT DONE / NOT PUSHED

- **NOT PUSHED anywhere.** No GitHub writes of any kind. Robbie's
  tap gates the production merge, exactly as with the macOS
  default.
- **NOT RUN ON WINDOWS:** `windows/install-armor.ps1` has never
  been executed on a Windows host (none is available). First live
  Windows run is the closing proof for that file.
- **NOT VERIFIED — vaultd itself on Windows:** the daemon's
  control socket is a Unix-domain socket path and `vaultd.mjs`
  has no Windows named-pipe handling; whether Node's current
  Windows AF_UNIX support carries vaultd's socket usage is
  untested. If it does not, the daemon — not just the installer —
  needs a Windows transport path before the Windows default can
  be called proven end-to-end. Stated in the script header, the
  installer's own runtime output, and the README.
- **NOT DONE:** an actual Linux *system install* run of
  `linux/install-armor.sh` / `install-daemon.sh --mode service`
  on this VM (deliberately: installing a system service on the
  shared gauntlet box was out of scope). The render, systemd's
  own verifier, and the live ExecStart/status proof above are
  the evidence carried instead; the scripts mirror the macOS
  helper's mechanics, whose live install is already proven on
  Robbie's Mac.
- **NOT DONE:** the standalone tree (`~/workspace/
  scripture-armor-standalone/`) — it ships no installer surface
  on any platform (standing decision from DEFAULT-DAEMON-
  REPORT.md); unchanged here.
- **NOT DONE:** full test battery — deliberately skipped to keep
  CPU light beside the Kingmaker gauntlet; no product code
  changed, and the changed surface (shell + unit + PowerShell +
  docs) is covered by the syntax, render, verifier, and live-
  daemon checks above.
