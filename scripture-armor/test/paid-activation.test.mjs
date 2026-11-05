import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { hasPaidActivation, loadPaidActivation, recordPaidActivation } from '../paid-activation.mjs';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'armor-paid-marker-'));
  const { publicKey: signPub, privateKey: signPriv } = crypto.generateKeyPairSync('ed25519');
  return { dir, identity: { signFp: 'sign-a', sealFp: 'seal-a', signPub, signPriv }, entitlement: { verifiedAt: 1_800_000_000, term: { endsAt: 1_800_003_600 } } };
}

test('preexisting identity without a paid marker is not paid activation', () => {
  const f = fixture();
  assert.equal(hasPaidActivation(f.dir, f.identity), false);
});

test('paid marker is identity-bound, signed, durable, and contains no member credential', () => {
  const f = fixture();
  recordPaidActivation(f.dir, f.identity, f.entitlement, '2026-11-04T00:00:00.000Z');
  const loaded = loadPaidActivation(f.dir, f.identity);
  assert.equal(loaded.product, 'scripture-armor');
  assert.equal(hasPaidActivation(f.dir, f.identity), true);
  assert.equal(fs.statSync(path.join(f.dir, 'paid-activation.json')).mode & 0o777, 0o600);
  assert.doesNotMatch(JSON.stringify(loaded), /email|code|seat_key|RSA-/i);
  assert.equal(hasPaidActivation(f.dir, { ...f.identity, signFp: 'sign-other' }), false);
});

test('tampered marker is refused without touching vault data', () => {
  const f = fixture();
  recordPaidActivation(f.dir, f.identity, f.entitlement);
  const file = path.join(f.dir, 'paid-activation.json');
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  record.entitlementTermEnd += 1;
  fs.writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
  assert.equal(loadPaidActivation(f.dir, f.identity), null);
});
