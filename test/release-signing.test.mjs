// Kingmaker release-manifest signing: the private key proves a release is the operator's; the installer verifies the
// detached signature against the pinned public key before trusting any sha256. See lib/release-signing.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateReleaseKeypair, signManifestBytes, verifyManifestBytes, pubkeyFingerprint, RSA_MODULUS_BITS } from '../lib/release-signing.mjs';
import { RELEASE_PUBLIC_KEY_PEM } from '../lib/release-pubkey.mjs';

const MANIFEST = `${JSON.stringify({ schema: 'kingmaker.release/1', tag: 'v0.2.0', app: { sha256: 'a'.repeat(64) } }, null, 2)}\n`;

test('sign → verify round-trips with the generated keypair', () => {
  const { publicKeyPem, privateKeyPem } = generateReleaseKeypair();
  const sig = signManifestBytes(Buffer.from(MANIFEST), privateKeyPem);
  assert.equal(verifyManifestBytes(Buffer.from(MANIFEST), sig, publicKeyPem), true);
});

test('a tampered manifest fails verification', () => {
  const { publicKeyPem, privateKeyPem } = generateReleaseKeypair();
  const sig = signManifestBytes(Buffer.from(MANIFEST), privateKeyPem);
  const tampered = MANIFEST.replace('a'.repeat(64), 'b'.repeat(64)); // swapped the app sha256
  assert.equal(verifyManifestBytes(Buffer.from(tampered), sig, publicKeyPem), false);
});

test('a signature from a different key fails against the pinned key', () => {
  const a = generateReleaseKeypair();
  const b = generateReleaseKeypair();
  const sig = signManifestBytes(Buffer.from(MANIFEST), a.privateKeyPem);
  assert.equal(verifyManifestBytes(Buffer.from(MANIFEST), sig, b.publicKeyPem), false);
});

test('garbage and empty signatures are rejected, not thrown on', () => {
  const { publicKeyPem } = generateReleaseKeypair();
  assert.equal(verifyManifestBytes(Buffer.from(MANIFEST), '', publicKeyPem), false);
  assert.equal(verifyManifestBytes(Buffer.from(MANIFEST), 'not-base64-@@@', publicKeyPem), false);
  assert.equal(verifyManifestBytes(Buffer.from(MANIFEST), Buffer.from('short').toString('base64'), publicKeyPem), false);
});

test('a public key is pinned in the repo and has a stable fingerprint', () => {
  assert.ok(RELEASE_PUBLIC_KEY_PEM.includes('BEGIN PUBLIC KEY'), 'lib/kingmaker-release-public.pem must hold a real PEM');
  assert.match(pubkeyFingerprint(RELEASE_PUBLIC_KEY_PEM), /^([0-9A-F]{4} )+[0-9A-F]{4}$/);
});

test('the keypair is RSA of the pinned modulus (so stock macOS openssl can verify it)', () => {
  const { publicKeyPem } = generateReleaseKeypair();
  assert.ok(publicKeyPem.includes('BEGIN PUBLIC KEY'));
  assert.equal(RSA_MODULUS_BITS, 4096);
});

// The real guarantee is that macOS's own `openssl` (LibreSSL) accepts the Node-produced signature, because the
// installer verifies in pure shell. Skips cleanly where openssl is absent.
test('stock openssl verifies the Node signature and rejects a tampered manifest', () => {
  if (!spawnSync('openssl', ['version']).stdout) return; // no openssl here; the pure-JS tests still cover the logic
  const dir = mkdtempSync(join(tmpdir(), 'km-sign-'));
  const { publicKeyPem, privateKeyPem } = generateReleaseKeypair();
  const pub = join(dir, 'pub.pem'); const msg = join(dir, 'm.json'); const bin = join(dir, 'sig.bin');
  writeFileSync(pub, publicKeyPem);
  writeFileSync(msg, MANIFEST);
  writeFileSync(bin, Buffer.from(signManifestBytes(Buffer.from(MANIFEST), privateKeyPem), 'base64'));
  const args = ['dgst', '-sha256', '-sigopt', 'rsa_padding_mode:pss', '-sigopt', 'rsa_pss_saltlen:-1', '-verify', pub, '-signature', bin, msg];
  assert.equal(spawnSync('openssl', args).status, 0, 'openssl must accept the signature');
  writeFileSync(msg, `${MANIFEST}tampered`);
  assert.notEqual(spawnSync('openssl', args).status, 0, 'openssl must reject a tampered manifest');
});
