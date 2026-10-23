# The 10M Token Proof

The doing-more-with-less doctrine, made measurable: drive Kingmaker's model pipeline through
a **10,000,000-token** workload and report the **sustained aggregate throughput** against the
target line — **200 tokens/second** — with a full token ledger by lane, model, and stage.

The workload mirrors the doctrine's shape: reads are enormous (large prefill over corpus
chunks), reflex decisions are batched (one forward pass per 64 fixed-answer questions through
the real `DecisionRouter`), and writes are a bounded sliver (decode is the dear part).
Default budget split: read 88% · reflex 9.5% · write 2.5% of tokens.

## Run it

```sh
# VM / anywhere — SIMULATED. Proves the harness (metering, verdicts, report). Proves nothing
# about hardware, and says so on every line.
node scripts/run-10m-proof.mjs

# The Mac — smoke first (1M tokens, ≈83 min at target), seats warmed:
node scripts/run-10m-proof.mjs --tokens 1000000 --base-url http://127.0.0.1:11434 --warm

# The Mac — the full proof, resumable:
node scripts/run-10m-proof.mjs --base-url http://127.0.0.1:11434 --state proof-state.json --out proof-out
node scripts/run-10m-proof.mjs --base-url http://127.0.0.1:11434 --state proof-state.json --resume
```

The full run at exactly target takes 10,000,000 / 200 = **50,000 s ≈ 13.9 h** of stage wall.
Stage walls are summed (pauses between stages don't count), a stop (SIGINT/SIGTERM) lands
between stages and still writes its report + state, and `--resume` continues the same plan —
the state file refuses a different seed/tokens/corpus rather than mixing two runs.

Point `--corpus DIR` at real text (brain-library / knowledge files) for the real run; with no
corpus, a seeded synthetic corpus stands in and the report's plan digest says which ran.

## The honesty rules (by construction, not by promise)

- Every stage is labeled `measured: real | simulated`. Real = token counts from the endpoint's
  own report (`prompt_eval_count` / `eval_count`, the token-meter convention). Reflex stages
  carry no provider token report, so theirs are payload estimates and say
  `countSource: payload-estimate`.
- The verdict claims the 200 tok/s target **PROVEN** only when *every* stage is real and the
  sustained rate clears the line. Any simulated stage ⇒ **UNMEASURED** ("harness proven, target
  unmeasured — Mac run owed"), however fast the fake was. A real run under the line ⇒ **FAILED**.
  Every verdict carries its arithmetic.
- `sustained` = all tokens / summed stage wall. `peak` = the fastest stage (a stage is a batch
  of concurrent calls, so its rate is an aggregate rate, never one stream's decode).

## The report

`--out DIR` writes `report.json` + `report.md`. The JSON is `proof/report-schema.mjs`'s shape —
the exact shape the light-runtime UI consumes: `cards` are the evidence cards (1:1 with stages,
same order, same source lines), `tiles` are the four ticker tiles (TOTAL TOKENS · SUSTAINED T/S ·
PEAK T/S · WRITE SHARE %). `validateReport()` checks any report against the schema.

## Files

- `proof/workload.mjs` — deterministic plan: seeded PRNG, named token estimator, corpus in
  (directory or synthetic), stages out. Same seed + corpus ⇒ same plan, byte for byte.
- `proof/transport.mjs` — the real Ollama transport, the counting (simulated) transport, the
  simulated System One fetch, and the parallel-scheduling wall model for simulated time.
- `proof/run-proof.mjs` — the runner (DecisionRouter for reflex, the transport for read/write,
  the tree's token meter on every call), the verdict, the Mac-run requirements, the markdown.
- `proof/report-schema.mjs` — the report contract + validator.
- `scripts/run-10m-proof.mjs` — the control surface: start, watch (live stage lines), stop,
  resume.
- `tests/proof.test.mjs` — 55 checks: metering arithmetic, verdict honesty, determinism,
  schema shape, smoke exactness, resume, clean stop.
