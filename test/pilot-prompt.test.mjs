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
test('a parent rule with sub-rules triggers a second model classification among its sub-rules', async () => {
  const ask = async (system) => { if (/SUB-RULE CONDITIONS/.test(system)) return { d: { rule: '3b' }, raw: '' }; if (/say which rule applies/.test(system)) return { d: { rule: '3' }, raw: '' }; return { d: { turn: /RULE 3b APPLIES/.test(system) ? 'straight' : 'left', amount: 0, sheet: 0.3 }, raw: '' }; };
  const r = await decide({ ask, guidance: G, fields: { helm: [-1, 1], sheet: [0, 1] }, turnField: 'helm', userMsg: 'OBS', votes: 3, decompose: true });
  assert.equal(r.classify.rule, '3b'); assert.deepEqual(r.classify.sub, ['3b', '3b', '3b']); assert.equal(r.d.turn, 'straight');
});
test('level words: the pilot answers a word for a one-sided field; the value is converted, never chosen by code', async () => {
  const { levelValue } = await import('../lib/pilot-prompt.mjs');
  assert.equal(levelValue('off', [0, 1]), 0); assert.equal(levelValue('High', [0, 1]), 0.75); assert.ok(Number.isNaN(levelValue('lots', [0, 1])));
  let sys = '';
  const ask = async (system) => { sys = system; return { d: { heat_level: 'off', reason: 'too hot' }, raw: '' }; };
  const r = await decide({ ask, guidance: 'g', fields: { heat: [0, 1] }, turnField: null, userMsg: 'OBS', levelField: 'heat' });
  assert.equal(r.d.heat, 0); assert.match(sys, /"heat_level" \(one of "off", "low", "medium", "high", "full"\)/); assert.doesNotMatch(sys, /"heat" \(number/);
});
test('diff views describe a measured difference in words (state, not action)', async () => {
  const { perceive } = await import('../lib/perception.mjs');
  const v = perceive({ temp: 22.9, setpoint: 21 }, { t: ['diff', 'temp', 'setpoint', 'the room temperature', 'the setpoint'] });
  assert.equal(v.t, 'the room temperature is 1.9 ABOVE the setpoint');
  assert.equal(perceive({ temp: 20.98, setpoint: 21 }, { t: ['diff', 'temp', 'setpoint', 'temp', 'setpoint'] }).t, 'temp is equal to setpoint');
});
