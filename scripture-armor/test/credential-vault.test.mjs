import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createIdentity } from '../armor.mjs';
import { loadMigrationManifest, migrateCredentials, previewMigration } from '../credential-vault.mjs';

function fixture({ removeAfterVerify = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scripture-armor-vault-'));
  const identityDir = path.join(root, 'identity');
  const source = path.join(root, 'fixture-token.txt');
  const manifest = path.join(root, 'migration.json');
  fs.writeFileSync(source, 'fixture-secret-never-a-real-credential', { mode: 0o600 });
  fs.writeFileSync(manifest, JSON.stringify({
    schema: 'scripture-armor.credential-migration/1',
    entries: [{ id: 'fixture-token', label: 'Fixture token', source, removeAfterVerify }],
  }));
  createIdentity(identityDir, 'fixture-device');
  return { root, identityDir, source, manifest };
}

test('migration preview reveals metadata but not credential contents', () => {
  const f = fixture();
  const preview = previewMigration(f.manifest);
  assert.equal(preview.count, 1);
  assert.equal(preview.entries[0].sourceName, 'fixture-token.txt');
  assert.doesNotMatch(JSON.stringify(preview), /fixture-secret/);
});

test('credential import seals and verifies before preserving the original', () => {
  const f = fixture();
  const result = migrateCredentials({ identityDir: f.identityDir, manifestFile: f.manifest });
  assert.equal(result.imported.length, 1);
  assert.equal(result.imported[0].sourceRemoved, false);
  assert.equal(fs.existsSync(f.source), true);
  const sealed = fs.readFileSync(path.join(f.identityDir, 'credential-vault', 'fixture-token.scripture'), 'utf8');
  assert.match(sealed, /^SCRIPTURE-ARMOR v4\n/);
  assert.doesNotMatch(sealed, /fixture-secret/);
});

test('manifest move request alone preserves original and creates no plaintext backup', () => {
  const f = fixture({ removeAfterVerify: true });
  const result = migrateCredentials({ identityDir: f.identityDir, manifestFile: f.manifest });
  assert.equal(result.imported[0].originalPreserved, true);
  assert.equal(result.imported[0].plaintextBackup, null);
  assert.equal(fs.existsSync(f.source), true);
  assert.equal(fs.existsSync(path.join(f.identityDir, 'migration-backups')), false);
});
test('explicit move consent retains a disclosed private plaintext backup after verified import', () => {
  const f = fixture({ removeAfterVerify: true });
  const result = migrateCredentials({ identityDir: f.identityDir, manifestFile: f.manifest, allowPlaintextBackup: true });
  assert.equal(result.imported[0].sourceRemoved, true);
  assert.equal(fs.existsSync(f.source), false);
  const backups = fs.readdirSync(path.join(f.identityDir, 'migration-backups'));
  assert.equal(backups.length, 1);
  assert.equal(result.imported[0].plaintextBackup.encrypted, false);
  assert.equal(result.imported[0].plaintextBackup.retention, 'until-owner-explicitly-removes');
  assert.equal(fs.statSync(path.join(f.identityDir, 'migration-backups', backups[0])).mode & 0o777, 0o600);
});

test('manifest refuses relative sources and duplicate ids', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scripture-armor-vault-bad-'));
  const manifest = path.join(root, 'migration.json');
  fs.writeFileSync(manifest, JSON.stringify({
    schema: 'scripture-armor.credential-migration/1',
    entries: [{ id: 'same', source: './relative' }, { id: 'same', source: './relative' }],
  }));
  assert.throws(() => loadMigrationManifest(manifest), /source must be absolute/);
});
