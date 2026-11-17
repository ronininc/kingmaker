// The writer's CLOSED-LOOP validation (lib/method-decisions.mjs testRuleSequences), on a pure-JS fake fixture.
// Recorded failure it targets: thermostat t7 — every rule passed its one-step effect check, yet the rules together stalled
// short of the tolerance at high setpoints. Such a method must be rejected (and the stalling rule blamed), not promoted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { testRuleSequences } from '../lib/method-decisions.mjs';

// heat model: temp += heat − 0.05·(temp − 10); setpoint is the setup input
function fakeFx() {
  const step = (o, h) => ({ ...o, temp: Math.round((o.temp + h - 0.05 * (o.temp - 10)) * 1e4) / 1e4, t: o.t + 1 });
  return {
    inputs: { setpoint: 21 },
    start: (v) => ({ obs: [{ t: 0, temp: 15, setpoint: v.setpoint ?? 21, terminal: false }] }),
    extend: (r, h) => { const o = step(r.obs.at(-1), Number(h)); r.obs.push(o); return o; },
  };
}
const view = { a: 'temp', b: 'setpoint', label: 'temp', refLabel: 'setpoint' };
const decision = { name: 'heat', min: 0, max: 1 };
const rule = (side, more_than, at_most, level) => ({ structured: { side, more_than, at_most, level, effect: 'TOWARD' } });

test('rules that stall short of the tolerance fail closed-loop and the stalling rule is blamed', () => {
  // "slightly below → medium": medium (0.5) holds temp near 20, so at setpoint 27.3 it can never reach within 0.75
  const rules = [rule('BELOW', 0.75, null, 'full'), rule('BELOW', null, 0.75, 'medium'), rule('EQUAL', null, null, 'medium'), rule('ABOVE', null, 0.75, 'off'), rule('ABOVE', 0.75, null, 'off')];
  const r = testRuleSequences({ fx: fakeFx(), rules, view, decision, tolerance: 0.75, steps: 30 });
  assert.equal(r.ok, false);
  assert.ok(r.runs.some((x) => !x.ok && /27\.3/.test(x.setup)), JSON.stringify(r.runs.map(({ path, ...x }) => x)));
  assert.equal(r.blame.rule, 1, 'the "slightly below → medium" rule is the one that moves the output back away');
  assert.match(r.blame.text, /STAY there for 3 steps/);
});

test('rules whose holding level depends on the setpoint are accepted when they reach and hold the tolerance', () => {
  // bang-bang: at or below the setpoint → full, above → off (it reaches the band and holds it at every setpoint tried)
  const rules = [rule('BELOW', 0.75, null, 'full'), rule('BELOW', null, 0.75, 'full'), rule('EQUAL', null, null, 'full'), rule('ABOVE', null, 0.75, 'off'), rule('ABOVE', 0.75, null, 'off')];
  const r = testRuleSequences({ fx: fakeFx(), rules, view, decision, tolerance: 0.75, steps: 40 });
  assert.equal(r.ok, true, JSON.stringify(r.runs.map(({ path, ...x }) => x)));
});

test('no fixture or no tolerance: the check reports it did not run (never a pass)', () => {
  assert.equal(testRuleSequences({ fx: null, rules: [], view, decision, tolerance: 0.75 }).ok, null);
  assert.equal(testRuleSequences({ fx: fakeFx(), rules: [], view, decision, tolerance: null }).ok, null);
});

test('a run still steadily approaching when the budget ends is inconclusive — not blamed, not a pass', () => {
  // only "full" below: correct, but from far below at a high setpoint the physics needs more steps than the budget
  const rules = [rule('BELOW', 0.75, null, 'full'), rule('BELOW', null, 0.75, 'full'), rule('EQUAL', null, null, 'full'), rule('ABOVE', null, 0.75, 'off'), rule('ABOVE', 0.75, null, 'off')];
  const r = testRuleSequences({ fx: fakeFx(), rules, view, decision, tolerance: 0.75, steps: 6 });
  assert.equal(r.ok, null, JSON.stringify(r.runs.map(({ path, ...x }) => x)));
  assert.equal(r.blame, null);
  assert.ok(r.runs.some((x) => x.ok === null && /inconclusive/.test(x.note)));
});
