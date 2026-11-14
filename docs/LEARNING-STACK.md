# The learning stack

> **What this is.** How Kingmaker gets more capable over time, as four distinct layers plus a governance
> spine. Written 2026-10-17, reality-checked against the code 2026-10-18. Each claim carries an honest status:
> **Built** (runs today), **Partial** (the mechanism exists but is not fully wired into runtime), or
> **Planned** (designed here, not implemented). Where a layer is weaker than it looks, this doc says so — the
> point is an accurate map, not a flattering one.

"Does Kingmaker learn?" is really four questions, because there are four separate machines underneath, each
with its own code, its own store and its own state of done. Conflating them is what makes an outside reader say
"no local model training" and conclude Kingmaker can't learn. It can and does get more capable — but less of it
is automatic today than a first read of the code suggests, and none of it (yet) changes model weights.

| Layer | What it adapts | Where | Status |
|---|---|---|---|
| **1. Brains** | which trained model answers | `lib/profile.mjs`, `lib/models.mjs`, `lib/*-brain.mjs` | **Built** |
| **2. Orchestration / skills** | skills minted & scored; ranking | `lib/rea.mjs`, `lib/absorb.mjs`, `lib/device-scan.mjs` | **Partial** |
| **3. Preference memory** | how the owner likes work done | `lib/learning.mjs`, `lib/personalization.mjs` | **Built** (local); community path **Partial** |
| **4. Weight fine-tuning** | the local model's own weights | `solomon/server/src/runtime/model-improvement-pipeline.ts` | **Planned** (gated descriptor exists) |
| **Governance spine** | keeps every layer from widening authority | `lib/profile.mjs`, `lib/rea.mjs`, `lib/integrity.mjs` | **Built**, with stated limits |

---

## Layer 1 — The brains are already trained — **Built**

Kingmaker does not start from an untrained model. Every role that answers in words is bound to a fully
pretrained model, and the binding is swappable at runtime.

- **Local, default — sized to the Mac** (`lib/profile.mjs`):
  - **8 GB:** the small tier — `qwen3-abliterated` 0.6b (classifier/reflex) and 1.7b (chat / decision / planner /
    draft), 2b for build and vision (`ABLITERATED_MODELS`).
  - **16 GB or more:** `abliteratedModelEnv()` swaps the chat, decision, planner and draft roles to
    **`qwen3-abliterated:8b`** (`ABLITERATED_LARGE_BRAIN`, `LARGE_BRAIN_MIN_GB = 16`) when it's installed. The 8b is
    the real default brain on every supported tier above 8 GB.
  - **Coder, separately:** 1.5b under 16 GB, 7b from 16 GB (`ABLITERATED_CODERS`, `LARGE_CODER_MIN_GB`).
- **External brains, opt-in:** `lib/claude-brain.mjs`, `lib/grok-brain.mjs`, `lib/chatgpt-brain.mjs`, chosen with
  `kingmaker brain <name>`; invoked in bounded headless turns, given only Kingmaker's MCP surface.
- **Integrity:** each Ollama tag's digest is pinned on first use (TOFU); a later upstream change is treated as an
  infection, not a silent upgrade.

**What "learns" here:** nothing in the weights — the training happened upstream. Which brain runs is governed and
measured. Layer 4 is the only thing that would move these weights on-device.

---

## Layer 2 — Orchestration and skill learning — **Partial**

This is the layer that turns "reading and driving things" into getting better. The **minting and scoring**
machinery is built and runs when learning is on; the part that would make a graduated skill actually get
*chosen first* is **not wired into runtime yet**. Stages: **read → map → absorb**.

### 2a. READ — REA (`lib/rea.mjs`) — Built, with two real limits
Before Kingmaker uses a connector whose code it can see, **REA — Reverse Engineer Anything** reads that code and
finds what it would do *unprompted* (phone home, read credentials, persist at login, raise privilege, run
fetched/hidden code), and returns **clean** / **sandboxed** (bad parts denied via `sandboxProfile`) /
**rejected** (`curl | sh`, `eval` of base64 — never connected). Findings carry `rule:file:line`; REA never runs
what it inspects and re-reads on a code-hash change.

Two limits to be honest about:
- **Remote MCP servers aren't read.** A URL-based MCP connector has no local `codePaths`, so `addConnector()`
  records a synthetic `clean` without inspecting server code. REA's guarantee holds for CLIs, repo folders and
  skills — not for a remote MCP server's tools.
- **It fails open past 4,000 files.** `walk()` stops silently at `MAX_FILES` with no truncation recorded, so a
  fetch-and-run path beyond that point in a large tree can still get a clean verdict.
- **CLI-Hub install hooks run before inspection.** `addConnector()` runs a fetched package's own build/setup
  hooks (`pip`/`npm`) *before* REA reads the installed target. That step is sandboxed and given only `SAFE_ENV`
  (no credential read, login persistence or privilege), but the profile still **allows outbound network**, so a
  package can phone home or fetch-and-run *during installation*. REA's pre-use guarantee covers execution of the
  installed target, not the install step — so "fetch-and-run is stopped before it runs" is not absolute here.

### 2b. MAP — the device scan (`lib/device-scan.mjs`) — Built
`kingmaker scan` writes `<runtime home>/device-capabilities.json` (0600): every app and every way Kingmaker can
drive it (its own CLI, a configured MCP server, the engine, AppleScript, links, or the Hands of Horus as
fallback), plus PATH CLIs, package-manager tools, Chrome web-app hosts, and API-key names. A map older than a
week (`MAP_MAX_AGE_MS = 7 days`) is **refreshed on the next start** — there is no weekly background timer, so a
Mac left running keeps a stale map until it next starts.

### 2c. ABSORB — candidate skills, scored (`lib/absorb.mjs`) — Partial
When learning is on, every tool a REA-cleared connector offers becomes a **candidate skill** (an auto-written
`SKILL.md`). Each use is scored and the ledger tracks graduate/retire thresholds (`GRADUATE = runs 3 / window 10
/ minScore 0.8`; `RETIRE = runs 5 / maxScore 0.4 / idleDays 30`). What's real today vs. not:

- **Minting + scoring: built.** The ledger records runs, mean score and latency.
- **Ranking: computed but not used.** `skillBrief()` is the only thing that sorts graduated skills by score and
  latency, and it is **never called at runtime** (only in its unit test). Runtime connector selection still needs
  an exact user-named program, so "reached for first / the faster one leads" is designed, not yet in effect.
- **What a score measures.** For an absorbed connector, `connectorTurn()` runs the generated skill as a plain
  prompt to a local model and `recordUse()` marks the run OK on non-empty text — it does **not** invoke the
  underlying MCP tool. So the scorecard currently reflects model prose, not whether the tool actually worked.
- **Idle retirement is narrower than it sounds.** `sweepIdle()` only retires candidates with no `lastUsed`, so
  the 30-day rule reaches *never-used* candidates. A skill used once and then abandoned stays active unless it
  accumulates failing runs.
- **`GATED` is a finite verb list.** `skillForTool()` adds the owner's-OK step only when the tool name/description
  matches `GATED` (`send|pay|delete|deploy|…`). World-acting tools whose verbs aren't listed (e.g.
  `execute_trade`, `run_command`, `place_order`) are written as read-only — so the owner-OK step is **not**
  universal at the minting layer (the engine's approval boundary, §Governance, is the real backstop).

### 2d. Native extraction and the acquisition loop — Built (tooling)
A foreign capability can be ported into the governed native spine as a proven skill
(`core/skills/native-capability-extraction`), and `core/skills/skill-matchmaker` reports gaps/duplicates before a
new skill is authored. Projects studied for ideas (never code) are recorded in `docs/ABSORBED.md`.

---

## Layer 3 — Preference memory — **Built** (local); community path **Partial**

`lib/learning.mjs` (+ `lib/personalization.mjs`), **on by default**. Every owner turn is offered to a local
memory that learns **HOW** work should be done, never **WHAT** Kingmaker may do (the store refuses anything that
would widen authority, and redacts secrets).

- A repeated request or correction becomes a **candidate**; Kingmaker asks once, and the owner's "keep that" makes
  it **standing** ("drop that" declines).
- Standing preferences shape how the local models answer (`brief()`) and are written to **`crm-export.json`**.
  **Honest scope:** that file is written **locally only** — nothing in the shipped code uploads it or feeds it to
  team agents (`docs/community-learning.md` says it stays owner-only). So preferences shape *this Mac's* answers;
  they do not currently reach other agents.
- Owner words: `learning on|off`, `what have you learned` (`/memory`), `where did you learn …`, `forget what you
  learned about …`.

**Community path (opt-in) — Partial.** `lib/sharing.mjs` can send a sanitized packet through the `kingmaker-fleet`
Worker. Reality today:
- The daily packet (`buildPacket` → `fleetDraft`) carries **only preference counts**; `fleetDraft()` does not yet
  accept skills or device/model evaluations, so the `skill_package` / `device_eval` / `model_trial` artifacts are
  **designed packet fields, not currently emitted**.
- Sending uses `/contribute` and `/forget`. The **incoming** side — `GET /bundle`, verify, trial-on-local-records,
  adopt — is **not implemented** in `lib/fleet-transport.mjs`; it's the next slice in `docs/community-learning.md`.
- The Worker isn't deployed, so nothing leaves any Mac regardless; the packet is logged locally as "not sent".

Full design: `docs/community-learning.md`.

---

## Layer 4 — Weight fine-tuning — **Planned** (a gated descriptor exists)

This is the entire scope of "no local model training." Layers 1–3 change *which* model, *which* skill and *how*
the owner likes answers — never a weight. Layer 4 would let the local weights absorb the owner's style.

**It is not true that the engine source is outside this repo.** The engine source lives under
**`solomon/server/src`** (run directly in `lib/runtime.mjs` fork mode), and a scaffold already exists:
**`solomon/server/src/runtime/model-improvement-pipeline.ts`** — a pure, deterministic **descriptor + hard gate**.
It names the licensed methods (MLX fine-tuning on Apple Silicon today; Unsloth and weight "souping" CUDA-only,
unlocked by the owner's coming NVIDIA hardware) and gates each to the hardware that can run it. It **plans**, it
does not execute: `planModelImprovement()` says which methods the hardware may run and which stay gated. Layer-4
work is **extending that module**, in this repo — not new work elsewhere.

### The lane this spec proposes
```
owner turns ─► (a) CAPTURE ─► pairs.jsonl (sealed, local)
                                   │  nightly, on verified power + idle + display-off
                                   ▼
                         (b) TRAIN  mlx_lm.lora, one adapter per role
                                   │  adapter.safetensors
                                   ▼
                         (c) PACKAGE ─► adapter.gguf ─► `ollama create km-<role>:owner-<date>`
                                   │        (versioned tag — see integrity note)
                                   ▼
                         (d) TRIAL GATE ─► held-out owner eval; adopt only if it beats the base
                        ┌──────────┴───────────┐
                   keep local            (e) FEDERATE (its own consent)
              repoint the role        DP-noised adapter delta ─► kingmaker-fleet ─► signed global ─► sharers
```

Design points, each written to match what the code actually requires:

- **(0) A separate approval gate — required.** The `learning` switch is on by default and only authorizes
  preference memory. Capturing raw training pairs, spending resources to train, and (separately) federating must
  each have their **own consent record and command** — do not reuse `learning on` or the Layer-3 sharing switch.
  `docs/community-learning.md` already states federated LoRA "needs its own approval"; so does local training.
- **(a) Capture needs a real turn ledger.** `lib/evidence.mjs` is the UI/open-in-Chrome module, **not** a turn
  record, and confirmed preferences are statements, not prompt/response pairs — neither can supply training
  examples. A proper source of (prompt, response, approval-outcome) turns must be defined first (the voice turn
  ledger, `voiceTurnsPath` in `lib/profile.mjs`, is the closest existing record).
- **(a) Sanitize with the right tool.** Protect the local dataset with the **secret redactor in
  `lib/personalization.mjs`**, not `sanitizeForFleet()` — the fleet sanitizer emits no free text and would delete
  the prompts/targets training needs.
- **(b) The nightly trigger must detect its own conditions.** The Headless Host state is only `SMAppService`
  registration plus a `caffeinate -s` assertion; it does **not** report lid, display or battery. The scheduler
  must add explicit power/lid/display-off checks, or it could train on battery with the screen on.
- **(c) Version the tag, or repin.** A second nightly `ollama create` under the same `km-<role>:owner` tag changes
  its digest, which `model-integrity.ts` treats as a MISMATCH and quarantines. Use a versioned tag
  (`…:owner-<date>`) or a governed retire-and-repin, so a successful re-train is adopted, not flagged as an
  infection.
- **(d) Trial gate** reuses the bundle-trial pattern in `docs/community-learning.md`: adopt only if it beats the
  base on a held-out owner eval; discard a regression silently.
- **(e) Federation** rides the fleet transport but under its **own** consent (see §0), carries only a DP-noised
  adapter delta, and — like Layer 3 — nothing from the collective may change governance, approvals, keys or code.
  **Cohort key is mandatory.** Installs run different bases across memory tiers and owner-selected models, and
  rank may vary (8–16), so their LoRA deltas have different tensor names and dimensions. Aggregation **and**
  incoming verification must be scoped to an exact cohort — base-model digest + role + adapter architecture +
  rank — or the averaged delta is mathematically invalid and would produce an unloadable or corrupt global
  adapter. A delta that doesn't match the local cohort key is rejected, not applied.

---

## The governance spine — **Built**, with stated limits

The layers are kept from widening authority by enforcement, not by promises — but it's worth being exact about
which mechanism enforces what.

- **Principal enforcement (`lib/profile.mjs`) — the real boundary.** The per-launch authority secrets turn "same
  rules" on, so a local program or MCP client can only **PROPOSE, never approve**. This, plus the owner approval
  boundary, is what actually stops an absorbed or trained capability from acting on its own.
- **Owner approval boundary.** YELLOW proposals, `y`/`n`, voice approval (`kingmaker voice verified`), and the
  `stop approving` kill switch.
- **REA at ingestion (`lib/rea.mjs`).** Reads local connector code before use; see the two limits in §2a.
- **Minting ≠ granting (`lib/absorb.mjs`).** A skill is a way of doing work, not a permission — but the owner-OK
  *label* on a minted skill depends on the finite `GATED` list (§2c), so it is a hint layered on top of the
  approval boundary, not a standalone guarantee.
- **Integrity (`lib/integrity.mjs`) — collective exclusion, not edit-prevention.** It detects a modified or
  re-signed bundle and, as the module itself says, a modified copy **keeps working on its owner's Mac**; the
  enforced consequence is being **cut off from the collective** (no sharing, no Brain Library, no updates). It
  does **not** prevent a determined owner from changing what runs — the doc should not claim it seals the core.

---

## Built vs planned — the one-line answer

| | Layer 1 Brains | Layer 2 Orchestration | Layer 3 Preferences | Layer 4 Weights |
|---|---|---|---|---|
| Adapts | which trained model | skills minted & scored (ranking not wired) | owner's style (local) | local weights |
| Changes model weights? | no | no | no | **yes** |
| Status | Built | **Partial** | Built (local); community **Partial** | **Planned** (gated descriptor exists) |

Kingmaker runs on trained brains (Layer 1) and remembers how you like work done (Layer 2d/3), all governed. Its
skill-ranking and community-adoption machinery is built but **not yet wired into runtime** (Layer 2/3), and
on-device **weight** training (Layer 4) is scaffolded as a hardware-gated descriptor in
`solomon/server/src/runtime/model-improvement-pipeline.ts` but does not execute. "No local model training" is
true of Layer 4 only — and that is the layer this document specs out.

## See also
- `solomon/server/src/runtime/model-improvement-pipeline.ts` — the existing Layer-4 descriptor + hardware gate
- `docs/community-learning.md` — the fleet packet, sanitizer, Worker, bundle trial (Layer 3 + Layer 4e)
- `docs/ABSORBED.md` — projects read for ideas, and REA's role
- `lib/rea.mjs`, `lib/absorb.mjs`, `lib/learning.mjs`, `lib/profile.mjs`, `lib/integrity.mjs` — the running code
