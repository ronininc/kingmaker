import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ARMOR_PRODUCT, canonicalPath } from './product-paths.mjs';

/** Billing-installation identity only: not a device certificate or security receipt. */
export function installationMetadata(identityDir) {
  const dir = canonicalPath(identityDir) + '.installation', file = path.join(dir, 'installation.json');
  if (fs.existsSync(dir) && (fs.lstatSync(dir).isSymbolicLink() || !fs.lstatSync(dir).isDirectory())) throw new Error('Invalid installation metadata directory');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(dir, 0o700);
  if (!fs.existsSync(file)) {
    const record = { schema: 'scripture-armor.installation/1', product: ARMOR_PRODUCT, installationId: crypto.randomBytes(32).toString('hex') };
    try { fs.writeFileSync(file, JSON.stringify(record) + '\n', { flag: 'wx', mode: 0o600 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('Installation metadata must be a private single-link file');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let record;
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.nlink !== 1) throw new Error('Installation metadata changed before read');
    record = JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
  if (record.schema !== 'scripture-armor.installation/1' || record.product !== ARMOR_PRODUCT || !/^[a-f0-9]{64}$/.test(record.installationId)) throw new Error('Invalid installation metadata; refusing to replace it');
  const digest = crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex');
  return { installationId: record.installationId, installationEvidenceRef: 'local-metadata-sha256:' + digest };
}
