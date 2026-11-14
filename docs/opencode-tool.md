# OpenCode — a Brain Library tool, conducted headless

OpenCode (MIT, `anomalyco/opencode`) is the fleet's local coding harness. As of the
2026-11-14 wiring build it is a first-class Brain Library TOOL — the same item type as
Blender and the Kali bench — and the method conductor can call it in the background,
headless, on any node that lacks it, by streaming it in.

## The two halves

**Library item** — `catalog/tools/index.json`, id `opencode`, `provides: ["opencode"]`,
pinned to the vendor's release **v1.19.5** (verified against the digests in the vendor's
own release record at staging time; the binary bytes were re-verified inside each
repack). Per platform: linux-x64, linux-arm64, macos-arm64 and windows-x64 are `staged`
(whole-archive + part SHA-256 pins, one `.part-aa` part each — every archive is far
under `PART_BYTES`); macos-x64 and windows-arm64 are `declared-not-staged` (the vendor
assets exist; the identical repack stages them on demand). Only the CLI assets are
carried — the conductor runs the headless CLI, not the desktop app. The payload store
layout is the standard one (`<toolPayloadDir>/opencode/<platform>/<part>`), and the
releases the pull path serves in production are the `ronininc/weights` tags
`opencode-1.19.5-<platform>`.

**Conducted capability** — `catalog/methods/opencode-code-task.method.md` is the
callable surface. Its steps: check-tool `opencode` (on a miss, the tool-streaming
provider — `lib/tool-streaming.mjs` — pulls, hash-verifies, materializes and registers
the staged payload, and the check re-runs against the materialized binary); write the
job record (`opencode-job.json`, schema `kingmaker.code-job/1`); then the declared run
step, `opencode run --auto --model {{inputs.model}} {{inputs.task}}`, which EXECUTES
for real whenever the harness is on PATH or was pulled by the same conduction (the
materialized binary, argv as written, no shell, cwd = the conduction's workDir, the
conductor's 300 s step cap). When neither holds, the step stays declared with its
reason — never faked — and the job record remains as the receipt of what was asked.

## The run's contract

- **Headless means `--auto`.** `opencode run` is the non-interactive mode; `--auto`
  approves its tool permissions without a terminal. The conduction's workDir is
  therefore the sandbox boundary: conduct code tasks only in a folder that is the
  task's own scratch or checkout.
- **The model is a dial, not a fixture.** `inputs.model` defaults to the vendor's
  built-in free model (`opencode/big-pickle`). A caller with a local streamed weight
  passes its own `provider/model` (e.g. an Ollama-served Brain Library model) — the
  method file does not change, and Kingmaker's per-task smallest-sufficient selection
  is what chooses.
- **Tasks are plain words.** The declared action is split into argv on whitespace and
  the harness receives the task as the joined words; quoting does not survive. The
  loop's evaluation — did the code change do what the task asked — happens outside
  the method; the method's trace carries the run's exit code and output as evidence.

## Registration

Materializing registers the tool in the persistent tool registry
(`<state>/brain-library/tools/tools-registry.json`) with its MCP-shaped descriptor
(`Runs the tool's own binary with the given arguments`), and — through the provider's
`addConnector` dep, where a caller injects it — with the REA/MCP hub as an MCP
connector, exactly like every other library tool. `kingmaker tools library pull
opencode` (lib/bench-cli.mjs) drives the same provider from the CLI.

## Proof (2026-11-14 wiring build)

- The staged linux-x64 payload was pulled BY CONDUCTION (check via library, registry
  pin == catalog pin) and the materialized binary executed `opencode --version`
  through the declared step: `test/opencode-tool.test.mjs` layer 3 (payload-gated).
- A real code task (fix a planted bug in `math.js`) was conducted with the shipped
  method and evaluated outside it; the method file was then improved from that
  evaluation and re-conducted — the loop's recursion is part of the build's receipts,
  kept with the build report.
