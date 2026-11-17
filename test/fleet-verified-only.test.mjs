// Verified-only fleet loading (execution-loop fleetVerify): an unapproved fleet file is never offered, and a file
// changed after its approval is refused at load — never run. Opt-in until the owner decides where iterated fleet
// methods are filed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createExecutionLoop } from '../lib/execution-loop.mjs';

const text = (id) => `# ${id}\n\n\`\`\`kingmaker-method\n${JSON.stringify({ id, version: '1.0', title: id, domain: 'knots', inputs: { prompt: '' }, steps: [{ n: 1, id: 'rec', type: 'write-json', path: 'r.json', value: { method: id } }] }, null, 2)}\n\`\`\`\n`;
function store() {
  const root = mkdtempSync(join(tmpdir(), 'km-fleet-v-')); const dir = join(root, 'fleet'); mkdirSync(dir, { recursive: true });
  const put = (id) => { writeFileSync(join(dir, `${id}.method.md`), text(id)); return createHash('sha256').update(text(id)).digest('hex'); };
  const okSha = put('knot-approved'); put('knot-dropped-in'); const lib = join(root, 'library'); mkdirSync(lib, { recursive: true }); writeFileSync(join(lib, 'index.json'), JSON.stringify({ schema: 'kingmaker.methods/1', methods: [] }));
  writeFileSync(join(dir, 'index.json'), JSON.stringify({ schema: 'kingmaker.methods/1', methods: ['knot-approved', 'knot-dropped-in'].map((id) => ({ id, title: id, domain: 'knots', file: `${id}.method.md`, quality: { tier: 'draft', score: 50, basis: 'fixture' } })) }));
  return { root, dir, lib, okSha, done: () => rmSync(root, { recursive: true, force: true }) };
}
const ids = async (loop) => (await loop.conductor.listMethods()).map((m) => m.id);

test('only owner-verified fleet items are offered; a file changed after approval is refused at load', async () => {
  const s = store();
  try {
    const verified = createExecutionLoop({ methodStore: s.lib, fleetMethodStore: s.dir, fleetVerify: () => [{ id: 'knot-approved', file: 'knot-approved.method.md', sha256: s.okSha }], remote: false, methodHunt: false });
    const list = await ids(verified);
    assert.ok(list.includes('knot-approved')); assert.ok(!list.includes('knot-dropped-in'), 'a dropped-in fleet file is not offered');
    const legacy = createExecutionLoop({ methodStore: s.lib, fleetMethodStore: s.dir, remote: false, methodHunt: false });
    assert.ok((await ids(legacy)).includes('knot-dropped-in'), 'without fleetVerify the old behaviour is unchanged (opt-in)');
    writeFileSync(join(s.dir, 'knot-approved.method.md'), text('knot-approved').replace('"1.0"', '"1.1"'));
    const after = createExecutionLoop({ methodStore: s.lib, fleetMethodStore: s.dir, fleetVerify: () => [{ id: 'knot-approved', file: 'knot-approved.method.md', sha256: s.okSha }], remote: false, methodHunt: false });
    const l2 = await ids(after).catch((e) => e);
    assert.ok(l2 instanceof Error ? /FLEET_UNVERIFIED/.test(l2.message) : !l2.includes('knot-approved'), 'the edited file is never offered as the approved ability');
  } finally { s.done(); }
});
