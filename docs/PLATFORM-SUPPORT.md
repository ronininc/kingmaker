# Kingmaker platform support and release evidence

Kingmaker has a shared governed runtime and platform-specific surfaces. Native app support and portable runtime availability are different acceptance claims.

| Platform | Availability and requirements | Acceptance boundary |
|---|---|---|
| Apple silicon macOS | Native app/installer target; macOS 14+, macOS 15+ for the current accessibility app-control adapter | A release requires its complete signed runtime and fresh install/launch acceptance. |
| Windows x64 | Governed runtime installer candidate; Node.js 22+ | Native UI, voice, credential-store parity and the exact refreshed archive's customer installation remain unverified. |
| Linux x64 | Governed runtime installer candidate; Node.js 22+ | Native UI, voice, credential-store parity and the exact refreshed archive's customer installation remain unverified. |
| Intel macOS / other architectures | No supported native installer established here | Do not infer support from a source checkout. |

## Published platform evidence

The exact release is [v4.4.3-platform-installers.1](https://github.com/ronininc/kingmaker/releases/tag/v4.4.3-platform-installers.1), tied to source commit [d617a7bbe666765b16ff11feef12996f4c839a7e](https://github.com/ronininc/kingmaker/commit/d617a7bbe666765b16ff11feef12996f4c839a7e).

Its assets include `Kingmaker-4.4.3-windows-x64.zip`, `Kingmaker-4.4.3-linux-x64.tar.gz`, their detached signatures, `portable-artifacts.json`, `SHA256SUMS-portable` and the arm64 Launcher DMG. A published archive is evidence of availability, not proof of native feature parity or successful customer installation. This release does not contain a complete Kingmaker macOS Installer+manifest+signature unit. A Launcher DMG is not the Kingmaker app installer.

Use the matching platform artifact and verify its signed metadata and hashes. Do not use GitHub's generic latest-release label as proof that a complete compatible Mac release exists. No immutable release assets are replaced by this documentation change.

## Performance and privacy scope

The reported **145 MB idle, 22 s cold boot and 5 s warm** figures were measured on a specific **8 GB Apple M3 Mac**. They are historical device/profile measurements, not guarantees for every model, current release, Windows or Linux. Local inference keeps inference local; explicitly selected cloud brains and connected services receive the data needed for those requests. Do not interpret local-first as a promise that cloud requests never leave the device.

Kingmaker x Heretic local customization and ordinary hosted assistants are separate paths. Hosted assistants do not expose their weights. In the recovered development source, the new governed cloud consultation route is verified in local synthetic source tests; this does not establish its presence in this branch or a published binary, and installed adoption and real provider/CLI compatibility are not yet verified. Local Heretic execution remains gated pending reviewed runtime and resource/authorization integration.
