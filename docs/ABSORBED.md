# What Kingmaker absorbed

This is the record of open projects Kingmaker studied in order to improve its own architecture and testing (the owner,
2026-10-15: "absorb from it what we can to make kingmaker better"). They are listed in `core/pack.json` under
`stacks.engineering`.
- **Nothing here ships.** Kingmaker re-implements each idea in its own code.
- **GPL projects give ideas only.** Their code, prompts and text never enter Kingmaker.
- **How each project was read:** each was read at the commit shown in the table. REA (`lib/rea.mjs`) read it first,
  and nothing in it was run.

| Project | Commit | Licence | REA as a connector | Why it was read |
|---|---|---|---|---|
| [allenai/olmo-core](https://github.com/allenai/olmo-core) | 5f6f58a, 2026-10-02 | Apache-2.0 | clean | Training and testing discipline at scale |
| [tinyhumansai/openhuman](https://github.com/tinyhumansai/openhuman) | 056134c, 2026-10-16 | GPL-3.0-only | rejected | The closest product: desktop agent, phone, onboarding |
| [open-jarvis/openjarvis](https://github.com/open-jarvis/openjarvis) | b94a9b2, 2026-10-15 | Apache-2.0 | rejected | Local models on personal hardware, runtime security, evals |
| [agentscope-ai/QwenPaw](https://github.com/agentscope-ai/QwenPaw) | df035cb, 2026-10-16 | Apache-2.0 | rejected | Skill scanning, governance policy, channels |

**Why three were rejected.** The rejections come from installers that pipe `curl` into `sh`.

**REA's own false positives.** REA also counted security code that lists credential paths in order to *deny* them as
reading credentials. Examples are OpenJarvis's `file_policy.py` and QwenPaw's `policy.py`, and REA's own
`sandboxProfile`. That is a false positive in REA, listed under "next" below.

## Taken now

- **Bench provenance** (olmo-core's `ConfigSaverCallback`).
  - Every bench file now records Kingmaker's version, the checkout's commit and branch, and the cool-down, so a
    result can be traced to the code that produced it.
  - The commit is read from `.git`'s files, never by running `git`, because on a Mac without the developer tools
    `/usr/bin/git` opens an install dialog.
  - Code: `lib/model-bench.mjs` `benchProvenance`.
- **A connected CLI no longer inherits Kingmaker's environment** (OpenJarvis `security/subprocess_sandbox.py`).
  - Until now every connector, a "clean" one included, was started with Kingmaker's whole `process.env`. That meant
    any API key, the update token or the vault key. The connector's own saved `env` was never passed.
  - It now gets the system's variables (PATH, HOME, locale, proxy) plus its own values. It also runs in its own
    process group, so a timeout ends everything it started, not just the first process.
  - Code: `lib/connectors.mjs` `connectorEnv` and `runConnector`.

- **REA, hardened** (QwenPaw `skill_scanner` signatures and content-hash whitelist, `governance/policy.py` deny paths;
  OpenJarvis's SDK analytics). Code: `lib/rea-rules.mjs`, `lib/rea.mjs`, `lib/connectors.mjs`.
  - **Rules as data.** The rules live in `lib/rea-rules.mjs` (id, kind, fix, severity, patterns, what makes a match an
    act, what makes it a mention). Every finding has an id, `rule:file:line`.
  - **Fewer false positives.** A credential path counts only when the line reads it (`readFileSync`, `open(`, `cat`,
    `cp`, `security find-…`) or builds a home path to it. A path named in a deny list, or in a rule's own source, is a
    note. A trailing comment can't turn a read into a deny list. REA no longer flags itself, OpenJarvis's
    `file_policy.py` or QwenPaw's `policy.py` (credential findings: 11 and 12 before, 0 now).
  - **Every folder is read.** `docs/`, `tests/`, `examples/`, `dist/` and `build/` were skipped, so a payload imported
    from there went unread. In a program's docs and tests (folders, `*_tests.rs`, `test_*.py`, `*.test.mjs`) only what
    the sandbox can't take away still counts; the rest are notes there.
  - **Re-read on change.** A connector keeps its code's SHA-256 and a cheap stamp. Before a CLI runs, a moved stamp
    means REA reads it again, and the new verdict holds from that run. A connector saved before this is read once.
  - **The owner can clear a finding REA got wrong**: the engine command `connector-allow <id> <finding id>` (the bar
    doesn't show a button for it yet). The acknowledgement is bound to the code's hash, so any change brings the finding
    back. Only what the sandbox could take away can be cleared: a download-and-run or hidden code stays rejected.
  - **New rules:** analytics SDK imports (PostHog, Sentry, Mixpanel, Segment, Amplitude, RudderStack), and a skill
    telling the model to hide what it does from the owner (`concealment`, rejected).
  - **The sandbox denies more:** `~/.kube`, `~/.config/gcloud`, `~/.azure`, `~/.git-credentials`, `~/.npmrc`,
    `~/.pypirc`, `~/.vault-token`, `~/.docker/config.json`, `~/.claude`, `~/.codex`, shell histories, Firefox.

- **Agent-behaviour tests, tier 1** (OpenHuman's scripted-upstream tests, OpenJarvis `tests/agents/fake_engine.py`).
  `test/fixtures/fake-ollama.mjs` is a stand-in for Ollama on a loopback port: it answers from a script and keeps
  every request. `test/agent-lanes.test.mjs` drives the real router, two-step tool call, connector lane and write lane
  against it and checks what Kingmaker *sent*: the schema a reply is held to, the tools shown, how many calls, what
  happens on a made-up lane or tool, a broken reply or a server error. No model, no network.
- **A loop that's stuck stops** (OpenJarvis `agents/loop_guard.py`). `lib/iphone-bridge.mjs` `loopStuck`: the same step
  three times running, A-B-A-B back and forth, or three steps in a row that changed nothing. Each stop says why.
- **A stable system prompt for local models** (OpenHuman's cacheable prefix). `lib/instructions.mjs` `conductParts`
  splits the owner's settings: what holds every turn goes in the system message (`lib/local-turn.mjs`), and only the
  sections picked for this turn's words ride with the turn. The system message is now byte-for-byte the same turn after
  turn, so Ollama reuses what it read of it. It only changed per turn when instructions passed 6,000 characters or
  guardrails 8,000. The bench now records prefill (`promptTokens`, `promptMs`) and `prefix.reusedPct`: how much of a
  repeated brief the model had to read again.
- **First-run walkthrough** (OpenHuman `components/walkthrough/`, ideas only). `lib/first-run.mjs` and the bar's
  `TourController`: the bar dims all but one control, lit in its accent, with a card beside it.
  - Three steps: Microphone, Accessibility and Screen Recording, each with its live state and its own Turn on; say the
    wake word (it ticks itself when heard); three things to ask, one click puts one in the box.
  - Shown once (`firstrun.json`); again from the logo's menu (Show the Tour), `kingmaker://tour` or `kingmaker tour`.
  - The phone app has its own three-step first-open tour (the text box, Call, sharing and calls), once per phone, again
    with `?tour`.

## Next, ranked

These are short to do and close real gaps. Each names where the idea came from.

1. **Credential paths at run time** (OpenJarvis `file_policy.py`). REA checks code when it connects and when it
   changes; a "clean" CLI still runs with arguments the local model chose. Check every model-chosen path argument,
   after following symlinks, against REA's credential list. Or always apply the baseline deny profile, so that "clean"
   only means the network stays open: that one changes the owner's "clean runs as itself" rule and is the owner's call.
2. **Check a connector's answer against what actually ran** (OpenHuman `turn_checkpoint.rs`).
   - The connector lane's closing summary sees the exit code and output.
   - A schema-forced ACCEPT/REJECT check confirms the summary matches what ran.
   - On a reject, Kingmaker says a line built from the record instead ("ran X, exit 1: …").
3. **A statistically honest bench** (OpenJarvis `bench/_stats.py`, ToolCall-15's categories).
   - Speed from 5 samples after a warm-up (p50/p95/std), not one.
   - Tool cases where the first tool returns an error, plus a distractor case and a parallel case, written in
     Kingmaker's own business words.
4. **Phone pairing that expires** (OpenHuman device pairing). The pairing link and six-digit code in
   `lib/phone-companion.mjs` rotate after a use or 5 wrong tries, but they never expire. Give them a 10-minute
   lifetime, and show last-seen for each paired phone.

## Bigger, each its own piece of work

- **Install in stages** (OpenJarvis `scripts/install/install.sh` staged steps; OpenHuman "models are the user's").
  - Kingmaker opens with the app, the wake word and the smallest model.
  - The 17 GB library and the bigger models arrive afterwards, each as its own journaled step, with "ready, still
    fetching X" in the bar.
  - This changes the owner's "nothing half-installed" rule.
- **Agent-behaviour tests, tier 2** (OpenHuman `docs/prompt-evals.md`). `kingmaker eval` with `cases.json` (expected
  and forbidden calls, repeat caps, a reply pattern) on real local models, never in CI, one row per run. Tier 1 is done.
- **One policy evaluator** (QwenPaw `GovernancePolicy.evaluate`).
  - `lib/policy.mjs` `evaluate({ tool, target, connector }) → allow | ask | deny | sandbox`, with builtin rules plus
    the owner's, and an append-only audit.
  - It replaces the separate gates in the connector, iPhone and MCP paths. "Approve exact" is the default, and a rule
    is never widened by a model.
- **A doctor that fixes** (QwenPaw `doctor_fix_runner.py`, OpenJarvis `doctor --json`).
  - `lib/doctor.mjs` holds pure checks (`{ id, ok, label, fix }`) and backs `kingmaker doctor --json`.
  - `doctor fix` runs only a fixed list of safe repairs: restart Ollama, re-pull a pinned model, rebuild the index,
    re-trust the local CA.
  - The bar and the installer read the same checks.
- **Signed update manifest** (OpenHuman `app_update.rs`). The engine's sha256 comes from the same `latest.json` as the
  engine. Sign `latest.json` with Ed25519 (node:crypto), pin the public key in the app, and retry only network errors.
- **Measured profiles on real Macs** (OpenJarvis `learning/routing/learned_router.py`). `lib/token-meter.mjs` already
  logs every call. A periodic check compares real decode speed and failures per role with the profile's estimate, and
  suggests the class below when a Mac is slower or swapping.

## Not taken, and why

- **Hosted memory and account-first sign-in** (OpenHuman's CortexDB). They break local-first.
- **A hosted pairing relay** (OpenHuman). Kingmaker has no hosted service. If the phone needs to work away from home,
  the owner's own Tailscale is the better path.
- **JSON-in-tag tool calls for Ollama** (OpenHuman). Kingmaker's schema-forced pick-then-arguments (`lib/tool-call.mjs`)
  is better for 3–4B models.
- **OpenJarvis's model picks:** an unmeasured 4-row RAM table that counts total RAM as GPU memory.
  `lib/mac-profiles.mjs` and `lib/model-bench.mjs` already measure.
- **QwenPaw's scanner engine.**
  - Its rules never reach `.mjs`, `.swift` or `.applescript` files, and several of its rules never fire.
  - It lets an install through on a timeout and warns by default.
  - REA's fail-closed verdict and its sandbox-instead-of-reject model stay.
- **LLM-widened approval rules** (QwenPaw `generalize.py`). These are risky with small local models.
- **Product analytics** (QwenPaw opt-out, OpenJarvis opt-in to a raw-IP host). Kingmaker adds none.
- **Install habits:** `curl | sh`, unpinned `ollama pull`, editing `~/.zshrc`, and unsigned apps with `xattr -cr`
  advice. Kingmaker pins sha256s and digests.
- **Breadth:** 30 channels, 15 engines, crypto mining, a second Rust copy of the security code that has already
  drifted. The lesson Kingmaker keeps is to have one implementation of each thing.
- **olmo-core itself:** a PyTorch/CUDA training library, not a stock-Mac tool.
  - What Kingmaker keeps from it is a method: tests gated on what the machine has, and a saved config with every run.
  - Kingmaker already skips tests by capability (`{ skip: !tools.ffmpeg && … }`).
  - **Its models:** the OLMo models it trains are already in the Hugging Bay catalog (`catalog/huggingbay.json`,
    e.g. OLMo 3 7B Instruct). As fully open models (weights, data and code), they are candidates for a later bench
    round.
