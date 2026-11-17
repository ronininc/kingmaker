// Decision-by-decision method writing (lib/method-decisions.mjs): retrieval, plain → structured, support, coverage,
// fixture effect tests with counterexamples, per-rule repair. A scripted writer stands in for the local model; the
// fixture runs a tiny synthetic heater kit (written here) inside sandbox-exec. No model, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildExcerpts, coverage, fixturePermission, matches, renderDecisionGuidance, retrieveExcerpts, writeDecisionRules } from '../lib/method-decisions.mjs';
import { readSources } from '../lib/method-from-source.mjs';

const README = `# Heat kit (synthetic test fixture)

- Heater output heat is 0 (off) to 1 (full). Full output adds 1.0 C per minute; the room loses 0.05 x (room - outside) C per minute.
- The run succeeds if the room is within 0.75 C of the setpoint for the final 10 steps.

\`\`\`sh
python3 sim.py init --run runs/x --setpoint 21
python3 sim.py observe --run runs/x
python3 sim.py step --run runs/x --heat HEAT --reason "YOUR DECISION"
python3 sim.py verify --run runs/x
\`\`\`
`;
const SIM = `import json, sys, os
def advance(temp, heat):
    return round(temp + 1.0 * heat - 0.05 * (temp - 10.0), 4)
def main():
    a = sys.argv[1:]; cmd = a[0]; run = a[a.index('--run') + 1]; p = os.path.join(run, 'state.json')
    if cmd == 'init':
        os.makedirs(run); sp = float(a[a.index('--setpoint') + 1]); s = {'t': 0, 'temp': 15.0, 'setpoint': sp}
    else:
        s = json.load(open(p))
    if cmd == 'step':
        s['temp'] = advance(s['temp'], min(1.0, max(0.0, float(a[a.index('--heat') + 1])))); s['t'] += 1
    json.dump(s, open(p, 'w')); print(json.dumps({'t': s['t'], 'temp': s['temp'], 'setpoint': s['setpoint'], 'terminal': s['t'] >= 40}))
main()
`;
const have = fs.existsSync('/usr/bin/sandbox-exec') && fs.existsSync('/usr/bin/python3') && fs.existsSync('/usr/bin/zip');
const opts = have ? {} : { skip: 'needs macOS sandbox-exec, python3 and zip' };

function kit({ readme = README } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'km-dec-')));
  const k = path.join(root, 'heatkit'); fs.mkdirSync(k);
  fs.writeFileSync(path.join(k, 'README.md'), readme); fs.writeFileSync(path.join(k, 'sim.py'), SIM);
  execFileSync('/usr/bin/zip', ['-qr', path.join(root, 'kit.zip'), 'heatkit'], { cwd: root });
  const work = path.join(root, 'work'); fs.mkdirSync(work);
  const sources = readSources([path.join(root, 'kit.zip')], { workDir: work });
  const line = (n) => n.split(' ').map((t) => t.replace(/^"|"$/g, ''));
  const plan = { setup: { argv: line('python3 sim.py init --run runs/x --setpoint 21') }, observe: { argv: line('python3 sim.py observe --run runs/x') }, act: { argv: ['python3', 'sim.py', 'step', '--run', 'runs/x', '--heat', 'HEAT', '--reason', 'YOUR DECISION'] } };
  return { root, work, sources, plan, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const view = { name: 'temp_vs_setpoint', op: 'diff', a: 'temp', b: 'setpoint', label: 'temp', refLabel: 'setpoint' };
const decision = { name: 'heat', min: 0, max: 1, meaning: 'heater output' };

/** Scripted writer: decides each situation; one physically WRONG first answer (full heat when far ABOVE); `fixes` says
 *  whether the repair (which shows the failed answer) corrects it. */
function writer({ fixes = true, tolCite = 'README.md:L4', reaskView = { a: 'final_temp', b: 'setpoint' } } = {}) {
  const prompts = [];
  const structured = (when, d) => {
    const w = when.toLowerCase(); const n = (when.match(/\d+(\.\d+)?/) ?? [null])[0];
    const side = /equal/.test(w) ? 'EQUAL' : /within/.test(w) ? 'ANY' : /above/.test(w) ? 'ABOVE' : 'BELOW';
    return { side, more_than: /more than/.test(w) ? Number(n) : null, at_most: /within|at most/.test(w) ? Number(n) : null, level: d, effect: /equal|within|at most/.test(w) ? 'STAY' : 'TOWARD' };
  };
  const complete = async (system, user) => {
    prompts.push(user);
    if (/Your proposed comparisons were refused/.test(user)) return JSON.stringify(reaskView);
    if (/Which number, stated in one of the excerpts/.test(user)) return JSON.stringify({ number: 0.75, cite: tolCite });
    const sit = /SITUATION: ([^\n]*?)\.( \(|\n)/.exec(user);
    if (sit) {
      const w = sit[1]; const failed = /ALREADY FAILED/.test(user);
      const d = /ABOVE setpoint by MORE/.test(w) ? (failed ? (fixes ? 'off' : 'high') : 'full') : /ABOVE/.test(w) ? 'off' : /BELOW setpoint by MORE/.test(w) ? 'full' : /BELOW/.test(w) ? 'full' : 'medium';
      return JSON.stringify({ when: w, do: d, effect: 'from the physics', cite: ['README.md:3'] });
    }
    const conv = /^RULE: when "([^"]*)"; do "([^"]*)"/.exec(user); if (conv) return JSON.stringify(structured(conv[1], conv[2]));
    throw new Error(`unexpected prompt: ${user.slice(0, 80)}`);
  };
  return { complete, prompts };
}

test('excerpts carry stable citation ids; Jev keeps only what it judges relevant (fallback recorded)', opts, async () => {
  const k = kit();
  try {
    const ex = buildExcerpts(k.sources);
    assert.ok(ex.some((e) => e.id === 'README.md:L3' && /Full output adds 1.0/.test(e.text)));
    assert.ok(ex.some((e) => /^sim\.py:L2-3$/.test(e.id) && /def advance/.test(e.text)), JSON.stringify(ex.map((e) => e.id)));
    const judge = async ({ prompt }) => (/Full output|def advance|0\.75/.test(prompt.split('EXCERPT')[1]) ? { decided: true, letter: 'A', probabilities: { A: 0.9, B: 0.1 } } : { decided: true, letter: 'B', probabilities: { A: 0.2, B: 0.8 } });
    const r = await retrieveExcerpts({ instruction: 'hold the setpoint', excerpts: ex, decision, judge });
    assert.deepEqual(r.kept.map((e) => e.id).sort(), ['README.md:L3', 'README.md:L4', 'sim.py:L2-3']);
    const unsure = await retrieveExcerpts({ instruction: 'x', excerpts: ex, decision, judge: async () => ({ decided: false, reason: 'unsure', probabilities: { A: 0.5, B: 0.5 } }) });
    assert.equal(unsure.kept.length, 3); assert.match(unsure.fallback, /highest P\(yes\)/);
  } finally { k.cleanup(); }
});

test('conditions, coverage gaps and never-reached rules are computed exactly', () => {
  const R = (s) => ({ structured: s });
  assert.equal(matches({ side: 'ABOVE', more_than: 0.75 }, 0.8), true);
  assert.equal(matches({ side: 'ABOVE', more_than: 0.75 }, 0.7), false);
  assert.equal(matches({ side: 'ANY', at_most: 0.75 }, -0.75), true);
  const c = coverage([R({ side: 'BELOW', more_than: 0.75 }), R({ side: 'ABOVE', more_than: 0.75 })]);
  assert.deepEqual(c.gaps.map((g) => [g.from, g.to]), [[-0.75, 0.75]]);
  const s = coverage([R({ side: 'ANY' }), R({ side: 'BELOW', more_than: 1 })]);
  assert.deepEqual(s.shadowed, [1]); assert.equal(s.gaps.length, 0);
});

test('trial-run permission: the boat kit wording forbids it; a plain kit allows it', () => {
  assert.equal(fixturePermission({ files: [{ rel: 'README.md', text: 'Use one scored run, no restarts or practice races.' }] }).permitted, false);
  assert.equal(fixturePermission({ files: [{ rel: 'README.md', text: 'Do not run practice laps before the race.' }] }).permitted, false);
  assert.equal(fixturePermission({ files: [{ rel: 'README.md', text: README }] }).permitted, true);
});

test('a physically wrong rule is caught by the fixture, repaired with its counterexample; passing rules kept verbatim', opts, async () => {
  const k = kit(); const w = writer({ fixes: true }); const trace = [];
  try {
    const r = await writeDecisionRules({ instruction: 'keep the room at the setpoint', sources: k.sources, plan: k.plan, decision, view, complete: w.complete, fixtureDir: k.work, trace });
    assert.equal(r.status, 'pass', r.problems.join('\n'));
    assert.equal(r.fixture.used, true); assert.ok(r.fixture.probes > 0);
    assert.equal(r.tolerance.number, 0.75); assert.equal(r.rules.length, 5);
    assert.equal(r.repairs.length, 1); assert.equal(r.repairs[0].rule, 5);
    assert.match(r.repairs[0].problem, /AWAY from setpoint/); assert.match(r.repairs[0].problem, /setup --setpoint/);
    const repairPrompt = w.prompts.find((p) => /ALREADY FAILED/.test(p)); assert.match(repairPrompt, /do "full": effect: Fixture test/);
    assert.equal(r.rules[4].structured.level, 'off'); assert.equal(r.rules[4].repairs, 1); assert.equal(r.rules[4].history[0].structured.level, 'full');
    for (const k of [0, 1, 2, 3]) { assert.equal(r.rules[k].origin, 'draft'); assert.equal(r.rules[k].repairs, 0); }
    assert.deepEqual(r.rules[0].cite.sort(), ['README.md:L3', 'README.md:L4']);
    for (const rule of r.rules) assert.ok(rule.effectCheck.measured.every((m) => m.ok), JSON.stringify(rule.effectCheck));
    assert.match(r.guidance, /5\. If temp is ABOVE setpoint by MORE than 0\.75 \(for example: "temp is 2\.5 ABOVE setpoint"\): heat_level "off"/);
    assert.match(r.guidance, /Source: README\.md:L3/);
    // the sandbox kept every probe inside the fixture folder
    assert.ok(fs.existsSync(path.join(k.work, 'fixture', 'kit', 'runs')));
  } finally { k.cleanup(); }
});

test('a rule the writer cannot fix fails after the repair limit and rejects the method', opts, async () => {
  const k = kit(); const w = writer({ fixes: false });
  try {
    const r = await writeDecisionRules({ instruction: 'keep the room at the setpoint', sources: k.sources, plan: k.plan, decision, view, complete: w.complete, fixtureDir: k.work, maxRepairs: 2 });
    assert.equal(r.status, 'fail'); assert.equal(r.guidance, null);
    assert.equal(r.rules[4].repairs, 2); assert.equal(w.prompts.filter((p) => /ALREADY FAILED/.test(p)).length, 2);
    assert.match(r.problems[0], /still fails after 2 repair/);
  } finally { k.cleanup(); }
});

test('a tolerance not stated in the cited excerpt is refused; situations then carry no number (recorded)', opts, async () => {
  const k = kit(); const w = writer({ fixes: true, tolCite: 'README.md:L3' }); const trace = [];
  try {
    const r = await writeDecisionRules({ instruction: 'keep the room at the setpoint', sources: k.sources, plan: k.plan, decision, view, complete: w.complete, fixtureDir: k.work, trace });
    assert.equal(r.tolerance, null); assert.equal(w.prompts.filter((p) => /Which number/.test(p)).length, 2);
    assert.match(w.prompts.filter((p) => /Which number/.test(p))[1], /0\.75 does not appear in README\.md:L3/);
    assert.deepEqual(trace.find((t) => t.step === 'decisions-situations').situations, ['temp is BELOW setpoint', 'temp is equal to setpoint', 'temp is ABOVE setpoint']);
  } finally { k.cleanup(); }
});

test('without trial-run permission the effect is model-reviewed and marked unmeasured; nothing is executed', opts, async () => {
  const k = kit({ readme: `${README}\nUse one scored run, no restarts or practice runs.\n` });
  const w = writer({ fixes: true });
  const inner = w.complete;
  w.complete = async (s, u) => (/does temp move TOWARD setpoint or AWAY/.test(u) ? JSON.stringify({ option: Number(/(\d): TOWARD/.exec(u)[1]), why: 'README.md:L3' }) : inner(s, u));
  try {
    const r = await writeDecisionRules({ instruction: 'keep the room at the setpoint', sources: k.sources, plan: k.plan, decision, view, complete: w.complete, fixtureDir: k.work });
    assert.equal(r.fixture.permitted, false); assert.equal(r.fixture.used, false); assert.equal(r.fixture.probes, 0);
    assert.equal(fs.existsSync(path.join(k.work, 'fixture')), false);
    assert.ok(r.rules.every((x) => x.effectCheck?.unmeasured === true));
  } finally { k.cleanup(); }
});

test('rendered guidance states each condition in the perception words and its citation', () => {
  const g = renderDecisionGuidance({ view, decision, rules: [{ structured: { side: 'ANY', more_than: null, at_most: 0.75, level: 'medium', effect: 'STAY' }, cite: ['README.md:L4'] }] });
  assert.match(g, /1\. If temp is within 0\.75 of setpoint \(above, below or equal\) \(for example: "temp is 0\.38 BELOW setpoint"\): heat_level "medium"\. \(Expected: temp stays within 0\.75 of setpoint\. Source: README\.md:L4\)/);
});

test('a comparison over a field the observation does not return is refused before any writing (or the next valid one is used)', opts, async () => {
  const k = kit(); const w = writer({ fixes: true });
  try {
    const bad = { name: 'final_temp_vs_setpoint', op: 'diff', a: 'final_temp', b: 'setpoint', label: 'final temperature', refLabel: 'setpoint' };
    const r1 = await writeDecisionRules({ instruction: 'x', sources: k.sources, plan: k.plan, decision, views: [bad], complete: w.complete, fixtureDir: k.work });
    assert.equal(r1.status, 'fail'); assert.match(r1.problems[0], /no proposed comparison .* uses numeric fields of the real observation/); assert.equal(w.prompts.length, 1, 'only the re-ask with the real fields'); assert.match(w.prompts[0], /exactly these numeric fields: t, temp, setpoint/);
    const w3 = writer({ reaskView: { a: 'temp', b: 'setpoint', label: 'temp', refLabel: 'setpoint' } });
    const r3 = await writeDecisionRules({ instruction: 'x', sources: k.sources, plan: k.plan, decision, views: [bad], complete: w3.complete, fixtureDir: path.join(k.work, 'c') });
    assert.equal(r3.view.name, 'temp_vs_setpoint'); assert.equal(r3.status, 'pass', r3.problems.join('; '));
    const trace = [];
    const r2 = await writeDecisionRules({ instruction: 'x', sources: k.sources, plan: k.plan, decision, views: [bad, view], complete: w.complete, fixtureDir: path.join(k.work, 'b'), trace });
    assert.equal(r2.view.name, 'temp_vs_setpoint'); assert.match(trace.find((t) => t.step === 'decisions-view').note, /dropped/);
  } finally { k.cleanup(); }
});
