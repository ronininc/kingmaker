// Integration tests for rotation-runtime.mjs — synthetic identities only,
// generated fresh in a temp dir per test. No real store is ever opened.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateIdentityRecord, identityFromRecord, publicBlock } from '../armor.mjs';
import { publicRevision, verifyTransition } from '../key-transition.mjs';
import { SyntheticIdentityStore, SyntheticOwnerAuthorizer, rotationBinding } from '../rotation-runtime.mjs';

const NOW = 1_700_000_000;
const here = path.dirname(fileURLToPath(import.meta.url));

function authorityFixture() {
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = pair.publicKey.export({ format: 'jwk' });
  const pin = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64');
  return { privateKey: pair.privateKey, pin };
}
function makeStore(t, authority = authorityFixture()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'armor-rotation-runtime-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const storeDir = path.join(dir, 'store');
  const store = SyntheticIdentityStore.create(storeDir, { label: 'synthetic-runtime', rotationAuthorityPin: authority.pin });
  return { dir, storeDir, store, authority };
}
function goodAuth() {
  const authorizer = new SyntheticOwnerAuthorizer({ approver: () => true });
  return { authorizer, requestAuthorization: binding => authorizer.authorize('rotate', binding) };
}

// A synthetic enrolled peer: holds its own enrolled copy of the device's
// public identity + the authority pin, verifies transitions for real, and
// answers with dual-signed (Ed25519 + ML-DSA) ack receipts.
class StubPeer {
  constructor(store, authorityPin) {
    this.identity = identityFromRecord(generateIdentityRecord('stub-peer'));
    this.enrolled = { deviceId: store.anchor.deviceId, epoch: store.anchor.epoch, publicIdentity: publicBlock(store.identity), rotationAuthority: authorityPin };
    this.online = true;
  }
  get publicIdentity() { return publicBlock(this.identity); }
  deliver(document) {
    if (!this.online) throw Error('peer offline');
    const verified = verifyTransition(document, this.enrolled, NOW);
    this.enrolled = { deviceId: this.enrolled.deviceId, epoch: verified.epoch, publicIdentity: verified.publicIdentity, rotationAuthority: this.enrolled.rotationAuthority };
    const receipt = { schema: 'scripture-armor.key-transition-ack/1', transitionId: verified.transitionId, peerRevision: publicRevision(this.publicIdentity) };
    const payload = Buffer.from(JSON.stringify(Object.values(receipt)));
    return { ...receipt, signature: crypto.sign(null, payload, this.identity.signPriv).toString('base64'), pqSignature: crypto.sign(null, payload, this.identity.mldsaPriv).toString('base64') };
  }
}

test('(a)+(c) end-to-end rotation: re-encrypted data opens under the new key, pre-rotation ciphertext opens via retired recovery', t => {
  const { store, authority } = makeStore(t);
  store.sealData('note-one', 'synthetic secret one');
  store.sealData('note-two', 'synthetic secret two');
  const preRotationCiphertext = fs.readFileSync(path.join(store.dir, 'data', 'note-one.scripture'), 'utf8');
  const oldRevision = store.anchor.revision;
  const result = store.rotate({ ...goodAuth(), authorityPrivateKey: authority.privateKey, now: NOW });
  assert.equal(result.epoch, 1);
  assert.notEqual(store.anchor.revision, oldRevision);
  assert.equal(store.openData('note-one').toString(), 'synthetic secret one');
  assert.equal(store.openData('note-two').toString(), 'synthetic secret two');
  // the exact pre-rotation bytes still decrypt post-rotation (retired package)
  assert.equal(store._openText(preRotationCiphertext).toString(), 'synthetic secret one');
  // and the store keeps working on the new generation
  store.sealData('note-three', 'post-rotation secret');
  assert.equal(store.openData('note-three').toString(), 'post-rotation secret');
  // reopening from disk lands on the same committed generation
  const reopened = SyntheticIdentityStore.open(store.dir);
  assert.equal(reopened.anchor.epoch, 1);
  assert.equal(reopened.openData('note-one').toString(), 'synthetic secret one');
});

test('(a) quiesce: seal/open/sign and a second open are refused mid-rotation', t => {
  const { store, authority } = makeStore(t);
  store.sealData('guarded', 'guarded secret');
  const refusals = [];
  const hooks = {
    afterPhase(phase) {
      if (phase !== 'prepared') return;
      for (const attempt of [() => store.sealData('x', 'y'), () => store.openData('guarded'), () => store.sign('z'), () => SyntheticIdentityStore.open(store.dir, { recover: false })]) {
        try { attempt(); refusals.push('NOT REFUSED'); } catch (e) { refusals.push(e.message); }
      }
    },
  };
  store.rotate({ ...goodAuth(), authorityPrivateKey: authority.privateKey, now: NOW, hooks });
  assert.equal(refusals.length, 4);
  assert.ok(refusals.every(m => /quiesced|recovery required/.test(m)), refusals.join(' | '));
  assert.equal(store.openData('guarded').toString(), 'guarded secret'); // usable again after commit
});

test('(b) owner-auth gate: denial, wrong binding, expiry, replay, and grant opacity all refuse rotation', t => {
  { // approver denies
    const { store, authority } = makeStore(t);
    const authorizer = new SyntheticOwnerAuthorizer({ approver: () => false });
    assert.throws(() => store.rotate({ authorizer, authorityPrivateKey: authority.privateKey, now: NOW, requestAuthorization: b => authorizer.authorize('rotate', b) }), /denied/);
    assert.equal(store.anchor.epoch, 0);
    assert.equal(fs.existsSync(store.journalPath), false);
  }
  { // grant issued for a different binding (candidate substitution)
    const { store, authority } = makeStore(t);
    const auth = goodAuth();
    assert.throws(() => store.rotate({ ...auth, authorityPrivateKey: authority.privateKey, now: NOW, requestAuthorization: () => auth.authorizer.authorize('rotate', 'f'.repeat(64)) }), /grant refused/);
    assert.equal(store.anchor.epoch, 0);
  }
  { // grant expires (15 s native deadline) before consumption
    const { store, authority } = makeStore(t);
    let clock = 1000;
    const authorizer = new SyntheticOwnerAuthorizer({ approver: () => true, clock: () => clock });
    assert.throws(() => store.rotate({ authorizer, authorityPrivateKey: authority.privateKey, now: NOW, requestAuthorization: b => { const g = authorizer.authorize('rotate', b); clock += 16; return g; } }), /grant refused/);
    assert.equal(store.anchor.epoch, 0);
  }
  { // replaying a consumed grant on a second rotation is refused; grants are not serializable tokens
    const { store, authority } = makeStore(t);
    const auth = goodAuth();
    let captured;
    store.rotate({ ...auth, authorityPrivateKey: authority.privateKey, now: NOW, requestAuthorization: b => { captured = auth.requestAuthorization(b); return captured; } });
    assert.equal(store.anchor.epoch, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(captured)), {});
    assert.throws(() => store.rotate({ ...auth, authorityPrivateKey: authority.privateKey, now: NOW + 10, requestAuthorization: () => captured }), /grant refused/);
    assert.equal(store.anchor.epoch, 1);
  }
  { // wrong enrolled authority key cannot sign the transition
    const { store } = makeStore(t);
    const wrong = authorityFixture();
    assert.throws(() => store.rotate({ ...goodAuth(), authorityPrivateKey: wrong.privateKey, now: NOW }), /authority/);
    assert.equal(store.anchor.epoch, 0);
  }
});

test('(e) signing transition: pre-rotation signatures verify only inside the window; old signing keys are not retained', t => {
  const { store, authority } = makeStore(t);
  const preSignature = store.sign({ memo: 'signed before rotation' });
  assert.equal(store.verifyTrusted(preSignature, { now: NOW }), true);
  store.rotate({ ...goodAuth(), authorityPrivateKey: authority.privateKey, now: NOW });
  assert.equal(store.verifyTrusted(preSignature, { now: NOW + 60 }), true); // previous generation, window open
  assert.equal(store.verifyTrusted(preSignature, { now: NOW + 300 }), false); // window closed
  const postSignature = store.sign({ memo: 'signed after rotation' });
  assert.equal(store.verifyTrusted(postSignature, { now: NOW + 300 }), true); // current generation always resolves
  // second rotation retires the first generation entirely
  store.rotate({ ...goodAuth(), authorityPrivateKey: authority.privateKey, now: NOW + 400 });
  assert.equal(store.verifyTrusted(preSignature, { now: NOW + 460 }), false);
  assert.equal(store.anchor.epoch, 2);
});

test('(f) peer propagation: authenticated acks count, offline/bad peers stay visibly un-acked, retry completes', t => {
  const { store, authority } = makeStore(t);
  const good = new StubPeer(store, authority.pin);
  const flaky = new StubPeer(store, authority.pin);
  const bad = new StubPeer(store, authority.pin);
  flaky.online = false;
  store.rotate({ ...goodAuth(), authorityPrivateKey: authority.privateKey, now: NOW, enrolledPeers: [good.publicIdentity, flaky.publicIdentity, bad.publicIdentity] });
  assert.deepEqual(store.propagationStatus(), { complete: false, pending: [publicRevision(good.publicIdentity), publicRevision(flaky.publicIdentity), publicRevision(bad.publicIdentity)], acknowledged: 0 });
  // a forged ack for the bad peer: right peer revision, wrong transition and
  // a signature from an unrelated key — must be rejected without touching
  // the real peer's enrolled state, so the genuine peer can still ack later
  const forgerIdentity = identityFromRecord(generateIdentityRecord('forger'));
  const forger = { publicIdentity: bad.publicIdentity, deliver: () => {
    const receipt = { schema: 'scripture-armor.key-transition-ack/1', transitionId: 'a'.repeat(64), peerRevision: publicRevision(bad.publicIdentity) };
    const payload = Buffer.from(JSON.stringify(Object.values(receipt)));
    return { ...receipt, signature: crypto.sign(null, payload, forgerIdentity.signPriv).toString('base64'), pqSignature: crypto.sign(null, payload, forgerIdentity.mldsaPriv).toString('base64') };
  } };
  const first = store.propagate([good, forger]);
  assert.equal(first.results[publicRevision(good.publicIdentity)], 'acknowledged');
  assert.match(first.results[publicRevision(bad.publicIdentity)], /^rejected/);
  assert.equal(first.status.complete, false);
  assert.equal(first.status.acknowledged, 1);
  assert.equal(good.enrolled.epoch, 1);
  // replayed delivery to an already-updated peer is refused by the peer itself
  assert.throws(() => good.deliver(store.rotate ? JSON.parse(fs.readFileSync(store.propPath, 'utf8')).document : null), /epoch mismatch/);
  flaky.online = true;
  const second = store.propagate([flaky, bad]);
  assert.equal(second.status.complete, true);
  assert.equal(second.status.acknowledged, 3);
  assert.deepEqual(store.propagationStatus(), { complete: true, pending: [], acknowledged: 3 });
});

test('(d) kill-mid-rotation recovery: every phase boundary recovers to exactly one consistent generation', t => {
  for (const phase of ['quiesced', 'prepared', 'authorized', 'reencrypted', 'committed']) {
    const { dir, storeDir, store, authority } = makeStore(t);
    store.sealData('survivor', `secret surviving kill at ${phase}`);
    const preSignature = store.sign({ memo: phase });
    const privPem = path.join(dir, 'authority-priv.pem');
    fs.writeFileSync(privPem, authority.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    let exitCode = 0;
    try { execFileSync(process.execPath, [path.join(here, 'rotation-crash-driver.mjs'), storeDir, phase, privPem], { stdio: 'pipe' }); }
    catch (e) { exitCode = e.status; }
    assert.equal(exitCode, 86, `driver should have been killed at ${phase}`);
    // an unrecovered store refuses a plain open
    assert.throws(() => SyntheticIdentityStore.open(storeDir, { recover: false }), /recovery required/);
    const recovered = SyntheticIdentityStore.open(storeDir);
    const expectedEpoch = phase === 'committed' ? 1 : 0;
    assert.equal(recovered.anchor.epoch, expectedEpoch, `kill at ${phase}`);
    // never neither: whichever generation is current, the data opens and prior signatures resolve
    assert.equal(recovered.openData('survivor').toString(), `secret surviving kill at ${phase}`);
    assert.equal(recovered.verifyTrusted(preSignature, { now: Math.floor(Date.now() / 1000) }), true, `kill at ${phase}`);
    // and the store is fully usable afterwards
    recovered.sealData('after-recovery', 'recovered and working');
    assert.equal(recovered.openData('after-recovery').toString(), 'recovered and working');
    assert.equal(fs.existsSync(path.join(storeDir, 'journal.json')), false);
    assert.equal(fs.existsSync(path.join(storeDir, 'quiesced')), false);
  }
});

test('rotation binding matches the native Swift shape (binding of exact candidate bytes)', t => {
  const snapshot = Buffer.from('synthetic snapshot bytes');
  const transition = Buffer.from('synthetic transition bytes');
  const binding = rotationBinding(snapshot, transition, 'abc123', 3);
  assert.match(binding, /^[a-f0-9]{64}$/);
  assert.notEqual(rotationBinding(snapshot, transition, 'abc123', 4), binding); // epoch-bound
  assert.notEqual(rotationBinding(Buffer.from('other snapshot'), transition, 'abc123', 3), binding); // candidate-bound
  assert.notEqual(rotationBinding(snapshot, Buffer.from('other transition'), 'abc123', 3), binding); // transition-bound
});
