import test from 'node:test';
import assert from 'node:assert/strict';
import { elephantGoldfish, structuralFindings, resolveFindings } from '../lib/elephant-goldfish.mjs';

const excerpts = { 'kit:prompt': 'Make every steering and sail decision yourself from each returned world state.', 'code:polar': 'polar(twa) is low below 48 degrees' };
const MARKER = 'PLANNER-ONLY-CONTEXT-7731';
function fake({ reviewerOk = true, contestQuote = null, declineMajor = false } = {}) {
  const seen = { reviewerInputs: [] };
  const complete = async (system, user) => {
    if (/You are the planner\. You write/.test(system)) return JSON.stringify({ prerequisites: ['python3'], state: ['wind zone'], steps: [{ id: 's1', action: 'init', tool: 'sim.py init', cites: ['kit:prompt'] }], decisionPoints: [{ id: 'd1', condition: 'wind inside zone', ifTrue: 'turn away', cites: ['code:polar'] }], checks: [{ id: 'c1', check: 'verify finished', objective: true }] });
    if (/reviewer seeing this plan/.test(system)) { seen.reviewerInputs.push(system + user); if (!reviewerOk) return 'not json'; return JSON.stringify({ findings: [{ severity: 'major', type: 'missing-step', stepId: 's1', evidence: 'Make every steering and sail decision yourself', issue: 'no statement that the model decides', suggestion: 'add it' }, { severity: 'major', type: 'other', stepId: null, evidence: 'made up quote not anywhere', issue: 'x', suggestion: 'y' }] }); }
    if (/answering a review/.test(system)) { const ids = [...user.matchAll(/"id":"([^"]+)"/g)].map((m) => m[1]); return JSON.stringify({ decisions: ids.map((id) => (contestQuote && id.startsWith('goldfish') ? { id, decision: 'contest', justification: 'source says so', citation: { source: 'kit:prompt', quote: contestQuote } } : declineMajor && id.startsWith('goldfish') ? { id, decision: 'decline', justification: 'meh' } : { id, decision: 'fix', justification: 'ok' })) }); }
    if (/revising your plan/.test(system)) return JSON.stringify({ prerequisites: ['python3'], state: ['wind zone'], steps: [{ id: 's1', action: 'init; the model decides every turn', tool: 'sim.py init', expects: 'run initialised', onFailure: 'stop and report', cites: ['kit:prompt'] }], decisionPoints: [{ id: 'd1', condition: 'wind inside zone', ifTrue: 'turn away', ifFalse: 'steer to goal', cites: ['code:polar'] }], checks: [{ id: 'c1', check: 'verify finished', objective: true }] });
    return '{}';
  };
  return { complete, seen };
}

test('structural checks find missing outcomes, failure handling, branches and unknown citations', () => {
  const f = structuralFindings({ steps: [{ id: 's1', cites: ['nope'] }], decisionPoints: [{ id: 'd1', ifTrue: 'x' }], checks: [], prerequisites: [] }, excerpts, 1);
  const issues = f.map((x) => x.issue).join(' | ');
  for (const re of [/no expected outcome/, /no failure handling/, /unknown source/, /lacks the false branch/, /no objective check/, /no prerequisites/]) assert.match(issues, re);
});

test('Goldfish sees only rubric + plan + sources (fresh context); fixes resolve findings; unverifiable evidence is dropped', async () => {
  const { complete, seen } = fake();
  const r = await elephantGoldfish({ goal: `sail the race ${MARKER}`, excerpts, pipeline: { note: MARKER }, rubric: 'Every claim cites a source.', complete });
  assert.ok(seen.reviewerInputs.length >= 1);
  for (const inp of seen.reviewerInputs) assert.ok(!inp.includes(MARKER), 'reviewer must not see the planner context');
  const r1 = r.rounds[0];
  assert.ok(r1.findings.some((f) => f.lens === 'structure'));
  assert.ok(r1.dropped.length === 1, 'the finding with a made-up quote is dropped, and recorded as dropped');
  assert.ok(r1.log.every((l) => l.status === 'fixed'));
  assert.equal(r.open.length, 0);
  assert.ok(r.calls >= 4);
});

test('a contest without a verified citation is escalated; declining a major finding is escalated', async () => {
  const plan = { steps: [{ id: 's1', expects: 'x', onFailure: 'y' }], decisionPoints: [], checks: [{ objective: true }], prerequisites: ['p'] };
  const findings = [{ id: 'goldfish-g-1-1', severity: 'major', type: 'other', stepId: 's1', issue: 'i', suggestion: 's' }];
  const bad = await resolveFindings({ plan, findings, excerpts, complete: fake({ contestQuote: 'this text is not in the source' }).complete, round: 1 });
  assert.equal(bad.log[0].status, 'escalated'); assert.match(bad.log[0].justification, /without a verified citation/);
  const good = await resolveFindings({ plan, findings, excerpts, complete: fake({ contestQuote: 'make every steering and sail decision yourself' }).complete, round: 1 });
  assert.equal(good.log[0].status, 'settled');
  const dec = await resolveFindings({ plan, findings, excerpts, complete: fake({ declineMajor: true }).complete, round: 1 });
  assert.equal(dec.log[0].status, 'escalated');
});

test('a reviewer that returns no valid JSON is "not run", never a clean round', async () => {
  const r = await elephantGoldfish({ goal: 'g', excerpts, pipeline: {}, rubric: 'r', complete: fake({ reviewerOk: false }).complete });
  assert.equal(r.rounds[0].reviewerRan, false);
  assert.match(r.stoppedBecause, /not run/);
});

test('citation ids written loosely by a small model resolve to the real id; truly unknown ids stay findings', async () => {
  const { canonicalCite, canonicalizePlan } = await import('../lib/elephant-goldfish.mjs');
  const ex = { 'CLAUDE_PROMPT.md:7': 'x', 'README.md:12': 'y' };
  assert.equal(canonicalCite('CLAUDE_Prompt. md:7', ex), 'CLAUDE_PROMPT.md:7');
  assert.equal(canonicalCite('readme.md:12', ex), 'README.md:12');
  assert.equal(canonicalCite('README.md:99', ex), null);
  const p = canonicalizePlan({ steps: [{ id: 's1', cites: ['CLAUDE_Prompt. md:7', 'nope:1'], expects: 'e', onFailure: 'f' }], decisionPoints: [], checks: [{ objective: true }], prerequisites: ['p'] }, ex);
  assert.deepEqual(p.steps[0].cites, ['CLAUDE_PROMPT.md:7', 'nope:1']);
  const f = structuralFindings(p, ex, 1);
  assert.equal(f.length, 1); assert.match(f[0].issue, /unknown source "nope:1"/);
});
