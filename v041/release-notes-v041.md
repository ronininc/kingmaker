# Kingmaker 0.4.1

A leaner install, a knowledge library that fits your disk, and the folded stack — seventeen governed components, verified before they shipped.

## What's new

- **Your disk, your call.** 4.0 baked the full knowledge library into every install, whether it fit or not. The 4.1 installer asks first: *download everything* up front, or *stream the library later*. The choice is a setting, not a commitment — switch anytime. Streamed corpora arrive in the background, signature-verified and resumable, and a complete on-disk library is always used as-is.
- **Right-sized installs.** Pick the model pack that matches your machine, from 8 GB to 64 GB tiers. The core system lands at about 4.5 GB before models — the library (23 corpora, ~18 GB) and the models are now your decision, not the installer's.
- **The folded stack.** Seventeen governed components now ship inside Kingmaker: cost-aware model routing over an audit chain, output verification, a training-data pipeline, document and content tooling, fabrication design, and a hardened, sandboxed research lane. Every component passed verification (353 checks) before it earned its place.
- **Skills, front and center.** 170+ built-in skills ship in the box — research, writing, code, media, business operations, and more — each one permission-gated and auditable.
- **Same key, same trust.** The release manifest is signed with the Kingmaker Release key, unchanged from 4.0 — fingerprint `A689 DD94 00E8 F7B2 563C 1C88 6B20 BA39 4CA6 68E4 A734 8EF7 05AC 5F48 2AB8 E182`. Every part carries a SHA-256 in the signed manifest and in `SHA256SUMS`.

## Install

1. Download `Kingmaker-Installer-v0.4.1.dmg` and open it.
2. Run the installer. It verifies the manifest signature, then asks two questions: your model pack and your library delivery (download everything, or stream later — the installer shows both sizes against your free space).
3. First open on a Mac that didn't build it: right-click the installer and choose **Open** once. The installer is ad hoc signed and not notarized — same posture as 4.0.
4. Installed Macs enroll for updates automatically.

## Requirements

- Apple Silicon Mac, macOS 14 or later
- Free space: ~5 GB for the core system, plus your chosen model pack (5–39 GB) and, if you download it up front, the ~18 GB library

## Included

- Kingmaker 0.4.1 (engine build 15f2c0ec) — 8 archive parts, 2.33 GB total
- Ronin Launcher 0.3.1
- Signed manifest + `SHA256SUMS`
