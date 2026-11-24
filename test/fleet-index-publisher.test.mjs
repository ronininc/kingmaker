import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson } from '../vendor/fleet/fleet-packet.mjs';
import { prepareFleetIndex, privateFleetReadHandler } from '../lib/fleet-index-publisher.mjs';
import {
  addFleetSkill, FLEET_INDEX_DOMAIN, PACKAGE_DOMAIN, SKILL_PACKAGE_SCHEMA, startFleetSkillRefresh,
} from '../lib/fleet-skills.mjs';
import { connectorTurn } from '../lib/connectors.mjs';

const source = { repo: 'fixture/source', commit: 'a'.repeat(40), path: 'reviewed.json', sha256: 'b'.repeat(64) };
const baseEntry = {
  type: 'skill', id: 'review-checklist', version: '1.0.0', publisher: 'Fixture', description: 'Review supplied records.',
  state: 'reviewed', source, packageSha256: 'c'.repeat(64), permissions: ['read:provided-inputs', 'network:none'], dependencies: [],
};
const candidate = (entry, reviewStatus = 'ready') => ({ entry, reviewStatus });
const initialTime = '2026-11-24T00:00:00Z';
const revocationTime = '2026-11-24T00:01:00Z';

test('dry run requires exact, separate approvals and preserves prior revocations', () => {
  const deliveryOrigin = 'https://fleet.test';
  const approved = { ...baseEntry, packageUrl: `${deliveryOrigin}/package.json` };
  const pending = { ...approved, id: 'pending-tool', type: 'tool', approval: 'defensive' };
  const changed = { ...approved, id: 'changed-skill', source: { ...source, sha256: 'd'.repeat(64) } };
  const input = { publishedAt: initialTime, deliveryOrigin, candidates: [candidate(approved), candidate(pending, 'pending'), candidate(changed)] };
  assert.deepEqual(prepareFleetIndex({ ...input, approvals: [] }).index.entries, []);
  const draft = prepareFleetIndex({ ...input, approvals: [approved, pending, { ...changed, source }] });
  assert.deepEqual(draft.index.entries, [approved]);
  assert.deepEqual(draft.omitted, ['pending-tool', 'changed-skill']);
  const foreign = { ...approved, packageUrl: 'https://other.test/package.json' };
  assert.throws(() => prepareFleetIndex({ ...input, candidates: [candidate(foreign)], approvals: [foreign] }), /Invalid/);
  const revoked = prepareFleetIndex({
    ...input, publishedAt: revocationTime, approvals: [], previous: draft.index,
    revocations: [{ id: approved.id, reason: 'Fixture revocation.' }],
  });
  assert.equal(revoked.index.entries[0].state, 'revoked');
  const newer = prepareFleetIndex({
    ...input, publishedAt: '2026-11-24T00:02:00Z', approvals: [approved], previous: revoked.index,
  });
  assert.equal(newer.index.entries[0].state, 'revoked');
  assert.throws(() => prepareFleetIndex({ ...input, approvals: [], previous: draft.index }), /newer/);
});

test('private feed denies unauthorized index and package reads and a signed revocation disables an installed skill', { timeout: 15_000 }, async t => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signature = (domain, data) => sign(null, Buffer.from(`${domain}:${canonicalJson(data)}`), privateKey).toString('base64');
  const token = 'fixture-only-client-token-for-test-0001';
  const artifacts = new Map();
  const server = createServer(privateFleetReadHandler({ tokens: [token], artifacts }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });

  const deliveryOrigin = `http://127.0.0.1:${server.address().port}`;
  const catalogUrl = `${deliveryOrigin}/catalog/index.json`;
  const packageUrl = `${deliveryOrigin}/packages/review-checklist.json`;
  const pkg = {
    schema: SKILL_PACKAGE_SCHEMA, id: baseEntry.id, version: baseEntry.version, publisher: baseEntry.publisher,
    description: baseEntry.description, permissions: baseEntry.permissions, dependencies: [],
    workflow: [{ type: 'instruction', text: 'Summarize the supplied fixture records.' }], fixtures: [],
  };
  const bytes = Buffer.from(JSON.stringify({ package: pkg, signature: signature(PACKAGE_DOMAIN, pkg) }));
  const entry = { ...baseEntry, packageUrl, packageSha256: createHash('sha256').update(bytes).digest('hex') };
  const makeDraft = (options = {}) => prepareFleetIndex({
    deliveryOrigin, publishedAt: initialTime, candidates: [candidate(entry)], approvals: [entry], ...options,
  }, { fixtureLoopback: true }).index;
  const stage = index => artifacts.set('/catalog/index.json', JSON.stringify({ ...index, signature: signature(FLEET_INDEX_DOMAIN, index) }));
  const original = makeDraft();
  stage(original);
  artifacts.set('/packages/review-checklist.json', bytes);
  for (const url of [catalogUrl, packageUrl]) {
    for (const headers of [{}, { Authorization: 'Bearer fixture-only-wrong-token-for-test-0002' }]) {
      const response = await fetch(url, { headers });
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.equal(await response.text(), '');
    }
  }

  const state = mkdtempSync(join(tmpdir(), 'km-publisher-test-'));
  const fleet = join(state, 'fleet');
  mkdirSync(fleet);
  writeFileSync(join(fleet, 'skills-feed.json'), JSON.stringify({ catalogUrl, fixtureLoopback: true, auth: 'bearer' }));
  writeFileSync(join(fleet, 'skills-public-key.pem'), publicKey.export({ type: 'spki', format: 'pem' }));
  const refresh = startFleetSkillRefresh(state, () => {});
  t.after(refresh.stop);
  assert.match((await refresh.refresh()).error, /credential/);
  writeFileSync(join(fleet, 'skills-feed-token'), token, { mode: 0o600 });
  assert.equal((await refresh.refresh()).skills[0].status, 'available');
  const added = await addFleetSkill({ state, id: entry.id });
  assert.equal(added.ok, true);
  assert.equal(added.ran, false);
  let calls = 0;
  const invoke = () => connectorTurn(added.connector, 'fixture rows', {
    state, fetchImpl: async () => {
      calls += 1;
      return Response.json({ message: { content: 'Review complete.' } });
    },
  });
  assert.equal((await invoke()).text, 'Review complete.');
  stage(makeDraft({ publishedAt: revocationTime, approvals: [], previous: original, revocations: [{ id: entry.id, reason: 'Publisher revoked it.' }] }));
  assert.equal((await refresh.refresh()).skills[0].status, 'revoked');
  assert.match((await invoke()).text, /revoked/i);
  assert.equal(calls, 1);
});
