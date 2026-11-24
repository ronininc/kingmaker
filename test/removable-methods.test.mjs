import test from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMethodConductor } from '../lib/method-conductor.mjs';
import { resolveRemovableMethods } from '../lib/removable-methods.mjs';

const UUID = 'FIXTURE-CARD-UUID';
const MARKER = 'KM-SD-METHOD-7F31';
const METHOD = `# Produce report\n\n\`\`\`kingmaker-method\n${JSON.stringify({ id: 'produce-report-marker', version: '1.0', title: 'Aggregate produce CSV marker', domain: 'produce aggregate sorted markdown', inputs: {}, steps: [{ n: 1, id: 'marker', type: 'render', path: 'report.md', template: `# Sorted Produce Report\\n\\n${MARKER}\\n` }, { n: 2, id: 'verify', type: 'verify', assertions: [{ path: 'report.md', contains: MARKER }] }] }, null, 2)}\n\`\`\`\n`;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'km-method-card-')), dir = join(root, 'methods');
  mkdirSync(dir); writeFileSync(join(dir, 'produce.method.md'), METHOD);
  writeFileSync(join(dir, 'index.json'), JSON.stringify({ schema: 'kingmaker.methods/1', methods: [{ id: 'produce-report-marker', title: 'Aggregate produce CSV marker', domain: 'produce aggregate sorted markdown', file: 'produce.method.md', quality: { tier: 'vetted', score: 90, basis: 'fixture' } }] }));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { KINGMAKER_METHOD_CARD: root, KINGMAKER_METHOD_CARD_UUID: UUID, KINGMAKER_METHOD_DIR: 'methods' };
  const opts = { env, mountDevice: () => lstatSync(root).dev, cardIdentity: () => UUID };
  return { root, dir, opts };
}

test('verified removable method runs from its file URL and reports its exact hash', async (t) => {
  const f = fixture(t), source = resolveRemovableMethods(f.opts), workDir = join(f.root, 'work'); mkdirSync(workDir);
  const conductor = createMethodConductor({ indexUrl: source.indexUrl, toolProvider: null });
  const listed = await conductor.listMethods();
  assert.equal(listed[0].source, new URL('produce.method.md', source.indexUrl).href);
  assert.equal(listed[0].sha256, createHash('sha256').update(METHOD).digest('hex'));
  const result = await conductor.conduct('produce-report-marker', { workDir });
  assert.equal(result.status, 'completed');
  assert.equal(result.method.sha256, listed[0].sha256);
  assert.match(readFileSync(join(workDir, 'report.md'), 'utf8'), new RegExp(MARKER));
});

test('missing and wrong removable cards fail closed without bundled fallback, then recover', (t) => {
  const f = fixture(t);
  assert.throws(() => resolveRemovableMethods({ ...f.opts, mountDevice: () => null }), /unavailable.*no internal method copy/i);
  assert.throws(() => resolveRemovableMethods({ ...f.opts, cardIdentity: () => 'OTHER' }), /Wrong Kingmaker method card.*no internal method copy/i);
  assert.equal(resolveRemovableMethods(f.opts).uuid, UUID);
});

test('Finder-launched app reads the persistent removable-method configuration', (t) => {
  const f = fixture(t), configFile = join(f.root, 'removable-methods.json');
  writeFileSync(configFile, JSON.stringify({ card: f.root, uuid: UUID, directory: 'methods' }));
  const source = resolveRemovableMethods({ env: {}, configFile, mountDevice: f.opts.mountDevice, cardIdentity: f.opts.cardIdentity });
  assert.equal(source.uuid, UUID);
  assert.equal(source.directory, f.dir);
});
