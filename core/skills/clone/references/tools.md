# Clone's external tools: Ghidra, Aider, TokenRing

These three are large, actively-developed tools. Clone drives them; it does not vendor
them. Each install is an owner-approved step (Kingmaker's setup screen), and each keeps
Kingmaker's gates on anything that sends, pays, publishes, or changes config.

## Ghidra — native decompiler (Apache-2.0)

- Upstream: https://github.com/NationalSecurityAgency/ghidra — a software reverse
  engineering (SRE) framework: disassembler, decompiler, scriptable analysis.
- Role: REA uses Ghidra for native binaries. Static JavaScript, Electron, or packaged
  targets do **not** need it (see REA's references).
- Install: a release build from the upstream releases page, or `brew install ghidra`.
  It needs a JDK (Ghidra ships its own on recent releases). Headless analysis runs
  through `support/analyzeHeadless`; REA finds it on PATH or at the configured location.
- Bring-your-own: Ghidra (and, for Android, JADX/Java) are prerequisites REA reports as
  missing when a task needs them, rather than bundling them.

## Aider — AI pair programming in the terminal (Apache-2.0)

- Upstream: https://github.com/Aider-AI/aider — edits a git repo with an LLM, one change
  at a time, with a commit per edit and tests in the loop.
- Role: the rebuild step. After REA explains the behaviour and CLI-Anything lets you
  exercise it, Aider writes the reconstruction against a fresh repo.
- Install: `python -m pip install aider-install && aider-install`, or `pipx install
  aider-chat`. It uses whatever model you point it at; on this Mac, prefer a local model
  (Ollama) so nothing leaves the machine, or an owner-approved key from the vault.
- Gate: Aider writes files and makes commits in its target repo — that is its job, in a
  repo you chose. It never pushes or publishes without the owner's go.

## TokenRing — the agent framework (MIT)

- Upstream: https://github.com/tokenring-ai/monorepo (the ecosystem) and
  https://github.com/tokenring-ai/agent (the core agent library).
- Role: when a clone needs a durable agent — one that plans, keeps memory, and uses
  several tools over time — rather than a single Aider session. ModelRegistry picks the
  model; its services and tools give the agent its hands.
- Install: the packages are published under the `@tokenring-ai/*` scope (npm, MIT). Add
  only the packages a job needs (e.g. `agent`, `ai-client`, `cli`).
- Gate: a TokenRing agent runs under Kingmaker's governance like any other — its
  outbound, money, credential, and publish steps wait for the owner's word.

## Why these aren't vendored

Ghidra is hundreds of MB of Java; Aider and TokenRing track fast-moving upstreams. A
frozen copy would rot and bloat the app. Clone ships the small, stable methodology (REA
and CLI-Anything, which are prompt-and-reference skills) and points at these three for
install, so each is always the version the owner approved.
