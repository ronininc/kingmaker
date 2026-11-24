import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCollectiveSkillPeer, createTestSkillCollective, publishTestedSkill } from '../lib/collective-skill-roundtrip.mjs';
import { canonicalJson } from '../vendor/fleet/fleet-packet.mjs';

const schema = 'kingmaker.skill-package/1';
const sample = {
  schema,
  intent: 'normalize-text',
  parameterSlots: ['text'],
  steps: [
    { type: 'trim-text', input: { from: 'slot', index: 0 } },
    { type: 'collapse-whitespace', input: { from: 'step', index: 0 } },
  ],
  failureConditions: [{ type: 'empty-input', slot: 0 }],
  syntheticChecks: [
    { fixture: 'sample-text', slot: 0, expect: 'completed' },
    { fixture: 'empty-text', slot: 0, expect: 'empty-input' },
  ],
};
const encode = (value) => Buffer.from(canonicalJson(value) + '\n');
const bytes = encode(sample);
const pinOf = (raw) => {
  const digest = createHash('sha256').update(raw).digest('hex');
  return { id: `skill-${digest.slice(0, 24)}`, version: '1', digest };
};
const pin = pinOf(bytes);

// A fixture-only adapter with the distiller's verifier contract. It admits one
// exact safe fixture and supplies its manifest using the requested digest.
async function verifyPackage(raw, expectedDigest) {
  if (!raw.equals(bytes) || expectedDigest !== pin.digest) return { ok: false };
  return { ok: true, manifest: { schema, ...pin, syntheticChecks: sample.syntheticChecks, permissions: [] } };
}

function runFixture(raw, input) {
  assert.deepEqual(raw, bytes);
  if (!input.trim()) return { status: 'empty-input' };
  return { status: 'completed', text: input.trim().replace(/\s+/g, ' ') };
}

function fixture(t, opts = {}) {
  const state = mkdtempSync(join(tmpdir(), 'kingmaker-skill-collective-'));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  let tests = 0;
  const testPackage = async (raw, offered) => {
    tests++;
    assert.deepEqual(offered, pin);
    assert.deepEqual(runFixture(raw, '  sample  text  '), { status: 'completed', text: 'sample text' });
    assert.deepEqual(runFixture(raw, ''), { status: 'empty-input' });
    return { ok: true, digest: pinOf(raw).digest };
  };
  const host = createTestSkillCollective({ signingKey: privateKey, verifyPackage, testPackage, ...opts });
  const author = join(state, 'author');
  const peerState = join(state, 'peer');
  const publish = (extra = {}) => publishTestedSkill({
    state: author, bytes, transport: host, publicKey, verifyPackage, authorize: () => true, ...extra,
  });
  const peer = (extra = {}) => createCollectiveSkillPeer({
    state: peerState, transport: host, publicKey, verifyPackage, authorize: () => true,
    run: ({ bytes: raw, input }) => runFixture(raw, input), ...extra,
  });
  const log = () => readFileSync(join(author, 'collective-skills', 'publication.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  return { host, publish, peer, log, state, tests: () => tests };
}

test('publishes exact tested bytes once and invokes on a fresh peer under its own permissions', async (t) => {
  const f = fixture(t);
  let allowed = false;
  let ran = 0;
  const peer = f.peer({
    authorize: (request) => {
      assert.deepEqual(request, { operation: 'invoke', ...pin, permissions: [] });
      return allowed;
    },
    run: ({ bytes: raw, input, permissions, ...identity }) => {
      assert.deepEqual(identity, pin);
      assert.deepEqual(permissions, []);
      ran++;
      return runFixture(raw, input);
    },
  });
  assert.deepEqual(await peer.invoke(pin, 'sample'), { ok: false, reason: 'not-imported' });
  const published = await Promise.all([f.publish(), f.publish()]);
  assert.ok(published.every((result) => result.ok && result.receipt.digest === pin.digest));
  assert.deepEqual(readFileSync(published[0].path), bytes);
  assert.deepEqual(f.host.events().map(({ decision, duplicate }) => [decision, duplicate]), [
    ['accepted', false], ['accepted', true],
  ]);
  assert.equal(f.tests(), 1);
  const imported = await peer.importSkill(pin);
  assert.equal(imported.ok, true);
  assert.deepEqual(readFileSync(imported.path), bytes);
  assert.equal(imported.receipt.version, pin.version);
  assert.deepEqual(await peer.invoke(pin, 'sample'), { ok: false, reason: 'peer-permission-denied' });
  assert.equal(ran, 0);
  allowed = true;
  assert.deepEqual(await peer.invoke(pin, '  fresh peer \t result '), {
    ok: true, ...pin, artifact: { status: 'completed', text: 'fresh peer result' },
  });
  assert.equal(ran, 1);
});

test('refuses invalid bytes, out-of-scope packages and failed synthetic tests with records', async (t) => {
  const f = fixture(t, { testPackage: async () => ({ ok: true, digest: '0'.repeat(64) }) });
  const bad = encode({ ...sample, rawMethod: 'unreviewed method store' });
  const invalid = await f.host.submit({ bytes: bad, pin: pinOf(bad) });
  assert.equal(invalid.receipt.reason, 'invalid-package');
  assert.equal(invalid.receipt.digest, pinOf(bad).digest);
  const wrongScope = fixture(t, { verifyPackage: async () => ({
    ok: true, manifest: { schema, ...pin, syntheticChecks: sample.syntheticChecks, permissions: ['connector.write'] },
  }) });
  assert.equal((await wrongScope.host.submit({ bytes, pin })).receipt.reason, 'invalid-package');
  const failed = await f.publish();
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'synthetic-checks-failed');
  assert.equal(failed.receipt.decision, 'refused');
  assert.deepEqual(f.host.events().map(({ decision, reason }) => [decision, reason]), [
    ['refused', 'invalid-package'], ['refused', 'synthetic-checks-failed'],
  ]);
  assert.equal(f.log()[0].receipt.signature, failed.receipt.signature);
  assert.equal((await f.peer().importSkill(pin)).reason, 'package-unavailable');
});

test('refuses package, version and signature tampering before import and invocation', async (t) => {
  const f = fixture(t);
  assert.equal((await f.publish()).ok, true);
  const altered = f.peer({ transport: { lookup(request) {
    const response = f.host.lookup(request);
    return { ...response, bytes: Buffer.concat([response.bytes, Buffer.from(' ')]) };
  } } });
  assert.equal((await altered.importSkill(pin)).reason, 'invalid-package');
  const forged = f.peer({ transport: { lookup(request) {
    const { bytes: raw, receipt } = f.host.lookup(request);
    return { bytes: raw, receipt: { ...receipt, version: '2' } };
  } } });
  assert.equal((await forged.importSkill(pin)).reason, 'unverified-receipt');
  const otherKey = generateKeyPairSync('ed25519').publicKey;
  assert.equal((await f.peer({ publicKey: otherKey }).importSkill(pin)).reason, 'unverified-receipt');
  assert.equal((await f.peer().importSkill({ ...pin, version: '2' })).reason, 'invalid-pin');
  const peer = f.peer({ run: () => assert.fail('altered local package must never run') });
  const imported = await peer.importSkill(pin);
  assert.equal(imported.ok, true);
  writeFileSync(imported.path, encode({ ...sample, intent: 'other-intent' }));
  assert.equal((await peer.invoke(pin, 'sample')).reason, 'invalid-package');
});

test('revocation blocks a fresh peer, an existing peer and replayed acceptance', async (t) => {
  const f = fixture(t);
  assert.equal((await f.publish()).ok, true);
  let cached;
  const peer = f.peer({ transport: { lookup(request) { return cached ??= f.host.lookup(request); } } });
  assert.equal((await peer.importSkill(pin)).ok, true);
  assert.equal(f.host.revoke(pin), true);
  assert.equal((await f.peer({ state: join(f.state, 'fresh-peer') }).importSkill(pin)).reason, 'package-revoked');
  assert.equal((await f.peer().invoke(pin, 'sample')).reason, 'package-revoked');
  assert.equal((await peer.invoke(pin, 'sample')).reason, 'unverified-receipt');
  assert.equal((await f.publish()).reason, 'revoked');
});

test('keeps tested work after a denied or failed upload and can retry those exact bytes', async (t) => {
  const f = fixture(t);
  const transport = { submit: () => { throw new Error('test transport unavailable'); } };
  const denied = await f.publish({ authorize: () => false, transport: {
    submit: () => assert.fail('a denied package must not leave local state'),
  } });
  assert.equal(denied.reason, 'publication-denied');
  const failed = await f.publish({ transport });
  assert.equal(failed.reason, 'upload-failed');
  assert.deepEqual(readFileSync(failed.path), bytes);
  assert.deepEqual(f.host.events(), []);
  assert.deepEqual(f.log().map(({ reason }) => reason), ['publication-denied', 'upload-failed']);
  const retried = await f.publish({ bytes: readFileSync(failed.path) });
  assert.equal(retried.ok, true);
  assert.equal(retried.digest, failed.digest);
  assert.equal(f.log()[2].receipt.decision, 'accepted');
});
