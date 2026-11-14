// test/method-conductor-tolerance.test.mjs — S3 closure, route (a) (owner order 2026-11-14):
// the conductor TOLERATES readable records. A methods index may mix conductable method files
// with readable intelligence (the CRM seed records in kingmaker-tools carry no executable
// blocks, by design): library load must index the readable records, list them as skipped with
// a named reason, and conduct the real methods — never hard-fail the census or the run. A file
// that DOES open a kingmaker-method fence is parsed exactly as strictly as before: an invalid
// or malformed block still fails the whole load. Hermetic: tmp-dir libraries, file:// reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMethodConductor, parseMethodFile, READABLE_RECORD_REASON } from '../lib/method-conductor.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');

const ALPHA = `# Alpha method

Prose mirror of the executable block.

\`\`\`kingmaker-method
{
  "id": "alpha",
  "version": "1.0",
  "title": "Alpha",
  "domain": "test",
  "inputs": {},
  "steps": [
    { "id": "say", "type": "note", "text": "alpha running" },
    { "id": "write", "type": "write-json", "path": "alpha.json", "value": { "ok": true } },
    { "id": "check", "type": "verify", "assertions": [ { "file": "alpha.json", "field": "ok", "equals": true } ] }
  ]
}
\`\`\`
`;

const BETA = `# Beta method

\`\`\`kingmaker-method
{
  "id": "beta",
  "version": "0.1",
  "title": "Beta",
  "domain": "test",
  "inputs": {},
  "steps": [ { "id": "only", "type": "note", "text": "beta" } ]
}
\`\`\`
`;

const CRM_ONE = `# CRM record one

Readable intelligence harvested from the CRM. It describes a procedure in prose for a
human or a reasoning pass to read. It was never converted to an executable method.
`;

const CRM_TWO = `# CRM record two

This record even discusses the \`\`\`kingmaker-method block format in prose — the phrase
appears mid-sentence, with no fence — and it is still a readable record, not a method.
`;

const BAD_JSON = `# Broken method

\`\`\`kingmaker-method
{ "id": "broken", "steps": [ }
\`\`\`
`;

const MALFORMED = `# Malformed method

\`\`\`kingmaker-method
{ "id": "malformed", "steps": [ { "id": "no-type-here" } ] }
\`\`\`
`;

async function makeLibrary(entries) {
  const dir = await mkdtemp(join(tmpdir(), 'km-tolerance-'));
  const index = { schema: 'kingmaker.methods/1', methods: [] };
  for (const [id, file, text, tier, score] of entries) {
    await writeFile(join(dir, file), text);
    index.methods.push({ id, title: id, domain: 'test', file, quality: { tier, score } });
  }
  await writeFile(join(dir, 'index.json'), JSON.stringify(index, null, 2));
  return pathToFileURL(join(dir, 'index.json'));
}

const MIXED = [
  ['alpha', 'alpha.method.md', ALPHA, 'vetted', 80],
  ['crm-one', 'crm-one.md', CRM_ONE, 'draft', 0],
  ['beta', 'beta.method.md', BETA, 'vetted', 70],
  ['crm-two', 'crm-two.md', CRM_TWO, 'draft', 0],
];

test('mixed library loads: readable records are indexed and listed as skipped, never as methods', async () => {
  const conductor = createMethodConductor({ indexUrl: await makeLibrary(MIXED), toolProvider: null });
  const methods = await conductor.listMethods();
  assert.deepEqual(methods.map((m) => m.id), ['alpha', 'beta']);
  const skipped = await conductor.listSkipped();
  assert.deepEqual(skipped.map((s) => s.id), ['crm-one', 'crm-two']);
  for (const s of skipped) {
    assert.equal(s.reason, READABLE_RECORD_REASON);
    assert.equal(s.file, `${s.id}.md`);
  }
  assert.equal(skipped[0].sha256, sha(CRM_ONE));
  assert.equal(skipped[1].sha256, sha(CRM_TWO));
});

test('conduction over the mixed library completes and its report enumerates the skips with reasons', async () => {
  const conductor = createMethodConductor({ indexUrl: await makeLibrary(MIXED), toolProvider: null });
  const workDir = await mkdtemp(join(tmpdir(), 'km-tolerance-work-'));
  const result = await conductor.conduct('alpha', { workDir });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.skipped.map((s) => s.id), ['crm-one', 'crm-two']);
  assert.ok(result.skipped.every((s) => s.reason === READABLE_RECORD_REASON));
});

test('conducting a readable record by name refuses it by name, with its skip receipt', async () => {
  const conductor = createMethodConductor({ indexUrl: await makeLibrary(MIXED), toolProvider: null });
  const workDir = await mkdtemp(join(tmpdir(), 'km-tolerance-work-'));
  await assert.rejects(() => conductor.conduct('crm-one', { workDir }), /"crm-one" is not conductable — it carries no ```kingmaker-method block/);
  await assert.rejects(() => conductor.conduct('no-such-thing', { workDir }), /no method in the library matches "no-such-thing"/);
});

test('a block that is not valid JSON still hard-fails the load — tolerance never weakens parsing', async () => {
  const conductor = createMethodConductor({
    indexUrl: await makeLibrary([['alpha', 'alpha.method.md', ALPHA, 'vetted', 80], ['broken', 'broken.method.md', BAD_JSON, 'vetted', 10]]),
    toolProvider: null,
  });
  await assert.rejects(() => conductor.listMethods(), /executable block is not valid JSON/);
});

test('a malformed block (step without a type) still hard-fails the load', async () => {
  const conductor = createMethodConductor({
    indexUrl: await makeLibrary([['alpha', 'alpha.method.md', ALPHA, 'vetted', 80], ['malformed', 'malformed.method.md', MALFORMED, 'vetted', 10]]),
    toolProvider: null,
  });
  await assert.rejects(() => conductor.listMethods(), /executable block is malformed/);
});

test('parseMethodFile itself is unchanged: a block-less file still throws the named error', () => {
  assert.throws(() => parseMethodFile(CRM_ONE), /carries no ```kingmaker-method block/);
  assert.equal(parseMethodFile(ALPHA).id, 'alpha');
});
