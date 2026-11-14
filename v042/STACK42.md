# KINGMAKER 4.2 — INTEGRATION MAP

*Folded 2026-10-20 (America/Phoenix). Source: the @simplifyinai tool scan
(`~/workspace/simplifyinai-scan/inventory.md`), scope:
`~/workspace/kingmaker-v042-scope.md`. Pattern: the 4.1 stack fold-in —
governed integration modules + intake records + tests, NOT live
installs. 4.2 rides the 4.1 pipeline when it pushes: the same
signed-manifest + library-delivery machinery carries any model/data
payloads (AngelSlim outputs; Hy-MT2 if it ever clears).*

## The picture in one paragraph

Six tools from the scan are absorbed the Kingmaker way — behind
governance, on paper first: a public-web scraper (Scrapling) wrapped as
an egress-guarded adapter; a 30 MB-class Rust agent browser (Obscura)
registered as an MCP connector with a Cage pin standing between it and
its first launch; the Blender MCP connector for the sovereign 3D
pipeline, with its code-exec tool tap-gated and its telemetry pinned
off before it ever runs; the WhatsApp MCP connector with the founder's
comms law enforced in code (known contacts only, per-batch tap for
sends — sends are a governed action, never ambient); Tencent's
AngelSlim registered as a condense-lane workload in the SPACE-cell
shape, governor outside, model hashed in and out, runner stubbed behind
the founder tap; and FreeMoCap registered EXTERNAL-ONLY — AGPL mocap
that an operator drives and Kingmaker never touches beyond its exported
files. Two scan models (MiMo-V2.6-Distill-Qwen-9B, Hy-MT2) sit in Cage
triage as paper: DO NOT USE until cleared. Everything here is
zero-network in tests (injected fakes), zero-dependency, and verified
by `verify-42.mjs`.

## The registry (verify with `node ~/workspace/kingmaker-v042/verify-42.mjs`)

| Component | Home | What it is | License posture |
|---|---|---|---|
| scrapling | `scrapling/` | Governed intake-scraper adapter (fetcher interface behind egress guard + audit chain; transport injected) | BSD-3-Clause — clean |
| obscura | `obscura/` | Agent-browser registration: MCP descriptor, 37-tool surface, binary pin record, governed launch contract | Apache-2.0 — clean |
| blender-mcp | `blender-mcp/` | 3D-pipeline connector registration: MCP descriptor + start contract + capability risk classes | MIT — clean |
| whatsapp-mcp | `whatsapp-mcp/` | Comms connector registration + send gate (known contacts, per-batch tap) | MIT — clean |
| angelslim | `angelslim/` | Condense-lane workload: job descriptor + tap-gated stub runner | Apache-2.0 — clean |
| freemocap | `freemocap/` | EXTERNAL-ONLY registration + specifier tripwire | AGPL-3.0 — external only, out of Solomon |
| triage | `triage/` | Cage intake records: MiMo-V2.6-Distill-Qwen-9B, Hy-MT2 — UNVERIFIED, DO NOT USE | claims recorded; unverified |
| integration layer | this folder | Shared audit chain + governance primitives, seams, verifier, census, this map | Ronin Inc |

**Shared spine.** `lib/audit-chain.mjs` is the house hash chain in
JSONL (byte-compatible math with the 4.1 chain — the training
pipeline's harvester reads it the same way). `lib/governance.mjs` holds
the three primitives everything is built from: the refusal shape, the
founder-tap gate (fail-closed), and the egress guard (deny by default).

## Per-component notes

**`scrapling/`** — wraps Scrapling's upstream interface (verified from
its README: `Fetcher`, `StealthyFetcher`, sessions, `.css()` /
`.xpath()` / `.markdown()`). `fetchPage` / `extract` / `markdown` run
intent → egress → screen → injected transport, and return
LittleBrother-shaped evidence records. Spiders, proxy rotation, and
upstream's own MCP server are registered as NOT wrapped — the governed
adapter is the only door. Live transport wiring is a Cage-intake act.

**`obscura/`** — `obscura mcp` over stdio is the registered transport
(upstream MCP doc fetched; 37 tools, grouped and risk-classed —
`browser_evaluate` and the cookie/storage tools are elevated, not
ambient). Cage intake completed 2026-10-20 (founder order, pre-signing
addition to 4.2): the pin records v0.2.5's
`obscura-aarch64-macos.tar.gz` sha256 from two identical fetches, and
the launch contract refuses to build a config against anything less.
HTTP mode requires a ≥32-byte broker-delivered token;
`--allow-private-network` is forbidden, so upstream's SSRF posture
survives governance intact. The **Tor profile** is the only governed
proxy: caller `--proxy` is refused in every mode, and tor mode injects
the pinned constant `socks5h://127.0.0.1:9050` itself (socks5h keeps
DNS inside Tor); the launcher must preflight a live Tor SOCKS answer
on 9050 before spawn. The binary is operator-installed from the
pinned release; behavior receipts (fail-closed on a dead proxy,
socks5h honored) are in `obscura/intake/INTAKE.md`.

**`blender-mcp/`** — nine capabilities from the upstream README, each
risk-classed: reads ambient; `execute_blender_code` (arbitrary Python
in Blender — upstream's own warning) founder-tap-gated per call;
`generate_3d` / asset tools gated on per-service egress declarations;
`record_trajectory_feedback` refused outright. The start contract pins
`DISABLE_TELEMETRY=true` (upstream collects an anonymous usage record
by default — the governed build collects nothing), pins
`BLENDER_MCP_SAFE_MODE=1`, and pins the addon socket to localhost:9876.

**`whatsapp-mcp/`** — upstream is a Go bridge (local SQLite store) +
Python MCP server, 9 read tools + 3 send tools. The gate makes the
founder's law structural: reads are ambient and audited (bodies never
logged); sends require a known-contact recipient AND an open batch —
one verified tap opens one batch with a hard allowance, the batch
fires without per-item prompts, strangers refuse even inside a batch.
The TCPA attestation remains the founder's legal act alone; the gate
records taps, it never attests.

**`angelslim/`** — a compression-job descriptor in the 4.1 SPACE-cell
shape: kind `angelslim-compress`, governor outside the worker, egress
deny-all, model-in sha256 required to build a job and model-out sha256
required to accept a result (an output equal to its input is refused —
no compression happened). Method vocabulary from the upstream README
(FP8-Static/Dynamic, INT8-Dynamic, INT4-GPTQ/AWQ, NVFP4). The runner is
the LittleBrother methods-full stub pattern: valid tap → stub record,
executor never invoked; executing a real compression is a founder act.

**`freemocap/`** — the smallest fold-in and the firmest line. The
descriptor is data: external, AGPL-3.0, out of Solomon, driven by an
operator in their own session; Kingmaker consumes exported `.blend` /
`.csv` files through the Cage. `guardSpecifier()` throws on any attempt
to reference it as code, `validateExternalDescriptor()` refuses any
record drifting toward linkage, and the suite self-scans the component
to prove no upstream import exists. Same posture as heretic-llm, one
step further: not even a subprocess contract.

**`triage/`** — Cage/Housing Bay paper for MiMo-V2.6-Distill-Qwen-9B
(Xiaomi; caption claims MIT — unverified, and a Qwen-base distill
carries two license layers to check) and Hy-MT2 (Tencent; 440 MB
offline translator, 33 languages; license unverified). Both records:
status UNVERIFIED, hash field empty (hashes are recorded at intake,
from the artifact — never from a caption), verdict DO NOT USE until
cleared, enforced by `assertUsable()` — flipping a status string
without evidence still throws. No weights were downloaded. If Hy-MT2
clears, the folded AngelSlim lane is its natural compression path.

## Seams (all test-asserted in `seams42.test.mjs`)

- manifest license posture == each descriptor's, component by component
- FreeMoCap is the registry's only AGPL entry; triage its only
  unverified one
- AngelSlim descriptor kind == the module's workload kind
- the WhatsApp descriptor states the same send law the gate enforces
- the shared audit chain verifies under independently recomputed house
  math (interop with the 4.1 harvester discipline)
- zero bare imports in the whole tree — zero-dependency, no upstream
  code anywhere, AGPL least of all
- verify-42.mjs covers all eight suites

## Explicitly NOT in 4.2

- Jev/TypeSafe decision models — competitive intel only; System One
  occupies that lane.
- The scan's "REA — Reverse Engineer Anything" MCP decompiler — a name
  collision with Ronin REA, permanently flagged, never wired.
- The other ~84 scanned tools — STUDY/SKIP record stands in
  `inventory.md`.
- Live anything: no binary downloads, no weight downloads, no pairing,
  no scraping. Each live wiring is a separate Cage intake act.

## Boundaries (unchanged, restated for this stack)

- Public intake only through the governed lanes; no credential
  operations, no account takeover, no pretexting, no surveillance —
  the standing never-list applies to every 4.2 surface.
- Founder tap gates: Blender code-exec (per call), WhatsApp send
  batches (per batch), AngelSlim runs (per job, stub until the founder
  wires the real runner), every Cage intake (Stage 4).
- Egress is declared, never improvised: scraper allowlist, browser
  SSRF posture, per-service declarations for the 3D cloud tools,
  deny-all for compression.

## Operations

- Verify everything:
  `node ~/workspace/kingmaker-v042/verify-42.mjs` (add `--json` for the
  machine report). Exit 1 on any failure.
- Refresh the byte census + registry stamps:
  `node ~/workspace/kingmaker-v042/census42.mjs`.
- Counts and per-component bytes live in `stack42-manifest.json`
  (`byteCensus`) — the proof-in-bytes record for this stack.
