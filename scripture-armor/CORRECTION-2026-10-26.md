# CORRECTION — 2026-10-26: the minted Linux installer, corrected against the original Solomon pattern

**Why this file exists.** The multiplatform pass
(`MULTIPLATFORM-INSTALLER-REPORT.md`) concluded from its harvest
that no systemd unit existed anywhere in the ecosystem and minted
the Linux unit by translating the macOS LaunchDaemon plist. That
conclusion was wrong. The service-material sweep
(`~/workspace/service-material-sweep-2026-10-26/REPORT.md`) found
the original pattern — `solomon.service`, `solomon-user.service`,
`install-server.sh` (TSS `desktop/linux/`, byte-identical copies at
`~/workspace/kingmaker-engine-build/src-private/solomon/desktop/
linux/`) — sitting at depth 6 inside this workspace, just outside
both earlier searches' scopes. Robbie was right that the pattern
existed. This pass corrects the minted Linux files against the
original. **Local tree only — no GitHub writes, no pushes.**
Windows and macOS files untouched (the sweep found no original
registration pattern for either; the minted work there stands).

## What changed, per file

| File | Change |
|---|---|
| `linux/scripture-vaultd.service` | REWRITTEN as the corrected system unit: Solomon's grammar adopted (see below), placeholders now `__OWNER_USER__` + the shared set (the mode-switch `__USER_ENTRY__`/`__WANTEDBY_ENTRY__` placeholders are gone — system and user are separate templates now). Every divergence from `solomon.service` is annotated in the unit header with its reason. |
| `linux/scripture-vaultd-user.service` | NEW — the per-user twin as a first-class template (previously one template rendered in two modes). Follows `solomon-user.service`: same health gate + restart discipline, no hardening block, and the install recipe — including `loginctl enable-linger` for boot start — in its own header. |
| `linux/install-daemon.sh` | Template selected per mode (system vs user file). New `verify_started()` step in both modes, mirroring `install-server.sh` step 4: the unit must be active AND vaultd's own status call must answer as the owner (`runuser`/`sudo -u` probe with bounded retries); failure names the journal command and exits 1. Service/user `restart` failures are now explicit errors with the journal hint instead of a silent `||`-chain. |
| `linux/install-armor.sh` | Header only: the `--user-service` description now names the twin unit file and the linger condition. Behavior unchanged. |
| `vaultd.mjs` | Scoped daemon change, required by the correction: `serve()`'s two configuration-class startup refusals — non-private socket directory, and no identity in the store — now exit **78 (EX_CONFIG)** instead of 1, with comments naming the contract. Without this, the units' `RestartPreventExitStatus=78` would have been decorative. No other exit path touched (no test in the tree asserts these codes — checked). |
| `README.md` | Linux platform-table row now states the hardening + health gate + twin and the correction against `solomon.service`; the Linux opt-out bullet names the twin unit; Files table gained the `scripture-vaultd-user.service` row and corrected daemon-installer/unit descriptions. |

## Adopted from solomon.service vs deliberately diverged

**Adopted (system unit):** `Type=exec`; health-gated start —
`ExecStartPost` polls vaultd's own owner status call (the daemon's
status answer is the "started" proof, Solomon's `--wait-healthy`
discipline with vaultd's probe — a 30×1s poll loop inside the post
command, since vaultd's status call itself does not wait);
`TimeoutStartSec`; `Restart=always` + `RestartSec=5` (Solomon's
value, replacing the plist-derived 10); `RestartPreventExitStatus=
78` (made real by the `vaultd.mjs` change above); `KillMode=mixed`;
`TimeoutStopSec=30`; `LimitNOFILE=65536`; `After/Wants=
network-online.target`; the hardening subset compatible with
home-bound state: `NoNewPrivileges`, `PrivateTmp`,
`ProtectSystem=full`, `ProtectControlGroups`,
`ProtectKernelModules`, `ProtectKernelTunables`,
`RestrictSUIDSGID`, `LockPersonality`. **Twin discipline:** two
first-class unit files; the user twin carries the health gate and
restart discipline and no hardening block, exactly as
`solomon-user.service` relates to `solomon.service`, and documents
its own linger recipe.

**Deliberately diverged (reason recorded in the unit header too):**
- `User=` is the **owner**, not a dedicated service account, and
  there is no `StateDirectory`/`EnvironmentFile` — vaultd is
  owner-bound by design: its identity and owner token live in the
  owner's identity store (`~/.scripture-armor`), not `/var/lib`.
  Solomon's service-account model does not transfer.
- **`ProtectHome` is the one hardening line NOT adopted:** it
  would hide the identity store under `$HOME` from the daemon.
  (`ProtectSystem=full` leaves `$HOME` writable, which the store
  requires.)
- `TimeoutStartSec=60`, not Solomon's 330: vaultd's start is
  model-free and fast; 330s bought Solomon's health poll against
  a model-serving runtime. The gate's semantics are unchanged.
- Log destination stays the owner's log file
  (`StandardOutput=append:`), mirroring the macOS daemon, rather
  than Solomon's journal-only logging.
- Kept armor-specific, no Solomon counterpart: the designated-
  host sleep-target masking, the printed-changes discipline, the
  backup-never-delete user-unit migration, the explicit
  `--user-service`/`--no-daemon` opt-outs.

## Verification (same standard as the minted pass; full battery NOT run — the Kingmaker gauntlet shares this box)

- `bash -n linux/install-armor.sh` → OK; `bash -n linux/install-daemon.sh` → OK; `node --check vaultd.mjs` → OK.
- Renders: `linux/install-daemon.sh --render-only --mode service …` and `--mode user …` both render the correct template with the owner's values.
- `systemd-analyze verify` on **both** rendered units → **exit 0**, no complaints against either unit (host warnings concern unrelated VM units, as before).
- **Live ExecStart proof:** throwaway identity created
  (`node armor.mjs identity --identity-dir /tmp/sa-corr-id`, exit
  0); vaultd started under the corrected system unit's **exact**
  rendered `ExecStart` line; the unit's **exact `ExecStartPost`
  line run verbatim exited 0** (the health gate answered); a
  direct status call returned `{"ok":true,…,"registry_integrity":
  "ok",…}`. Daemon stopped, throwaway identity deleted — no
  proof process left running.
- **Exit-78 proof:** `vaultd.mjs serve` against an empty identity
  dir now exits **78** (previously 1) — the configuration refusal
  the units refuse to restart-loop.

## NOT DONE / NOT PUSHED

- **NOT PUSHED anywhere.** No GitHub writes. Production main
  (`b5546b26`) still carries the pre-correction README text and
  no Linux installer; merging this correction is a separate,
  Robbie-gated push, same as before.
- **NOT DONE:** a live `systemctl` install of the corrected units
  on this VM (deliberately — no system service installs on the
  shared gauntlet box). The evidence carried is the render +
  systemd's verifier + the live ExecStart/health-gate/status
  proofs above.
- **NOT DONE:** the full test battery (CPU discipline beside the
  gauntlet). The only product-code change is the two serve-startup
  exit codes; greps confirm no test asserts them.
