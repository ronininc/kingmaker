import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDeterministicArchive, streamDeterministicArchive } from '../lib/deterministic-archive.mjs';
import { splitStream, verifyParts } from '../lib/release-manifest.mjs';
import { main as releaseParts } from '../scripts/release-parts.mjs';
import { makeFixtureApp } from './fixtures/installer-fixtures.mjs';

function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), 'kingmaker-stream-proof-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('direct deterministic stream matches archive bytes and part pins without a full archive file', async (t) => {
  const root = scratch(t), source = join(root, 'source', 'Kingmaker.app');
  mkdirSync(join(source, 'Contents'), { recursive: true });
  writeFileSync(join(source, 'Contents', 'fixture'), 'small fixture only\n');
  const reference = join(root, 'reference.tar.gz');
  const expected = await createDeterministicArchive({ dir: source, outFile: reference });
  const output = join(root, 'parts');
  mkdirSync(output);
  const { stream, flavor } = streamDeterministicArchive({ dir: source });
  const result = await splitStream(stream, { partSize: 23, outDir: output, archive: 'fixture.tar.gz' });
  assert.equal(flavor, expected.flavor);
  assert.equal(result.sha256, expected.sha256);
  assert.equal(result.size, expected.size);
  assert.ok(result.parts.length > 1);
  assert.deepEqual(Buffer.concat(result.parts.map(p => readFileSync(p.file))), readFileSync(reference));
  assert.deepEqual(readdirSync(output).sort(), result.parts.map(p => p.name).sort());
  assert.deepEqual(readdirSync(root).sort(), ['parts', 'reference.tar.gz', 'source']);
});

test('a failed archive producer never finalizes incomplete part files', async (t) => {
  const root = scratch(t);
  const { stream } = streamDeterministicArchive({ dir: join(root, 'missing', 'Kingmaker.app') });
  await assert.rejects(splitStream(stream, { partSize: 10, outDir: root, archive: 'fixture.tar.gz' }));
  assert.ok(readdirSync(root).every(p => p.endsWith('.tmp')));
});

test('real release-parts CLI path preserves the external gate scratch parent', { skip: process.platform !== 'darwin', timeout: 20000 }, async (t) => {
  const root = scratch(t), source = makeFixtureApp(join(root, 'build'), { padBytes: 22000 });
  const out = join(root, 'published-parts-fixture'), stage = join(root, 'other-scratch');
  mkdirSync(stage);
  writeFileSync(join(stage, 'owner-sentinel'), 'leave me alone');
  const output = [];
  const common = ['--app', source, '--offline', '--harness-only', '--tree-commit', 'a'.repeat(40), '--tree-repo', 'ronininc/kingmaker'];
  assert.equal(await releaseParts({
    argv: [...common, '--out', out, '--gate-scratch', stage, '--part-size', '8000',
      '--deterministic', '--skip-codesign'], // Explicit local fixture use, never a shipping signature.
    env: { PATH: process.env.PATH },
    offlineDigests: async () => ({}), out: line => output.push(line),
  }), 0, output.join('\n'));
  const manifest = JSON.parse(readFileSync(join(out, 'kingmaker-manifest.json'), 'utf8'));
  assert.ok(manifest.parts.length > 1);
  assert.equal((await verifyParts(manifest, out)).ok, true);
  assert.match(output.join('\n'), /normalized|normalization, streamed/);
  assert.match(output.join('\n'), /staged gate/);
  assert.deepEqual(readdirSync(stage), ['owner-sentinel']);
  assert.equal(readFileSync(join(stage, 'owner-sentinel'), 'utf8'), 'leave me alone');
  assert.equal(existsSync(join(out,'.gate-stage')), false);
  assert.equal(readdirSync(out).filter(n => n.includes('.tar.gz') && !n.includes('.part')).length, 0);

  const rejected = [];
  const badOut = join(root, 'not-created');
  assert.equal(await releaseParts({
    argv: [...common, '--out', badOut, '--gate-scratch', join(stage, 'owner-sentinel'), '--skip-codesign'],
    env: { PATH: process.env.PATH }, offlineDigests: async () => ({}), out: line => rejected.push(line),
  }), 1);
  assert.match(rejected.join('\n'), /--gate-scratch must be an existing writable directory/);
  assert.equal(existsSync(badOut), false);
});
