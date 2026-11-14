// test/method-iteration.test.mjs — recursive iteration (2026-11-13): the loop's
// final step. Before lib/method-iteration.mjs, nothing in the tree could WRITE a
// method file: methods arrived as shipped catalog or repo-streamed text, and a
// technique a run proved lived only in that run's trace. The seam proven here:
//   (1) iterateMethod files the next version of a conducted method into a LOCAL
//       method store (index.json + <id>.method.md, the exact layout the conductor
//       reads) — proven inputs as the new defaults (declared keys only), steps
//       verbatim, version bumped, an iteration-log receipt appended, quality
//       inherited untouched;
//   (2) the filing is RECURSIVE — iterating the store's own file produces the
//       version after that, log extended, still valid;
//   (3) the store is a real library — the shipped conductor lists the iterated
//       method from the store's index and conducts it;
//   (4) fail-closed — an unknown method and a missing storeDir throw named
//       errors and write nothing.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createMethodConductor, parseMethodFile } from '../lib/method-conductor.mjs';
import { normalizeMethodsIndex } from '../lib/brain-library.mjs';
import { bumpMethodVersion, iterateMethod, methodStoreIndexUrl } from '../lib/method-iteration.mjs';

const SAMPLE = `# Method — Sample Widget Check

A fixture method: the prose stands, the block below is the technique.

\`\`\`kingmaker-method
{
  "id": "sample-widget-check",
  "version": "1.0",
  "title": "Sample Widget Check",
  "domain": "sample",
  "inputs": { "width": 100, "label": "draft" },
  "steps": [
    { "n": 1, "id": "note-start", "type": "note", "text": "checking {{inputs.label}} at width {{inputs.width}}" },
    { "n": 2, "id": "declare-widget", "type": "declare", "action": "widget --width {{inputs.width}}", "reason": "fixture: the widget binary does not exist" }
  ]
}
\`\`\`

## Steps (prose mirror)

1. **note-start** — trace note with the effective inputs.
2. **declare-widget** — DECLARED: the widget command, never run by this fixture.
`;

const CONDUCTION = {
  status: 'completed',
  trace: [
    { n: 1, id: 'note-start', type: 'note', status: 'executed', detail: 'checking draft at width 320' },
    { n: 2, id: 'declare-widget', type: 'declare', status: 'declared', detail: 'declared, not executed: widget --width 320' },
  ],
  declared: [{ step: 'declare-widget', action: 'widget --width 320', reason: 'fixture' }],
};

async function fixtureCatalog() {
  const dir = await mkdtemp(join(tmpdir(), 'km-iteration-src-'));
  await mkdir(join(dir, 'methods'), { recursive: true });
  await writeFile(join(dir, 'methods', 'sample-widget-check.method.md'), SAMPLE);
  await writeFile(join(dir, 'methods', 'index.json'), `${JSON.stringify({
    schema: 'kingmaker.methods/1',
    methods: [{
      id: 'sample-widget-check', title: 'Sample Widget Check', domain: 'sample',
      file: 'sample-widget-check.method.md',
      quality: { tier: 'draft', score: 40, basis: 'fixture' },
    }],
  }, null, 2)}\n`);
  return new URL(`file://${join(dir, 'methods', 'index.json')}`);
}

test('bumpMethodVersion bumps the last numeric component', () => {
  assert.equal(bumpMethodVersion('1.0'), '1.1');
  assert.equal(bumpMethodVersion('1.9'), '1.10');
  assert.equal(bumpMethodVersion('2'), '3');
  assert.equal(bumpMethodVersion('1.0-rc'), '1.0-rc.1');
});

test('iterateMethod files the next version: proven inputs in, steps verbatim, receipt appended', async () => {
  const sourceIndexUrl = await fixtureCatalog();
  const storeDir = await mkdtemp(join(tmpdir(), 'km-iteration-store-'));
  const r = await iterateMethod({
    methodId: 'sample-widget-check',
    conduction: CONDUCTION,
    sourceIndexUrl,
    storeDir,
    inputUpdates: { width: 320, bogus: 'never smuggled' },
    now: new Date('2026-11-13T22:30:00.000Z'),
  });
  assert.equal(r.fromVersion, '1.0');
  assert.equal(r.toVersion, '1.1');
  assert.deepEqual(r.appliedInputs, ['width']);
  assert.ok(existsSync(r.path), 'the iterated method file exists in the store');
  const text = await readFile(r.path, 'utf8');
  const spec = parseMethodFile(text);
  assert.equal(spec.version, '1.1');
  assert.deepEqual(spec.inputs, { width: 320, label: 'draft' });
  assert.deepEqual(spec.steps, parseMethodFile(SAMPLE).steps, 'steps are the technique — carried verbatim');
  assert.ok(text.includes('## Iteration log'), 'the iteration log section was appended');
  assert.ok(text.includes('v1.0 conducted → completed'), 'the receipt names the conduction it follows');
  assert.ok(text.includes('width'), 'the receipt names the carried inputs');
  const index = normalizeMethodsIndex(JSON.parse(await readFile(r.indexPath, 'utf8')));
  assert.equal(index.length, 1);
  assert.equal(index[0].id, 'sample-widget-check');
  assert.equal(index[0].quality.tier, 'draft', 'quality is inherited, not re-judged');
});

test('iteration is recursive: the store file iterates again, and the conductor conducts from the store', async () => {
  const sourceIndexUrl = await fixtureCatalog();
  const storeDir = await mkdtemp(join(tmpdir(), 'km-iteration-store2-'));
  await iterateMethod({ methodId: 'sample-widget-check', conduction: CONDUCTION, sourceIndexUrl, storeDir, inputUpdates: { width: 320 } });
  const r2 = await iterateMethod({
    methodId: 'sample-widget-check',
    conduction: CONDUCTION,
    sourceIndexUrl: methodStoreIndexUrl(storeDir),
    storeDir,
    inputUpdates: { label: 'proven' },
  });
  assert.equal(r2.fromVersion, '1.1');
  assert.equal(r2.toVersion, '1.2');
  const text = await readFile(r2.path, 'utf8');
  const spec = parseMethodFile(text);
  assert.deepEqual(spec.inputs, { width: 320, label: 'proven' }, 'both iterations of proven inputs stand');
  assert.equal((text.match(/conducted → completed/g) ?? []).length, 2, 'the log carries both receipts under one section');

  const conductor = createMethodConductor({ indexUrl: methodStoreIndexUrl(storeDir) });
  const listed = await conductor.listMethods();
  assert.deepEqual(listed.map((m) => m.id), ['sample-widget-check']);
  const workDir = await mkdtemp(join(tmpdir(), 'km-iteration-work-'));
  const result = await conductor.conduct('sample-widget-check', { workDir });
  assert.equal(result.status, 'completed');
  assert.equal(result.method.version, '1.2', 'the conduction ran the iterated file, not the source');
  assert.equal(result.trace.find((s) => s.id === 'note-start').detail, 'checking proven at width 320');
});

test('iterateMethod fails closed: unknown method, missing storeDir — nothing written', async () => {
  const sourceIndexUrl = await fixtureCatalog();
  const storeDir = await mkdtemp(join(tmpdir(), 'km-iteration-store3-'));
  await assert.rejects(
    () => iterateMethod({ methodId: 'no-such-method', conduction: CONDUCTION, sourceIndexUrl, storeDir }),
    /no method "no-such-method"/,
  );
  await assert.rejects(
    () => iterateMethod({ methodId: 'sample-widget-check', conduction: CONDUCTION, sourceIndexUrl }),
    /needs a storeDir/,
  );
  assert.equal(existsSync(join(storeDir, 'index.json')), false, 'a refused iteration writes no index');
  assert.equal(existsSync(join(storeDir, 'sample-widget-check.method.md')), false, 'a refused iteration writes no file');
});
