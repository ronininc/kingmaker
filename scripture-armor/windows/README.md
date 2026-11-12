# Scripture Armor — Windows builds: the per-version template

Windows is not one target. Microsoft changes the command structure
between Windows versions, so Scripture Armor ships **one build variant
per Windows version family**, and this directory is where that is
declared. The rule of the template:

> Everything that differs between Windows versions is isolated in this
> directory — the manifest below and the installer surface. The daemon
> core (`../vaultd.mjs`, `../armor.mjs`, the shared transport helper
> `../daemon-transport.mjs`) never changes per version.

## The pieces

| Piece | What it is |
|---|---|
| `builds.json` | The per-version manifest (`scripture-armor.windows-builds/1`). One entry per variant: the Windows build-number ranges it targets, and its declared **surface** — transport, daemon host, installer, the command-structure specifics that variant relies on, and the checks only a real host can close. |
| `select-build.mjs` | The device match. Given a Windows build number, it picks the variant whose target range contains it; else the nearest variant at or below it; else it says no build claims the device. Pure function + CLI (`--os-build`, `--json`). |
| `install-armor.ps1` | The installer for the current variant. It persists **no** `--socket` argument in the daemon's Scheduled Task — the daemon's own transport helper decides the endpoint, like every other caller. At install time it runs the device match and prints which variant fits the machine. |

## The distribution model

- Builds are **versioned per Windows version**: a package carries the
  product version plus its variant id (e.g. `1.2.1 / win10-11`).
- The **site serves the latest** build; the **installer device-matches**:
  `select-build.mjs` is the same mechanism on both sides, so the build a
  device is offered is the build that was made for its Windows version,
  pre-selected — the owner never picks from a list of near-identical
  downloads.
- Once this template exists, adding a version is mechanical: the fleet
  can produce the next variant from the manifest alone.

## Adding a Windows version

1. Copy the current variant's entry in `builds.json`. Give it a new
   `id`, set the previous variant's open-ended `maxBuild` to just below
   the new variant's floor, and fill the new entry's `targets`.
2. Fill the new entry's `surface` honestly: what command structure this
   Windows version actually uses (ScheduledTasks form, principal types,
   power policy commands), and any transport or pipe specifics.
3. Adjust `install-armor.ps1` only where the new surface differs; the
   script reads its variant declaration from `builds.json`, so the
   version-specific facts stay data, not code branches.
4. Mark the new entry `current`, demote the old one to `supported`.
   Retire an entry (`status: "retired"`) when its Windows version
   leaves support — the selector never picks a retired variant.
5. Re-run the fixture proofs (`test/daemon-transport.test.mjs`,
   `test/windows-build-select.test.mjs`) and then the host proof
   (WINDOWS-PROOF) for the new variant before it ships. A variant is
   never un-shelved on fixture grade alone.

## Honesty labels

- The transport fix (named pipes) is proven at fixture grade in this
  tree: path selection unit-checked with the platform injected, suites
  at baseline. It has **not** run on a Windows host.
- The host-only rungs are listed per variant in `builds.json`
  (`surface.hostOnlyChecks`): the foreground pipe bind, the pipe DACL
  across the boot-task → interactive-user boundary, boot persistence,
  and the SmartScreen first-run prompt (expected friction on unsigned
  scripts, not a defect).
