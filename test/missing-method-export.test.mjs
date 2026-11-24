import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { listArtifacts } from '../lib/artifacts.mjs';
import { createDeskOfDevice } from '../lib/device-desk.mjs';
import { createExecutionLoop } from '../lib/execution-loop.mjs';
import { parseMethodFile } from '../lib/method-conductor.mjs';
import { offerTextExport, runApprovedTextExport, textExportIntent } from '../lib/missing-method-export.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'kingmaker-export-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('ordinary typed and spoken export requests use a bounded filename and literal content', () => {
  assert.deepEqual(textExportIntent('Save "a {{literal}} note" as my-note.txt'), { filename: 'my-note.txt', content: 'a {{literal}} note' });
  assert.deepEqual(textExportIntent('Save the text Hello world as note dot txt.'), { filename: 'note.txt', content: 'Hello world' });
  assert.deepEqual(textExportIntent('Make a Markdown file named note.md containing “# a note”'), { filename: 'note.md', content: '# a note' });
  assert.match(textExportIntent('Save "hello" as ../hello.txt').error, /simple/);
  assert.match(textExportIntent('Save "hello" as hello.sh').error, /simple/);
  assert.match(textExportIntent(`Save "${'é'.repeat(4100)}" as hello.txt`).error, /8 KiB/);
  assert.equal(textExportIntent('Explain what a text export does'), null);
});

test('both desktop typed routes and the shared voice route reach the bounded export before a brain turn', async () => {
  const cli = await readFile(new URL('../lib/cli.mjs', import.meta.url), 'utf8');
  const command = cli.slice(cli.indexOf("else if (/^typed-command"), cli.indexOf('// THE KINGMAKER BAR'));
  assert.match(command, /await offerLocalExport\(text\)/);
  assert.ok(command.indexOf('await offerLocalExport(text)') < command.indexOf('brain.runTurn(text)'));
  assert.match(cli, /const routeTurn = async[\s\S]+?await offerLocalExport\(text\)/);
  assert.match(cli, /if \(!phoneConv && !programs\.length && !img && !skill && await offerLocalExport\(text\)\)/);
});

test('app approval uses the existing desk, and refusal or decline writes nothing', async (t) => {
  const runtimeHome = await fixture(t);
  const said = [];
  const delivered = [];
  const say = async (line) => said.push(line);
  const desk = createDeskOfDevice({ paths: { runtimeHome, state: runtimeHome }, say, voiceAuthority: 'verified' });
  const opts = { desk, say, runtimeHome, onArtifact: (result) => delivered.push(result) };

  assert.equal(await offerTextExport('Save "scoped" as ../escape.txt', opts), true);
  assert.equal(desk.pending(), false);
  assert.deepEqual(await readdir(runtimeHome), []);

  assert.equal(await offerTextExport('Save "synthetic" as notes.txt', opts), true);
  assert.equal(desk.pending(), true);
  assert.match(said.at(-1), /Create notes\.txt.*Say yes or no/);
  await desk.answer('yes', { spoken: true, attested: false });
  assert.equal(desk.pending(), true);
  assert.deepEqual(await readdir(runtimeHome), []);
  await desk.answer('no', { typed: true });
  assert.equal(desk.pending(), false);
  assert.deepEqual(await readdir(runtimeHome), []);
  assert.deepEqual(delivered, []);
});

test('an approved ordinary turn creates one verified artifact without replacing an original', async (t) => {
  const runtimeHome = await fixture(t);
  const root = join(runtimeHome, 'data', 'artifacts');
  await mkdir(root, { recursive: true });
  const original = join(root, 'notes.txt');
  await writeFile(original, 'synthetic original');
  const originalHash = hash(await readFile(original));
  const said = [];
  const delivered = [];
  const say = async (line) => said.push(line);
  const desk = createDeskOfDevice({ paths: { runtimeHome, state: runtimeHome }, say, voiceAuthority: 'verified' });
  const request = 'Save "Synthetic café {{inputs.filename}}" as notes.txt';
  assert.equal(await offerTextExport(request, { desk, say, runtimeHome, onArtifact: (result) => delivered.push(result) }), true);
  await desk.answer('yes', { spoken: true, attested: true });

  const [result] = delivered;
  assert.equal(result?.status, 'completed');
  assert.match(said.at(-1), /Verified notes\.txt.*Open it in Artifacts/);
  const bytes = await readFile(result.artifact.path);
  assert.equal(bytes.toString(), 'Synthetic café {{inputs.filename}}');
  assert.equal(result.artifact.sha256, hash(bytes));
  assert.equal(await lstat(result.artifact.path).then((stat) => stat.nlink), 1);
  assert.equal(hash(await readFile(original)), originalHash);
  assert.equal((await readdir(root)).length, 2);
  assert.ok(listArtifacts({ home: runtimeHome, runtimeHome }).some((entry) => entry.path === result.artifact.path));

  assert.equal(parseMethodFile(result.distillate.text).id, result.method);
  assert.equal(result.distillate.sha256, hash(result.distillate.text));
  assert.equal(result.distillate.checks, null, 'delivery does not wait on learning');
  assert.equal(result.metrics.modelCalls, 0);
  const learned = await result.learn();
  assert.equal(learned.distillate.checks.collision.haltedAt, 'require-new-output');
  assert.equal(learned.distillate.checks.positive.sha256, learned.distillate.checks.collision.sha256);
  assert.doesNotMatch(result.distillate.text, /Synthetic café/);
});

test('an existing artifact directory symlink cannot redirect approval to another folder', async (t) => {
  const runtimeHome = await fixture(t);
  const elsewhere = await fixture(t);
  await mkdir(join(runtimeHome, 'data'));
  await symlink(elsewhere, join(runtimeHome, 'data', 'artifacts'), 'dir');

  const result = await runApprovedTextExport({ filename: 'sample.txt', content: 'synthetic' }, { runtimeHome });
  assert.deepEqual(result, { status: 'failed', reason: 'The Artifacts folder is unavailable.' });
  assert.deepEqual(await readdir(elsewhere), []);
});

test('missing reviewed coverage enters authoring before lookup, weights or escalation', async (t) => {
  const workDir = await fixture(t);
  const calls = [];
  const loop = createExecutionLoop({
    conductor: {
      listMethods: async () => [{ id: 'literal-text-export', title: 'Literal text export', quality: { tier: 'draft', score: 99 } }],
      conduct: () => assert.fail('draft catalog method was executed'),
    },
    reader: { readForSession: () => assert.fail('context was read') },
    fetchImpl: () => assert.fail('source was fetched'),
    beforeWeights: () => assert.fail('weights were picked'),
    authorMissingMethod: async (request) => {
      calls.push(request);
      return { status: 'declined', reason: 'Owner declined the export.' };
    },
  });
  const result = await loop.run('literal text export https://example.com', { workDir });
  assert.equal(calls.length, 1);
  assert.equal(result.refused, true);
  assert.equal(result.reason, 'Owner declined the export.');
  assert.equal(result.picks.weights, null);
  assert.deepEqual(await readdir(workDir), []);
});

test('a covering reviewed method keeps the execution path ahead of draft authoring', async (t) => {
  const workDir = await fixture(t);
  const reviewed = { id: 'literal-text-export', title: 'Literal text export', quality: { tier: 'vetted', score: 90 }, stepCount: 1 };
  const reviewedConductor = {
    listMethods: async () => [reviewed],
    conduct: async (id, { workDir, inputs }) => {
      assert.equal(id, reviewed.id);
      await writeFile(join(workDir, inputs.filename), inputs.content, { flag: 'wx' });
      return { method: { id, version: '1', sha256: hash(id) }, status: 'completed', trace: [], declared: [] };
    },
  };

  const result = await runApprovedTextExport({ filename: 'reviewed.txt', content: 'Reviewed fixture' }, { runtimeHome: workDir, reviewedConductor });
  assert.equal(result.status, 'completed');
  assert.equal(result.method, reviewed.id);
  assert.equal(result.distillate, null);
  assert.equal(await readFile(result.artifact.path, 'utf8'), 'Reviewed fixture');
});

test('a reviewed method reporting completion with incorrect bytes cannot publish an artifact', async (t) => {
  const runtimeHome = await fixture(t);
  const id = 'literal-text-export';
  const reviewedConductor = {
    listMethods: async () => [{ id, title: 'Literal text export', quality: { tier: 'vetted', score: 90 }, stepCount: 1 }],
    conduct: async (_, { workDir, inputs }) => {
      await writeFile(join(workDir, inputs.filename), 'wrong', { flag: 'wx' });
      return { method: { id, version: '1', sha256: hash(id) }, status: 'completed', trace: [], declared: [] };
    },
  };

  const result = await runApprovedTextExport({ filename: 'reviewed.txt', content: 'right' }, { runtimeHome, reviewedConductor });
  assert.deepEqual(result, { status: 'failed', reason: 'The exported bytes differ from the requested text.' });
  assert.deepEqual(await readdir(runtimeHome), []);
});
