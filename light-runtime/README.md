# Kingmaker — light runtime

The minimal window for Kingmaker's lighter runtime, in the design category Robbie
adopted 2026-10-21 (`~/workspace/kingmaker-light-runtime-ui-design.md`): a true-black
window, an evidence wall, one amber marker. A presentation + control surface — never
a workflow editor, and never an approval: nothing here can approve, send, or spend.

It exists to drive and show one thing: **the 10M token proof** — ten million tokens
through this Mac's own models, judged against a sustained **200 tok/s** target
(`light-runtime/state-schema.mjs`).

## Run it

```sh
node scripts/light-runtime-server.mjs
# → http://127.0.0.1:8931  (loopback only; LIGHT_RUNTIME_PORT overrides)
```

State lives beside the page by default; `KINGMAKER_LIGHT_DIR` points the server at a
separate state dir, and `KINGMAKER_STATE_DIR` at the engine's state dir (for the
profile override and the token meter's log).

## The contracts (all in `light-runtime/state-schema.mjs`)

| File | Written by | Holds |
|---|---|---|
| `control.json` | this surface (via the server) | `{ proofRun: 'start'\|'stop'\|null, reflex, reflexPin }` — intent flags only |
| `proof-report.json` | `scripts/run-10m-proof.mjs` | `{ at, stages: [{ label, tokens, seconds, kind: 'REAL'\|'SIMULATED', source? }] }` |
| `verdicts.json` | the engine side (optional) | latest reflex verdicts `[{ question, answer, probability, model, ms, at }]` |

Tiles and the PASS / FAIL / UNMEASURED verdict are **computed** from the stages —
never read from the report — and a SIMULATED stage can never certify the target.
