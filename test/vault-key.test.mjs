// Kingmaker makes the packaged core's credentials-vault key once (lib/runtime.mjs ensureVaultKey).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ensureVaultKey } from '../lib/runtime.mjs';

test('vault key: made once, 32 random bytes as hex, owner-only', () => {
  const root = mkdtempSync(join(tmpdir(), 'vk-'));
  assert.equal(ensureVaultKey(root, { env: {} }), 'created');
  const file = join(root, 'keys', 'credentials-vault.key');
  const key = readFileSync(file, 'utf8');
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(root, 'keys')).mode & 0o777, 0o700);
  assert.equal(ensureVaultKey(root, { env: {} }), 'present');
  assert.equal(readFileSync(file, 'utf8'), key, 'an existing key is never replaced');
});

test('vault key: an existing key is kept; SOLOMON_VAULT_KEY skips the file', () => {
  const root = mkdtempSync(join(tmpdir(), 'vk-'));
  mkdirSync(join(root, 'keys'), { recursive: true });
  writeFileSync(join(root, 'keys', 'credentials-vault.key'), 'a'.repeat(64));
  assert.equal(ensureVaultKey(root, { env: {} }), 'present');
  assert.equal(readFileSync(join(root, 'keys', 'credentials-vault.key'), 'utf8'), 'a'.repeat(64));
  const other = mkdtempSync(join(tmpdir(), 'vk-'));
  assert.equal(ensureVaultKey(other, { env: { SOLOMON_VAULT_KEY: 'b'.repeat(64) } }), 'env');
});
