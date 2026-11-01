# Quarantine risk report

The inspected pin is not classified as malware. It is broad-capability research code and is unsuitable for direct ingestion or execution.

## High-risk capabilities observed

- `src/app/sessions.ts:61-62` gives workers file read/write/edit, Bash, PowerShell, job control, web access, skills, subagents, inter-agent messaging and interruption tools.
- `src/app/sessions.ts:137,152` assigns `danger-full-access` to managed sessions.
- `docs/003-execution.md:27` states workers execute commands without approval as the operator's OS user.
- `docs/003-execution.md:51` permits a configured preparation command to run under `sh`.
- `docs/003-execution.md:80` explicitly says wrappers and directories are not a security boundary and absolute-path execution remains possible.
- `SETUP.md:13,39,51,67-68` covers account creation, CLI sign-in, secrets, repository access, installation, startup and optional auto-merge.
- `cordis.patch.yml:45-117` installs shell, PowerShell, subagent and web tooling for worker presets.
- `scripts/dsh-superagent` writes and unlinks control files and signals processes.
- GitHub and Feishu source adapters can read remote state and deliver replies; the command wrapper invokes authenticated CLIs.

## Omitted from the inert reference

All executable source, scripts, package manifests, dependency locks, setup/deployment instructions, prompts, skills, presets, tool lists, source adapters, credential/account guidance, auto-merge guidance and shell examples are excluded from library content. The original bytes remain in quarantine solely for audit.

## Inspection anchors

- README: `737997cf5b7d4129f12ed5485ebbdd5e9d2ce3859a82ded6ac535d222327b713`
- LICENSE: `6d66f91815b720e18cfb2b3552043a0359236aec9a1a6917787900546f6ce550`
- `src/app/sessions.ts`: `ca2b98e57e9f27b2abb0afab59d44ea744a96d8be4cf81d7b3776901b56cd36b`
- executor tool definitions: `9869d8a5043725847f18814e23b29c11ae93aa974defa72d2eab62c61a6def47`
- command wrapper: `9d7593c5022e0c1813731c1f1cd8471b1536b0b5f42974a08ef2b2930c1e62b2`
- authorization documentation: `85f559708ac7faef89f88fcad30a405ca62a582a15764a7293686071e609dea0`
- execution documentation: `049aa22a717f75b9dec4cd6969356db6f736c127de4501c3ce1f6d846217f6eb`
- SETUP: `75ff78359142dad8bf257b732c1b11313a96c8d1bf0621c73fd4f160460a25ba`
- Cordis preset: `fc9271cdf9b3d96bcb7febffe194f92cb427a88044168f83b3fb7522ab5c9bce`
