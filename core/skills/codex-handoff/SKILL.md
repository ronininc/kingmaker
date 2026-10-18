---
name: codex-handoff
description: >-
  Read, correctly understand, and safely continue a handoff left by Codex (or any
  prior agent) — usually a committed markdown doc, e.g. <TOPIC>_HANDOFF_<date>.md.
  Use this WHENEVER the user points you at a handoff file or says any of: "here's
  the handoff from codex", "pick up where codex left off", "continue the codex
  handoff", "codex left this", "take over the codex branch", or just drops a
  *HANDOFF*.md filename with no other instructions. It exists because three things
  reliably go wrong on a handoff: (1) you misunderstand a lot of what the doc says,
  (2) you edit the wrong worktree/branch, and (3) you trust your own follow-up
  edits without proving them. This skill forces a full read, a restated receipt,
  a hard anchor to the correct tree, and proof-by-observation of your own work.
  Trigger even if the handoff looks short or "obvious".
---

# Continuing a Codex handoff

A handoff is a document a previous agent (usually Codex) wrote *for you*, the next
agent, so you can continue its work without repeating it. They usually arrive
as a **committed markdown file** named like `VOICE_HANDOFF_20260727.md`; read the
first one you meet end to end to learn the house format. They follow the project's
Truth-Envelope discipline: findings are labelled **MEASURED** (observed on the
machine) or **INFERENCE** (reasoned but unproven), and they carry sections for the
tree state, machine state changed, and standing constraints.

Your job is not to skim it and start typing. Your job is to *inherit its state
correctly* and continue without breaking what it built or fooling yourself about
what you've done.

## The three ways this goes wrong — and the rule for each

These are the actual failure modes, in the operator's words. The whole skill exists
to prevent them.

1. **You misunderstand a lot of what it says.** → Read the *whole* thing, then
   restate it back as a receipt before you touch anything (Steps 1–2).
2. **You edit the wrong worktree.** → Anchor to the correct tree and confirm every
   path is inside it *before the first edit* (Step 3). This is a locked hazard here.
3. **You trust your own edits too completely.** → A successful `Edit` proves the
   text changed, not that the code works. Prove your own work by observation, with
   the same rigor you'd apply to Codex's claims (Step 5).

## Step 1 — Read the entire document before you touch anything

Read it top to bottom. Do **not** start acting after the first "Next steps" bullet.
Codex handoffs deliberately bury load-bearing caveats *below* the plan — in sections
like "Preserved, NOT finished", "Machine state I changed", and "Standing constraints".
Miss those and you'll rebuild something that's done, or regress a rule, or reason from
a machine state that no longer exists.

As you read, sort every claim into the project's two buckets — this is the single
most important comprehension move:

- **MEASURED / "verified" / "suites N/N" / a quoted command + output** → a claim of
  proof. Real *until your next step depends on it*, at which point you confirm it.
- **INFERENCE / "not proven" / "well-evidenced but nobody re-tested" / "open bug"** →
  explicitly unproven. These are the traps. Treat each as an open question, never a
  fact to build on.

Also locate, specifically:
- **Next steps, in order** — the order is load-bearing. Codex usually front-loads a
  *prerequisite* ("rebuild properly BEFORE diagnosing", because testing a stale build
  measures old code). Skipping it makes every later observation a lie.
- **State of the tree** — the exact branch + HEAD commit, what landed, what's
  "preserved but not finished", what's "known-stale and unrelated" (don't chase it).
- **Machine state I changed** — side effects *outside* the repo: killed processes,
  in-place installs, hybrid builds, ports freed. You inherit these.
- **Standing constraints / "do not regress"** — hard rules to carry forward.

If the handoff (or the branch it came from) is written in Codex's structured daemon
dialect — `PLAN / FILES TO CHANGE / IMPLEMENTATION / VALIDATION / RISKS-FOLLOW-UPS`,
or `BUILD/BUY/HYBRID`, `LAYER 1/2`, `FUSION` — read
[references/codex-dialect.md](references/codex-dialect.md) for a decoder that maps
each section to what it means and how much to trust it.

## Step 2 — Write a receipt and get it confirmed

Before editing anything, restate the handoff in your own words. This is the best
defense against misunderstanding: it turns a *silent* misread into a *visible* one
the operator can correct in five seconds — before you've built anything on top of it.
If the user just dropped a filename with no other instruction, **this receipt is your
first reply.**

Keep it tight — this is a confirmation, not an essay:

```
Handoff receipt — <file>
- Codex did:            <1–3 bullets: the landed work>
- Claims proven (how):  <the MEASURED / VALIDATION items + how it says it proved them>
- NOT proven / open:    <INFERENCE items, "preserved not finished", open bugs>
- Work lives at:        <branch + HEAD commit + any worktree it names>
- Machine state changed:<processes killed, in-place installs, ports, hybrid builds>
- Constraints to keep:  <the "do not regress" rules>
- I'm about to:         <the first next step, in Codex's order>

Does this match your understanding before I start?
```

If your receipt and the doc disagree, you misread — reread, don't guess.

## Step 3 — Anchor to the correct worktree before the first edit

This is failure mode #2 and it is a hard gate. The handoff quotes **absolute paths**
(e.g. `/Users/you/Projects/<repo>/lib/cli.mjs`) that usually point at the
**main repo**, not the worktree you're running in. The same file exists in both. Edit
the one the doc printed and your change lands in the wrong tree, invisibly.

Run the anchor check — it prints your tree and flags every path in the handoff that
lives *outside* it:

```bash
.claude/skills/codex-handoff/scripts/anchor.sh <path/to/HANDOFF.md>
```

Then hold to these rules:
- Your working root is whatever `git rev-parse --show-toplevel` prints. **Every file
  you open for editing must live under it.** Never edit the raw absolute path the doc
  quotes — translate it to the same relative path under your toplevel.
- If the handoff names a **branch or commit different from where you are** (e.g. work
  is on `claude/ronin-…` but you're on `integrate/…`), stop and reconcile with the
  operator. Picking up on the wrong branch silently forks the work.
- Before you commit, confirm the branch again. If you delegated any work to a subagent,
  verify with `git log --all` — subagents commit into the *session* worktree, not the
  path in their prompt, and they'll report success either way.

## Step 4 — Execute in Codex's order, one step at a time

Follow "Next steps, in order." Do the prerequisite first even when it's tempting to
jump to the interesting bug — the prerequisite is usually what makes your later
measurements *mean* anything.

Re-verify a Codex claim **when, and only when, your next step depends on it.** You
don't need to re-prove the whole document. But if step 3 assumes "the answer engine
is fine" and Codex only marked that INFERENCE, prove it (hit the endpoint, read the
response) before you build on it.

## Step 5 — Prove your OWN edits by observation, not by "the edit applied"

This is failure mode #3, and it's Kingmaker's own doctrine turned on yourself: *nothing
is done, working, or validated without a real proof.* A green `Edit`/`Write` is
evidence the text changed — it is **not** evidence the code runs or the bug is fixed.

- After a change, produce the observation that shows it works, and match the *kind* of
  proof to the claim: run the test/proof suite and read the count; launch it from a
  terminal and read stdout; hit the endpoint and read the body; **diff the pixels**
  between two different inputs for a renderer. The handoff's own hard-won rule: "status
  fields, file sizes, and markers all passed while the frames were identical" — markers
  lie, observations don't.
- Report truthfully, in the same MEASURED / INFERENCE language: what you observed, what
  you did *not* verify, what you skipped, and any test that failed (with its output).
  Never write "done" off an unobserved edit.

## When you hand it back

Close the loop: write your continuation as a short handoff-back in the same format —
MEASURED vs INFERENCE, tree state (branch + HEAD), machine state you changed, and the
constraints still standing. Give the next session (Codex again, or the operator) the
document you wish you'd received.
