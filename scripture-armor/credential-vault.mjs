import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { externalFile, sameExternalFile, readExternalFile } from './vault-paths.mjs';
import {
  armorDecode,
  loadIdentity,
  openSealedFile,
  parseScriptureFile,
  sealPlaintext,
  unsealFileKey,
  verifyFrameSignature,
} from './armor.mjs';

const MANIFEST_SCHEMA = 'scripture-armor.credential-migration/1';

function privateWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, data, { mode: 0o600, flag: 'wx' });
  fs.chmodSync(file, 0o600);
}

export function loadMigrationManifest(file, options = {}) {
  if (!file) return { schema: MANIFEST_SCHEMA, entries: [] };
  const resolved = path.resolve(file);
  const manifestState = externalFile(resolved, options);
  const doc = JSON.parse(readExternalFile(manifestState, options).toString('utf8'));
  if (doc.schema !== MANIFEST_SCHEMA || !Array.isArray(doc.entries)) {
    throw new Error(`credential migration manifest must use ${MANIFEST_SCHEMA}`);
  }
  const seen = new Set();
  const entries = doc.entries.map((entry, index) => {
    const id = String(entry?.id || '').trim();
    const source = path.resolve(String(entry?.source || ''));
    if (!/^[a-zA-Z0-9._-]{1,80}$/.test(id)) throw new Error(`entry ${index}: invalid id`);
    if (seen.has(id)) throw new Error(`entry ${index}: duplicate id ${id}`);
    if (!path.isAbsolute(String(entry?.source || ''))) throw new Error(`entry ${index}: source must be absolute`);
    const sourceState = externalFile(source, options);
    seen.add(id);
    return {
      id,
      label: String(entry.label || id).slice(0, 160),
      source: sourceState.path,
      sourceState,
      removeAfterVerify: entry.removeAfterVerify === true,
    };
  });
  return { schema: MANIFEST_SCHEMA, source: resolved, entries };
}

export function previewMigration(file, options = {}) {
  const manifest = loadMigrationManifest(file, options);
  return {
    schema: manifest.schema,
    count: manifest.entries.length,
    plaintextBackupPolicy: 'Originals are preserved by default. Moving originals to private plaintext backups requires separate consent; backups remain until the owner removes them.',
    entries: manifest.entries.map(({ id, label, source, removeAfterVerify }) => ({
      id,
      label,
      sourceName: path.basename(source),
      bytes: fs.statSync(source).size,
      removeAfterVerify,
    })),
  };
}

function verifyOwnPackage(text, identity, expected) {
  const { frame, body } = parseScriptureFile(text);
  if (!verifyFrameSignature(frame, body)) throw new Error('vault import signature verification failed');
  if (frame.recipient_seal_fp !== identity.sealFp || frame.recipient_kem_fp !== identity.kemFp) {
    throw new Error('vault import recipient mismatch');
  }
  const fileKey = unsealFileKey(identity, frame);
  const payload = armorDecode(body, Buffer.from(frame.armor_seed, 'base64'));
  const opened = openSealedFile(fileKey, frame, payload);
  if (!crypto.timingSafeEqual(opened, expected)) throw new Error('vault import round-trip mismatch');
}

export function migrateCredentials({ identityDir, manifestFile, allowPlaintextBackup = false }) {
  const identity = loadIdentity(identityDir);
  if (!identity) throw new Error('Scripture Armor must be activated before credential migration');
  const options = { identityDir };
  const manifest = loadMigrationManifest(manifestFile, options);
  const vaultDir = path.join(identityDir, 'credential-vault');
  if (fs.existsSync(vaultDir) && (fs.lstatSync(vaultDir).isSymbolicLink() || !fs.lstatSync(vaultDir).isDirectory())) throw new Error('vault destination must be a private directory, not a symlink');
  fs.mkdirSync(vaultDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(vaultDir, 0o700);
  const imported = [];

  for (const entry of manifest.entries) {
    const plaintext = readExternalFile(entry.sourceState, options);
    const destination = path.join(vaultDir, `${entry.id}.scripture`);
    if (fs.existsSync(destination)) throw new Error(`vault entry already exists: ${entry.id}`);
    const sealed = sealPlaintext(plaintext, identity, identity, {
      scan: { verdict: 'not-applicable', digest: null, reportCanary: null, override: null, tier: 0 },
    });
    verifyOwnPackage(sealed.text, identity, plaintext);
    privateWrite(destination, sealed.text);
    verifyOwnPackage(fs.readFileSync(destination, 'utf8'), identity, plaintext);

    let sourceRemoved = false;
    let plaintextBackup = null;
    if (entry.removeAfterVerify && allowPlaintextBackup === true) {
      const backupDir = path.join(identityDir, 'migration-backups');
      if (fs.existsSync(backupDir) && (fs.lstatSync(backupDir).isSymbolicLink() || !fs.lstatSync(backupDir).isDirectory())) throw new Error('backup destination must be a private directory, not a symlink');
      fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
      fs.chmodSync(backupDir, 0o700);
      sameExternalFile(entry.sourceState, options);
      const backup = path.join(backupDir, `${entry.id}.${crypto.randomUUID()}.bak`);
      fs.renameSync(entry.source, backup);
      fs.chmodSync(backup, 0o600);
      sourceRemoved = true;
      plaintextBackup = { file: path.basename(backup), encrypted: false, retention: 'until-owner-explicitly-removes', automaticallyDeleted: false };
    }
    imported.push({ id: entry.id, label: entry.label, sourceRemoved, originalPreserved: !sourceRemoved, plaintextBackup, package: path.basename(destination) });
  }

  const receipt = {
    schema: 'scripture-armor.credential-migration-receipt/1',
    at: new Date().toISOString(),
    imported,
  };
  const receiptFile = path.join(identityDir, `credential-migration-${Date.now()}.json`);
  privateWrite(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
  return { ...receipt, receiptFile };
}
