import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachmentsInText, instructionWithoutPaths, readSources, candidateCommands, stateKeys, angularKeys, relativeAngleKeys, tableFacts, zoneFromTable, validateSpec } from '../lib/method-from-source.mjs';

const dir = mkdtempSync(join(tmpdir(), 'mfs-'));
writeFileSync(join(dir, 'README.md'), '# Kit\n```sh\npython3 sim.py init --run runs/x\npython3 sim.py observe --run runs/x\npython3 sim.py step --run runs/x --helm HELM --sheet SHEET --reason "YOUR DECISION"\npython3 sim.py verify --run runs/x\n```\n');
writeFileSync(join(dir, 'sim.py'), "def delta(a,b):\n  return (a-b+540)%360-180\ndef polar(twa):\n    points = [(0,0.1),(30,0.2),(50,5.0),(90,7.0)]\n    return 1\ndef step(s, wf):\n    twa=abs(delta(s['heading'],wf))\n    desired_speed=polar(twa)\ndef obs(s, wf):\n    return {'heading': s['heading'], 'wind_from':wf, 'goal_bearing': round(math.degrees(math.atan2(1,2))%360,3), 'twa_rel': abs(delta(1,2)), 'x': 1, 'finished': False}\n");
writeFileSync(join(dir, 'photo.png'), 'x');

test('attachment paths are found in the bar text; the vocative is dropped', () => {
  const msg = `Kingmaker, run the kit ${dir}/README.md and "${dir}/photo.png"`;
  const p = attachmentsInText(msg);
  assert.deepEqual(p, [`${dir}/README.md`, `${dir}/photo.png`]);
  assert.equal(instructionWithoutPaths(msg, p), 'run the kit and');
});
test('media is listed as NOT interpreted; text is read and hashed', () => {
  const s = readSources([dir], { workDir: dir });
  assert.ok(s.notInterpreted.some((n) => n.rel === 'photo.png' && /not interpreted/.test(n.why)));
  assert.ok(s.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)));
});
test('commands come only from the documents; state keys, angles, tables are derived from code', () => {
  const s = readSources([dir], { workDir: dir });
  assert.equal(candidateCommands(s.files).length, 4);
  const keys = stateKeys(s.files, { script: 'sim.py' });
  const ang = angularKeys(s.files, keys, { script: 'sim.py' });
  assert.ok(ang.includes('heading') && ang.includes('wind_from') && ang.includes('goal_bearing') && !ang.includes('x'));
  assert.deepEqual(relativeAngleKeys(s.files, ['twa_rel', 'heading'], { script: 'sim.py' }), ['twa_rel']);
  const [t] = tableFacts(s.files);
  assert.equal(t.fn, 'polar'); assert.equal(t.halfAt, 50); assert.match(t.fact, /sets desired_speed/);
  const z = zoneFromTable(t, s.files, ['heading', 'wind_from', 'goal_bearing'], { script: 'sim.py' });
  assert.deepEqual([z.op, z.a, z.b, z.limit], ['zone', 'wind_from', 'heading', 50]);
});
test('validation rejects a terminal-flag objective, uncited rules and formula guidance', () => {
  const s = readSources([dir], { workDir: dir });
  const cmds = candidateCommands(s.files);
  const x = { commands: cmds, roles: { 0: 'setup', 1: 'observe', 2: 'act', 3: 'verify' }, facts: { decisions: [{ name: 'HELM', min: -1, max: 1 }], objective: { field: 'terminal' }, terminalField: 'terminal', rules: [{ rule: 'made up', source: 'nowhere.txt' }] }, guidance: 'helm = 0.5 * offset', views: [], angles: ['heading'] };
  const v = validateSpec(x, s);
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => /terminal flag/.test(p)));
  assert.ok(v.problems.some((p) => /cite no attached source/.test(p)));
  assert.ok(v.problems.some((p) => /control law/.test(p)));
});
