---
name: native-capability-extraction
description: >-
  Extract a capability that currently lives in an external/foreign runtime (a Python app under apps/, a
  vendored tool, any non-native module) into the engine's governed TypeScript spine as a native, proven skill —
  then let it graduate to a core capability. Use this WHENEVER the task is "make Kingmaker do X natively
  instead of shelling out to Y", "retire this Python service into the spine", "port this capability and
  govern it", "extract the skill from that app", or any step of the capability-acquisition loop: need a
  tool -> if we HAVE it use it, else find or build it to fit -> test -> validate -> integrate -> a new core
  Kingmaker ability. It exists because the naive port re-implements governance, trusts model/tool output, hard-
  codes external binaries, and ships without a real proof — this skill forces spine-seam reuse, honesty-
  invariant preservation, injectable governed seams, a hermetic proof, and a scorecard gate before anything
  is called done. Proven 8x on apps/appforge + apps/leadengine.
---

# Native capability extraction

You are turning a foreign capability into a native, governed engine skill. Do it in this exact order.
Nothing is "done" until the proof and the reality gate pass and the scorecard says the run is clean.

If the capability was only observed (a demo, reel, or article, with no code in hand), run `app-remake-belt` first;
its clean-room behavior spec and review-gaps report are this skill's input.

## 0. Read the source — the OUTCOME, not the code
Read the source module(s) end to end. Write down, in one line each: what it produces, its inputs/outputs,
its **honesty invariants** (values it refuses to fabricate, provenance it stamps, security checks it makes),
and every **external dependency** (network call, subprocess/CLI, model, paid service). You are replicating
the outcome and the invariants — never a line-for-line transliteration.

## 1. Find the spine seam — never re-port governance
Before writing, locate the governed engine lane the capability must route through, and REUSE it:
- Model/LLM calls -> the governed inference lane (`runOllamaStructuredGeneration` / reasoning-router), never
  a raw provider POST. Prefer schema-constrained generation over free-text parsing.
- Outbound HTTP -> `native-web-fetch.ts` (`fetchPublicJson`/`fetchPublicPage`): SSRF-safe resolve-then-pin,
  Online-Mode-gated. Reuse its `isFetchableAddress`/`screenUrl` for any host check — do not re-implement SSRF.
- Persistence, identity, audit -> the existing spine services. If you are porting an app's own auth/DB/
  billing, STOP: that is plumbing, reuse the engine's spine, do not duplicate it (only capabilities extract).
An external dependency with no governed lane becomes an **injectable seam** (see step 3), not a hardcoded call.

## 2. Port faithfully into `server/src/apps/<app>/` (or the right runtime home)
- Preserve every honesty invariant verbatim in intent: unknowns stay "Unknown"/empty and are never invented;
  every value a stage sets is provenance-stamped; a value that can't be proven never becomes a score/graded
  input; synthesized data is flagged distinct from observed data.
- Security invariants are non-negotiable: escape untrusted data for its sink (script/HTML/CSV/SQL); owner-
  scope every RLS policy (never `using (true)`); reject a partial/failed external artifact rather than
  shipping it.
- Keep it deterministic + dependency-free where the source was; embed templates as data (base64), never a
  runtime file read the packaging pipeline could drop.

## 3. External tools = injectable governed seams (honest when absent)
Every external binary/service (OSINT CLI, yt-dlp, an agent runtime, a PaaS, an SMTP checker) is a typed,
INJECTABLE seam with NO network default. When a seam is not wired, the capability SKIPS or FALLS BACK
honestly with a coverage note — it never fabricates a result. This is what makes the whole thing hermetic:
tests inject fakes and touch no network; production wires the real transport under the operator's governance.

## 4. Write the hermetic proof (`tests/<name>/run.ts`)
`#!/usr/bin/env tsx`, `node:assert/strict`, dynamic-import the built `.js`, end with `console.log('NAME PASS
· ...')` and `main().catch(e => { console.error(e); process.exit(1); })`. It MUST: inject every seam (no
network); assert each honesty + security invariant (feed an ADVERSARIAL input and prove it's neutralized);
assert parity with the source outcome; be deterministic. Where a reference tool exists (openpyxl for xlsx,
`unzip -t` for a zip, a real model for the live lane), round-trip through it — a green in-house test only
proves the code agrees with itself.

## 5. Build, gate, score, propose
- `npm --prefix server run build` (module must compile to dist — packaged-server-safe).
- Run the proof, plus `SOLOMON_REALITY_GATE_STATIC_ONLY=1 npm run reality-gate` (must stay PASS).
- Score the run with `server/src/runtime/capability-acquisition.ts` `scoreExtraction(...)`. A HARD defect
  (build/proof/gate fail, or ANY ungoverned egress) is 0 and blocks. Feed the score into
  `evaluateGraduation(history)` — a skill promotes to a CORE capability only after a full window of clean
  runs; one defect resets the streak.
- Commit only when asked. Write the commit body to a FILE and `git commit -F` — backticks in `git commit -m`
  trigger shell command-substitution and silently mangle the message.

## Governance (hard, always)
Before a candidate skill is scored or graduated, screen it with `screenSkillSafety(...)`. Any skill whose
text attacks the limiter, suppresses/hides reporting, or encodes a destructive action is BLOCKED and reported
to Kingmaker (sanitized — id/verdict/categories, never the payload; payloads never run outside the immune
system's sandbox). The engine also sends a regular sanitized `buildKingmakerFederationReport(...)` so Kingmaker
accumulates the ABILITIES (identity/category/graduation), never customer data and never skill source.

## Done means
Build green, proof green, reality gate PASS, scorecard clean, safety screen ALLOWED, commit proposed. Report
honestly: what extracted, what was superseded (governance re-pointed to the spine), what stays a seam, and any
fidelity gap (say it plainly — a named gap beats a silent one).
