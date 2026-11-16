import test from 'node:test';
import assert from 'node:assert/strict';
import { ruleLines, decide } from '../lib/pilot-prompt.mjs';
const G = 'HOW TO READ: x\nRULES — in order.\n1. CHANGING: if previous turned toward wind and wind INSIDE: keep turning.\n2. ZONE: otherwise, if wind INSIDE: turn away.\n3. GOAL INSIDE: ONLY when wind OUTSIDE and goal INSIDE:\n   3a. if different sides: turn toward goal;\n   3b. otherwise, if IN THE BEST BAND: turn "straight";\n4. GOAL: ONLY when outside: steer at goal.';
test('ruleLines parses top rules and sub-rules', () => {
  assert.deepEqual(ruleLines(G).map((r) => r.id), ['1', '2', '3', '3a', '3b', '4']);
  assert.equal(ruleLines(G).find((r) => r.id === '3b').parent, '3');
});
test('decompose: the model classifies from conditions only, then decides under the chosen rule; votes are majorities', async () => {
  const seen = [];
  const ask = async (system, user, o) => { seen.push({ system, o }); if (/say which rule applies/.test(system)) return { d: { rule: '3b' }, raw: '' }; return { d: { turn: /RULE 3b APPLIES/.test(system) ? 'straight' : 'left', amount: 0, sheet: 0.3, rule: '3b' }, raw: '' }; };
  const r = await decide({ ask, guidance: G, fields: { helm: [-1, 1], sheet: [0, 1] }, turnField: 'helm', userMsg: 'OBS', votes: 3, decompose: true });
  assert.equal(r.classify.rule, '3b'); assert.equal(r.d.turn, 'straight'); assert.equal(r.calls, 6);
  const cls = seen.find((x) => /say which rule applies/.test(x.system)).system;
  assert.ok(!/turn "straight"|turn away|keep turning/.test(cls), 'classification sees conditions, not actions');
});
test('no agreed rule falls back to the full method prompt (still a model decision)', async () => {
  let k = 0;
  const ask = async (system) => { if (/say which rule applies/.test(system)) return { d: { rule: ['1', '2', '9'][k++ % 3] }, raw: '' }; return { d: { turn: 'right', amount: 0.5, sheet: 0.2 }, raw: '' }; };
  const r = await decide({ ask, guidance: G, fields: { helm: [-1, 1], sheet: [0, 1] }, turnField: 'helm', userMsg: 'OBS', votes: 3, decompose: true });
  assert.equal(r.d.turn, 'right'); assert.ok(r.classify.fallback || r.classify.rule);
});
