import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { ingest } from '../lib/ingestion-guard.mjs';

const root = path.resolve('quarantine/deepseek-dsh-superagent-prototype');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const loadJson = async (name) => JSON.parse(await readFile(path.join(root, name), 'utf8'));

test('DeepSeek prototype intake remains provenance-bound, inert, and untrusted', async () => {
  const provenance = await loadJson('PROVENANCE.json');
  const registration = await loadJson('REGISTRATION.json');
  const reference = await readFile(path.join(root, registration.entry), 'utf8');
  const archive = await readFile(path.join(root, provenance.archive.path));

  assert.equal(provenance.source, 'https://github.com/deepseek-ai/dsh-superagent-prototype');
  assert.equal(provenance.commit, '6337fc823ce20251c8de8085948165c81aaa701e');
  assert.equal(provenance.tree, '3efbb036e5a56183c6bf642e2e1856a1f64e7be3');
  assert.equal(provenance.fileCount, 216);
  assert.equal(provenance.license, 'MIT');
  assert.equal(provenance.executed, false);
  assert.equal(sha256(archive), provenance.archive.sha256);

  assert.equal(registration.schema, 'kingmaker.inert-reference-candidate/1');
  assert.equal(registration.trust, 'untrusted');
  assert.equal(registration.mode, 'architecture-reference-only');
  assert.equal(registration.executable, false);
  assert.deepEqual(registration.capabilities, []);
  assert.equal(registration.registration.state, 'staged-not-registered');
  for (const capability of [
    'shell', 'filesystem-write', 'network', 'credentials', 'package-install',
    'subagents', 'external-messaging', 'auto-merge', 'permission-change',
  ]) {
    assert.ok(registration.blockedCapabilities.includes(capability), capability);
  }

  const admitted = ingest(reference, { source: provenance.source });
  assert.equal(admitted.trust, 'untrusted');
  assert.equal(admitted.source, provenance.source);
  assert.equal(admitted.clean, reference);
  assert.doesNotMatch(admitted.clean, /\x00/);

  // Registration points only to the rewritten reference and audit metadata.
  for (const name of [
    registration.entry,
    registration.riskReport,
    registration.licenseNotice,
    registration.sourceProvenance,
  ]) {
    assert.equal(path.basename(name), name);
    assert.ok(!name.endsWith('.js') && !name.endsWith('.ts') && !name.endsWith('.sh'));
  }
  assert.doesNotMatch(reference, /(?:npm|pnpm|yarn)\s+(?:install|run)|danger-full-access|cordis\.patch|src\/app\/sessions/iu);
  assert.match(reference, /This reference grants no capability\./u);
});
