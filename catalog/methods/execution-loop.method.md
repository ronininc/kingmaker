# Method — Execution Loop (Kingmaker's own framework)

A method file (owner item 15) that houses the framework of owner item 16's execution loop
(`lib/execution-loop.mjs`), so Kingmaker can read its own framework through the same
reader/conductor path it uses for every other capability: this file is discovered through
`catalog/methods/index.json`, streamed through the Brain Library read path, digested by
`lib/method-conductor.mjs`, and conducted like any method. If the loop's shape changes, this
file changes — the framework description lives in the library, not only in code comments.

## The loop, in the owner's shape

1. **Intake + detail fetch (SEO/AEO leg)** — a person asks Kingmaker to do something. The loop
   derives what details it needs: when the request names or implies a source (an http(s) URL),
   it fetches that source for real and extracts the relevant details (title, text facts) into
   the run context. When no source is named or the fetch fails, the trace says so with the
   reason — details are never fabricated. No GitHub API is used on this leg.
2. **Picks** — the correct method file is picked from the MemPalace architecture in the brain
   repo: conductor library discovery, ranked with the module reader's quality-selection
   discipline (relevance first, quality as boost). The correct weights are picked by the
   smallest-sufficient rule (the metered doctrine): bench records (`catalog/bench/`) screened
   against the task's declared requirement — the role from the task (or this method's declared
   `weights`), its capabilities, and the eval-share floor — and the SMALLEST model meeting it
   wins. The machine's memory never screens a candidate out: it shapes the pick's delivery plan
   in lane order (resident; metered-stream in verified 1 MiB portions; or the sandbox lane —
   containerized, paged execution under Kingmaker's own Docker control — for a model past the
   device's whole memory when the sandbox is in the device's posture), and only when the sandbox
   lane is absent or declined does a smallest-sufficient model escalate through the existing
   lanes instead of being refused — a policy routing, never a size refusal.
   Both picks, with reasons and every considered candidate's verdict, land in the trace.
3. **Prep, parallel or scoped down** — the prep sections (governing-context module read via the
   module reader, method pick, weights pick) run in parallel if the machine can handle it —
   decided from free memory and core count against the thresholds carried in this file's
   inputs — otherwise scoped down to individually, one at a time. The mode and why are traced.
4. **ETA clock** — before execution, a clock counter shows how long it will take, derived from
   the bench data for the picked weights (measured load seconds + measured generation rate)
   and the picked method's step profile (steps × tokens-per-step + context tokens). The
   derivation is shown in the trace; no duration is hardcoded.
5. **Execution** — the picked method is conducted via the method conductor against the caller's
   workDir, as efficiently as possible on their machine. The conduction's own trace, declared
   steps and outputs are carried through untouched.

## Executable block

```kingmaker-method
{
  "id": "execution-loop",
  "version": "1.0",
  "title": "Execution Loop",
  "domain": "framework",
  "inputs": {
    "parallelMinFreeMemMb": 512,
    "parallelMinCores": 2,
    "tokensPerStep": 150
  },
  "steps": [
    { "n": 1, "id": "state-intake-and-fetch", "type": "note",
      "text": "Phase 1 — intake + detail fetch: the request names or implies a source, it is fetched over HTTP(S) and its details (title, text facts) extracted into the run context; no source or a failed fetch is declared/failed in the trace with its reason, never fabricated." },
    { "n": 2, "id": "state-picks", "type": "note",
      "text": "Phase 2 — picks: method file picked from the brain repo's MemPalace architecture (conductor discovery, reader quality discipline); weights picked from catalog/bench by the smallest-sufficient rule (the task's declared requirement: role, capabilities, eval floor — the smallest model meeting it wins; device memory shapes only the delivery plan, in lane order: resident, metered-stream in verified portions, or the sandbox lane — containerized, paged execution under Kingmaker's Docker control — past the device's whole memory when the sandbox is in the device's posture; only with the sandbox lane absent or declined does a model escalate through the existing lanes instead of being refused, as a policy routing and never a size refusal). Both picks traced with reasons." },
    { "n": 3, "id": "state-prep-modes", "type": "note",
      "text": "Phase 3 — prep sections (context read, method pick, weights pick) run in parallel when the machine meets the thresholds in this file's inputs (>= {{inputs.parallelMinCores}} cores, >= {{inputs.parallelMinFreeMemMb}} MB free), otherwise scoped down to one at a time; the mode and why are traced." },
    { "n": 4, "id": "write-framework-record", "type": "write-json", "path": "execution-loop/framework.json",
      "value": { "framework": "{{method.id}}", "version": "{{method.version}}", "phases": ["intake+fetch", "picks", "prep", "eta-clock", "conduct"], "parallelMinFreeMemMb": "{{inputs.parallelMinFreeMemMb}}", "parallelMinCores": "{{inputs.parallelMinCores}}", "tokensPerStep": "{{inputs.tokensPerStep}}" } },
    { "n": 5, "id": "state-eta-and-execution", "type": "note",
      "text": "Phase 4+5 — ETA clock derived from the picked weights' bench record and the method's step profile before execution; then the picked method is conducted on the person's machine and its trace carried through." },
    { "n": 6, "id": "verify-framework-record", "type": "verify",
      "assertions": [ { "file": "execution-loop/framework.json", "field": "framework", "equals": "execution-loop" }, { "file": "execution-loop/framework.json", "field": "phases", "exists": true } ] }
  ]
}
```

## Steps (prose mirror)

1. **state-intake-and-fetch** — Phase 1 stated into the trace (see above).
2. **state-picks** — Phase 2 stated into the trace.
3. **state-prep-modes** — Phase 3 stated into the trace, with this file's own threshold dials substituted in.
4. **write-framework-record** — Write `execution-loop/framework.json`: the framework's identity, version, phase list, and the prep thresholds — the machine-readable receipt that this framework was read and conducted.
5. **state-eta-and-execution** — Phases 4 and 5 stated into the trace.
6. **verify-framework-record** — Re-read the written record and confirm the framework identity and phase list on disk.

## Failure modes

- **Framework file missing from the index** → the loop cannot describe itself; `describeFramework()` returns null and the self-read test fails loudly rather than the loop describing itself from code comments.
- **A phase's description here drifts from `lib/execution-loop.mjs`** → this file is wrong, not the code's comments: the library copy is the one Kingmaker reads, so it is the one that must be kept true.
