import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { buildLibrary, INERT_REFERENCES, referenceSelectableAs } from '../lib/brain-library.mjs';
import { ingest } from '../lib/ingestion-guard.mjs';
import { payloadFiles } from '../lib/payload.mjs';

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
  assert.equal(registration.registration.state, 'registered-local-schema');
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

test('brain library reads the reference back exactly and never selects or packages it as code', () => {
  const legacy = buildLibrary({ references: [], now: '2026-11-01T00:00:00.000Z' });
  const library = buildLibrary({ now: '2026-11-01T00:00:00.000Z' });
  const reference = library.references.find((item) => item.id === 'deepseek-dsh-superagent-prototype-6337fc8');

  assert.ok(reference);
  assert.equal(reference.type, 'knowledge-reference');
  assert.equal(reference.trust, 'untrusted-reference');
  assert.equal(reference.executionDisabled, true);
  assert.deepEqual(reference.selectableAs, []);
  assert.deepEqual(reference.capabilities, []);
  assert.equal(sha256(reference.content), reference.contentSha256);
  assert.equal(reference.contentSha256, INERT_REFERENCES[0].contentSha256);
  for (const lane of ['model', 'skill', 'tool', 'prompt', 'worker', 'executable']) {
    assert.equal(referenceSelectableAs(reference, lane), false);
  }
  assert.ok(!library.models.some((model) => model.tag === reference.id));
  assert.ok(!library.bigOptions.some((model) => model.tag === reference.id));

  // Adding the optional field is backward-compatible: every pre-existing lane is byte-equivalent.
  for (const field of ['schema', 'repo', 'updatedAt', 'source', 'devices', 'classes', 'models', 'bigOptions', 'bench']) {
    assert.deepEqual(library[field], legacy[field], field);
  }

  // The release manifest is allowlisted and cannot include quarantine, the source archive, or audit-only files.
  const packaged = payloadFiles(path.resolve('.'));
  assert.ok(!packaged.some((name) => name.startsWith('quarantine/')));
  assert.ok(!packaged.some((name) => name.includes('dsh-superagent-prototype')));
});
