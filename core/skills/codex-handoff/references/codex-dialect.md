# Codex daemon dialect — decoder

Codex, when driven by a Codex daemon's directive stack, does not
write prose. It emits fixed, labelled sections. A handoff (or a `codex/*` branch's
commit messages and PR body) will be built from these. Map each to what it *means* and
how far to trust it — don't skim past a header assuming you know what's under it.

## Execution-format sections (normal coding tasks)

| Codex section        | What it is                                  | How to treat it |
|----------------------|---------------------------------------------|-----------------|
| `PLAN`               | What it intended to do                      | Intent, not proof it happened. Compare against the diff. |
| `FILES TO CHANGE`    | The files it meant to touch                 | Cross-check against `git diff --stat` — reality can differ from the plan. |
| `IMPLEMENTATION`     | What it says it wrote                        | A claim. The commit is the ground truth. |
| `VALIDATION`         | How it says it proved the work              | **The load-bearing section.** Re-run the exact command it quotes before you build on it. A named suite with a count ("`showcase-voice` 19/19") is checkable; "looks correct" is not. |
| `RISKS / FOLLOW-UPS` | Known gaps, open bugs, next steps           | Your worklist. Anything here is *un*finished by Codex's own admission. |

## Tool-led sections

| Codex section                    | Meaning |
|----------------------------------|---------|
| `CATEGORY` / `TOOL OPTIONS` / `PROS` / `CONS` / `RECOMMENDED` | A build-vs-buy evaluation. `RECOMMENDED` may be "NONE". |
| `DECISION: BUILD / BUY / HYBRID` | The call it made. `REASON` is 1–3 lines under it. |

Governance filter Codex applies (so you know what it will have rejected): anything
introducing hidden mutation, extra attack surface, uncontrolled data ingress, or
opaque dependency risk. If a handoff says it *rejected* a tool, that's why.

## Innovation sections (only present when the directive explicitly asked for invention)

These are OFF by default. If you see them, the task was flagged as invention work.

| Codex section                                   | Meaning |
|-------------------------------------------------|---------|
| `LAYER 1 — CONTROLLED BASELINE`                 | The realistic, buildable version. This is usually what actually got built. |
| `LAYER 2 — INNOVATION STRIKE`                   | An aggressive, unconventional design. Often a *proposal*, not built — check the diff before assuming it exists. |
| `FUSION SYSTEM …` / `CONSTRAINT BREAKER …`      | Cross-domain synthesis / barrier-breaking ideas, with `FEASIBILITY: LOW/MEDIUM/HIGH`. Design thinking, not shipped code, unless a commit backs it. |
| `LEVERAGE / COMPLEXITY / RISK (1–10)`           | Codex's own self-scores. Informative, not authoritative. |

## The governance vocabulary you'll see either way

The daemon runs "fail closed on uncertainty, no hidden state, deterministic where
feasible, explicit file edits only." Practical consequences for a handoff:

- **"Fail closed"** — where Codex was unsure, it should have *stopped*, not guessed. A
  blocker in the doc is Codex refusing to drift, not Codex failing. Respect it.
- **"Explicit file edits only / no hidden mutation"** — the diff should be the whole
  story. If the handoff describes a change you can't find in the diff, that's a red
  flag worth surfacing, not papering over.
- **"Deterministic / same input → consistent output"** — if you re-run its VALIDATION
  and get a *different* result, something drifted; investigate before continuing.
