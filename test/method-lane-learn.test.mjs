// Bar lane: "learn a method from this attachment" (2026-11-16). Scripted local model, synthetic kit, isolated
// state — no Ollama, no network, no real files. Proves: offer before anything runs; "no" writes nothing; "yes"
// writes a DRAFT that no method store loads; a bad attachment is rejected with its problems.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.KINGMAKER_OPEN_JEV = 'off';
const { createMethodLane, abilityStores } = await import('../lib/method-request.mjs');

function kit({ withAct = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lane-kit-'));
  writeFileSync(join(dir, 'README.md'), `# Kit\n\`\`\`sh\npython3 sim.py init --run runs/x\npython3 sim.py observe --run runs/x\n${withAct ? 'python3 sim.py step --run runs/x --helm HELM --sheet SHEET --reason "YOUR DECISION"\n' : ''}python3 sim.py verify --run runs/x\n\`\`\`\nA sailing race.\n`);
  writeFileSync(join(dir, 'sim.py'), "def delta(a,b):\n  return (a-b+540)%360-180\ndef polar(twa):\n    points = [(0,0.1),(30,0.2),(50,5.0),(90,7.0)]\n    return 1\ndef step(s, wf):\n    twa=abs(delta(s['heading'],wf))\n    desired_speed=polar(twa)\ndef obs(s, wf):\n    return {\n      'heading': s['heading'],\n      'wind_from':wf,\n      'goal_bearing': round(math.degrees(math.atan2(1,2))%360,3),\n      'finished': False,\n      'terminal': False,\n    }\ndef result(s):\n    return {'finished': s['finished']}\n");
  return dir;
}
// Scripted local model: answers by prompt kind; picks options by their words (AWAY for zones, TOWARD for the goal).
function scripted({ roles = { 0: 'setup', 1: 'observe', 2: 'act', 3: 'verify' } } = {}) {
  const calls = [];
  const complete = async (system, user) => {
    calls.push(system.slice(0, 40));
    const pick = (re) => { const m = /Options: (.*?)\. Reply/s.exec(user); const opts = m ? m[1].split(/; (?=\d+: )/).map((o) => o.replace(/^\d+: /, '')) : []; const i = opts.findIndex((o) => re.test(o)); return JSON.stringify({ option: Math.max(0, i), why: 'from the facts' }); };
    if (/label commands/.test(system)) return JSON.stringify({ roles });
    if (/extract task facts/.test(system)) return JSON.stringify({ decisions: [{ name: 'HELM', min: -1, max: 1 }, { name: 'SHEET', min: 0, max: 1 }], observedFields: ['heading'], objective: { field: 'terminal', equals: true }, terminalField: 'terminal', limits: 'none', rules: [{ rule: 'Reach the goal.', source: 'README.md' }] });
    if (/instructions for a decision-maker/.test(system)) return JSON.stringify({ guidance: 'Read the views, then decide.', views: [] });
    if (/You read code/.test(system)) return JSON.stringify({ field: 'result.finished', equals: true, why: 'finished means done' });
    if (/physics code/.test(system)) return JSON.stringify({ conditions: [] });
    if (/describe a vehicle state/.test(system)) return JSON.stringify({ views: [] });
    if (/name an activity/.test(system)) return JSON.stringify({ word: 'sailing' });
    if (/answer one question/.test(system)) return /direction to where the vehicle must go/.test(user) ? pick(/goal_bearing/) : /INSIDE/.test(user) ? pick(/AWAY/) : pick(/TOWARD/);
    return '{}';
  };
  return { complete, calls };
}
function lane(state, complete) {
  const shown = [], said = [], panels = [];
  const l = createMethodLane({ state, show: (x) => shown.push(x), say: async (x) => said.push(x), panel: (p) => panels.push(p), brainOptions: { complete, remote: false } });
  return { l, shown, said, panels };
}

test('offer first; "no" writes nothing', async () => {
  const state = mkdtempSync(join(tmpdir(), 'lane-state-')); const dir = kit(); const { complete, calls } = scripted();
  const { l, shown } = lane(state, complete);
  const msg = `Kingmaker, run the race ${dir}/README.md ${dir}/sim.py`;
  assert.equal(await l.wants(msg), true);
  const r = await l.handle(msg);
  assert.equal(r.status, 'awaiting-learn-approval');
  assert.ok(shown.some((x) => /read as data/.test(x)) && shown.some((x) => /No research sites are approved/.test(x)));
  assert.equal(calls.length, 0, 'no model call before approval');
  assert.equal(await l.handle('no'), null);
  assert.equal(existsSync(join(state, 'abilities', 'drafts')), false);
});

test('"yes" writes a DRAFT with provenance that no method store loads', async () => {
  const state = mkdtempSync(join(tmpdir(), 'lane-state-')); const dir = kit(); const { complete } = scripted();
  const { l, panels, said } = lane(state, complete);
  await l.handle(`Kingmaker, run the race ${dir}/README.md ${dir}/sim.py`);
  const r = await l.handle('yes');
  assert.equal(r.status, 'draft', JSON.stringify(r.problems));
  assert.ok(r.draftPath.startsWith(join(state, 'abilities', 'drafts')));
  const md = readFileSync(r.draftPath, 'utf8');
  assert.match(md, /DRAFT — not loaded/); assert.match(md, /sha256/); assert.match(md, /expected score = UNKNOWN/);
  for (const store of Object.values(abilityStores(state))) assert.ok(!existsSync(store) || !readdirSync(store).length, `${store} must stay empty`);
  assert.equal(panels.at(-1).state, 'unverified');
  assert.match(said.at(-1), /not used yet/);
});

test('an attachment without an act command is rejected with problems; nothing usable saved', async () => {
  const state = mkdtempSync(join(tmpdir(), 'lane-state-')); const dir = kit({ withAct: false }); const { complete } = scripted({ roles: { 0: 'setup', 1: 'observe', 2: 'verify' } });
  const { l, shown, panels } = lane(state, complete);
  await l.handle(`Kingmaker, run the race ${dir}/README.md ${dir}/sim.py`);
  const r = await l.handle('yes');
  assert.equal(r.status, 'rejected'); assert.equal(r.draftPath, null);
  assert.ok(shown.some((x) => /problem: no "act" command/.test(x)));
  assert.equal(panels.at(-1).state, 'failed');
});

test('a message without attachments is not taken by the learn path', async () => {
  const state = mkdtempSync(join(tmpdir(), 'lane-state-')); const { complete } = scripted();
  const { l } = lane(state, complete);
  assert.equal(await l.wants('Kingmaker, run the race please'), false);
  assert.equal(await l.handle('Kingmaker, run the race please'), null);
});
