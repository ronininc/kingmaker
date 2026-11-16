// lib/elephant-goldfish.mjs — plan → fresh-context review → resolution, for Kingmaker-written methods (2026-11-16).
// The PATTERN of Google's Elephant–Goldfish Model (github.com/google/elephant-goldfish-model @72d06f5, Apache-2.0;
// "not an officially supported Google product"). No code or prompt text is copied: this is Kingmaker's own small
// re-implementation for one local model on an 8 GB Mac, run sequentially; no cloud inference.
//
//   ELEPHANT  (planner, holds project context) turns the goal + cited sources + Kingmaker's validated pipeline output
//             into a complete plan with stable ids: prerequisites, state, decision points (both branches), tools,
//             expected outcomes, failure handling, objective checks.
//   GOLDFISH  (reviewer) gets a FRESH, stateless model call whose input is built here from ONLY the rubric, the plan
//             and the cited source excerpts — never the writer's conversation. It returns findings (schema below).
//             Code checks every finding: its evidence must appear verbatim in the plan or an excerpt.
//   RESOLVE   Elephant answers each finding: fix | contest (must cite an excerpt id whose text is verified here) |
//             escalate (to the owner) | decline (nits only). Fixes are applied by one revision call. Every finding and
//             its resolution is preserved. Stop after a clean round (no open blocker/major) or the round cap.
// Deterministic structural checks run every round regardless of the model (a small model shares its own blind spots).
const SEVERITIES = ['blocker', 'major', 'nit'];
const TYPES = ['missing-step', 'unsupported-assumption', 'contradiction', 'incomplete-sequence', 'other'];

async function json(complete, system, user, retries = 1) {
  let last = '';
  for (let i = 0; i <= retries; i += 1) {
    last = String(await complete(system, i ? `${user}\n\nYour previous reply was not valid JSON. Reply with JSON only.` : user));
    const m = /\{[\s\S]*\}/.exec(last); if (!m) continue;
    try { return { ok: true, value: JSON.parse(m[0]), raw: last }; } catch { /* retry */ }
  }
  return { ok: false, value: null, raw: last };
}

/** Deterministic structure checks on a plan (findings with lens 'structure'). */
export function structuralFindings(plan, excerpts, round) {
  const out = []; let n = 0;
  const add = (severity, type, stepId, issue, suggestion) => out.push({ id: `structure-${round}-${++n}`, lens: 'structure', severity, type, stepId, evidence: null, issue, suggestion, evidenceVerified: true });
  const ids = new Set(Object.keys(excerpts));
  for (const s of plan?.steps ?? []) {
    if (!s.expects) add('major', 'incomplete-sequence', s.id, `step ${s.id} has no expected outcome`, 'state what observable result shows the step worked');
    if (!s.onFailure) add('major', 'missing-step', s.id, `step ${s.id} has no failure handling`, 'say what happens if the step fails');
    for (const c of s.cites ?? []) if (!ids.has(c)) add('major', 'unsupported-assumption', s.id, `step ${s.id} cites unknown source "${c}"`, 'cite an excerpt id that exists');
  }
  for (const d of plan?.decisionPoints ?? []) {
    if (!d.ifTrue || !d.ifFalse) add('blocker', 'incomplete-sequence', d.id, `decision ${d.id} lacks ${!d.ifTrue ? 'the true' : 'the false'} branch`, 'give both branches');
    for (const c of d.cites ?? []) if (!ids.has(c)) add('major', 'unsupported-assumption', d.id, `decision ${d.id} cites unknown source "${c}"`, 'cite an excerpt id that exists');
  }
  if (!(plan?.checks ?? []).some((c) => c.objective)) add('blocker', 'missing-step', null, 'no objective check', 'add a check that proves the goal was met');
  if (!(plan?.prerequisites ?? []).length) add('major', 'missing-step', null, 'no prerequisites listed', 'list tools and inputs needed before starting');
  return out;
}

/** Elephant: draft the plan. pipeline = Kingmaker's validated pieces (commands, views, rules, objective, research). */
export async function elephantPlan({ goal, excerpts, pipeline, complete }) {
  const src = Object.entries(excerpts).map(([id, t]) => `[${id}] ${t}`).join('\n').slice(0, 5000);
  const r = await json(complete, 'You are the planner. You write a complete, executable plan. Reply with JSON only.',
    `GOAL: ${goal}\nSOURCES (cite by id):\n${src}\nVALIDATED PIECES (from code and checks; keep them):\n${JSON.stringify(pipeline).slice(0, 3500)}\n\nWrite the plan as JSON: {"prerequisites": ["..."], "state": ["what the decider observes"], "steps": [{"id": "s1", "action": "...", "tool": "...", "expects": "observable result", "onFailure": "...", "cites": ["source id"]}], "decisionPoints": [{"id": "d1", "condition": "...", "ifTrue": "...", "ifFalse": "...", "cites": ["source id"]}], "checks": [{"id": "c1", "check": "...", "objective": true}]}`);
  return { plan: r.value, raw: r.raw, ok: r.ok };
}

/** Goldfish: fresh review. The input is built ONLY from rubric + plan + excerpts (no conversation). */
export async function goldfishReview({ plan, excerpts, rubric, complete, round, lens = 'grounding' }) {
  const src = Object.entries(excerpts).map(([id, t]) => `[${id}] ${t}`).join('\n').slice(0, 5000);
  const r = await json(complete, 'You are a reviewer seeing this plan for the first time. Find real problems only. Reply with JSON only.',
    `RUBRIC:\n${rubric}\n\nSOURCES:\n${src}\n\nPLAN:\n${JSON.stringify(plan).slice(0, 3500)}\n\nReply {"findings": [{"severity": "blocker|major|nit", "type": "${TYPES.join('|')}", "stepId": "s1|d1|null", "evidence": "exact short quote from the plan or a source", "issue": "...", "suggestion": "..."}]} (empty list if none).`);
  if (!r.ok) return { ran: false, raw: r.raw, findings: [] }; // a failed reviewer is "not run", never "zero findings"
  const hay = `${JSON.stringify(plan)}\n${Object.values(excerpts).join('\n')}`.toLowerCase();
  const findings = (r.value.findings ?? []).slice(0, 12).map((f, i) => ({
    id: `goldfish-${lens}-${round}-${i + 1}`, lens, severity: SEVERITIES.includes(f.severity) ? f.severity : 'major', type: TYPES.includes(f.type) ? f.type : 'other',
    stepId: f.stepId ?? null, evidence: f.evidence ?? null, issue: String(f.issue ?? '').slice(0, 400), suggestion: String(f.suggestion ?? '').slice(0, 400),
    evidenceVerified: Boolean(f.evidence) && hay.includes(String(f.evidence).toLowerCase().replace(/\s+/g, ' ').slice(0, 200)),
  }));
  return { ran: true, raw: r.raw, findings };
}

/** Elephant resolves findings; contests must cite an excerpt whose text is verified here; otherwise escalated. */
export async function resolveFindings({ plan, findings, excerpts, complete, round }) {
  if (!findings.length) return { plan, log: [] };
  const r = await json(complete, 'You are the planner answering a review. Reply with JSON only.',
    `PLAN:\n${JSON.stringify(plan).slice(0, 3000)}\nFINDINGS:\n${JSON.stringify(findings.map(({ id, severity, type, stepId, issue, suggestion }) => ({ id, severity, type, stepId, issue, suggestion })))}\nSOURCES: ${Object.keys(excerpts).join(', ')}\n\nFor each finding decide: "fix", "contest" (only with a source id and an exact quote from it), "escalate" (needs the owner), or "decline" (nits only). Reply {"decisions": [{"id": "...", "decision": "...", "justification": "...", "citation": {"source": "id", "quote": "..."}}]}`);
  const byId = Object.fromEntries((r.value?.decisions ?? []).map((d) => [d.id, d]));
  const log = findings.map((f) => {
    let d = byId[f.id] ?? { decision: 'escalate', justification: 'no decision returned by the planner' };
    if (d.decision === 'contest') { const q = String(d.citation?.quote ?? '').toLowerCase(); const t = String(excerpts[d.citation?.source] ?? '').toLowerCase(); if (!q || !t.includes(q)) d = { ...d, decision: 'escalate', justification: `contest without a verified citation → escalated (${d.justification ?? ''})` }; }
    if (d.decision === 'decline' && f.severity !== 'nit') d = { ...d, decision: 'escalate', justification: `only nits may be declined → escalated (${d.justification ?? ''})` };
    if (!['fix', 'contest', 'escalate', 'decline'].includes(d.decision)) d = { decision: 'escalate', justification: 'unknown decision' };
    return { finding: f.id, severity: f.severity, decision: d.decision, justification: String(d.justification ?? '').slice(0, 300), citation: d.citation ?? null, round, status: d.decision === 'fix' ? 'fixed' : d.decision === 'contest' || d.decision === 'decline' ? 'settled' : 'escalated' };
  });
  const toFix = findings.filter((f) => log.find((l) => l.finding === f.id)?.decision === 'fix');
  let revised = plan;
  if (toFix.length) {
    const rev = await json(complete, 'You are the planner revising your plan. Keep everything that was not criticised. Reply with the full revised plan as JSON only.',
      `PLAN:\n${JSON.stringify(plan).slice(0, 3500)}\nFIX THESE:\n${JSON.stringify(toFix.map(({ id, stepId, issue, suggestion }) => ({ id, stepId, issue, suggestion })))}`);
    if (rev.ok && Array.isArray(rev.value?.steps)) revised = rev.value;
    else for (const l of log) if (l.decision === 'fix') { l.status = 'escalated'; l.justification += ' (revision call failed → escalated)'; }
  }
  return { plan: revised, log, raw: r.raw };
}

/** Full loop. Returns { plan, rounds:[{findings, log, reviewerRan}], open, escalated, calls, stoppedBecause }. */
export async function elephantGoldfish({ goal, excerpts, pipeline, rubric, complete, maxRounds = 3 }) {
  const rounds = []; let calls = 0;
  const counted = async (s, u) => { calls += 1; return complete(s, u); };
  const first = await elephantPlan({ goal, excerpts, pipeline, complete: counted });
  if (!first.ok) return { plan: null, rounds, open: [], escalated: [], calls, stoppedBecause: 'planner returned no valid plan' };
  let plan = first.plan, clean = 0, stoppedBecause = `round cap (${maxRounds})`;
  for (let round = 1; round <= maxRounds; round += 1) {
    const structural = structuralFindings(plan, excerpts, round);
    const g = await goldfishReview({ plan, excerpts, rubric, complete: counted, round });
    const findings = [...structural, ...g.findings.filter((f) => f.evidenceVerified || f.severity === 'blocker')];
    const dropped = g.findings.filter((f) => !f.evidenceVerified && f.severity !== 'blocker').map((f) => f.id);
    const serious = findings.filter((f) => f.severity !== 'nit');
    if (!g.ran) { rounds.push({ round, reviewerRan: false, findings: structural, log: [], dropped }); stoppedBecause = 'reviewer did not return valid JSON (not run ≠ clean)'; break; }
    if (!serious.length) { rounds.push({ round, reviewerRan: true, findings, log: [], dropped }); clean += 1; if (clean >= 1) { stoppedBecause = 'clean round'; break; } continue; }
    const res = await resolveFindings({ plan, findings, excerpts, complete: counted, round });
    rounds.push({ round, reviewerRan: true, findings, log: res.log, dropped }); plan = res.plan; clean = 0;
  }
  const all = rounds.flatMap((r) => r.log);
  const lastStructural = structuralFindings(plan, excerpts, 'final');
  return { plan, rounds, escalated: all.filter((l) => l.status === 'escalated'), open: lastStructural.filter((f) => f.severity !== 'nit'), calls, stoppedBecause };
}
