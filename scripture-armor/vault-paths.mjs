import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { canonicalPath } from './product-paths.mjs';

export function externalFile(input, { identityDir, home = os.homedir() } = {}) {
  if (typeof input !== 'string' || !path.isAbsolute(input)) throw new Error('source must be absolute');
  const stat = fs.lstatSync(input);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('source must be a single-link regular file, not a symlink');
  const resolved = fs.realpathSync(input);
  const protectedRoots = [identityDir, identityDir && canonicalPath(identityDir) + '.installation', path.join(home, '.scripture-armor'), path.join(home, '.scripture-armor.installation'), path.join(home, '.kingmaker', 'scripture-armor'), path.join(home, '.kingmaker', 'scripture-armor.installation')].filter(Boolean).map(canonicalPath);
  if (protectedRoots.some(root => resolved === root || resolved.startsWith(root + path.sep))) throw new Error('source resolves into a protected Armor identity or vault');
  return { path: resolved, dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
}
export function sameExternalFile(expected, options) {
  const actual = externalFile(expected.path, options);
  if (['dev', 'ino', 'size', 'mtimeMs'].some(k => actual[k] !== expected[k])) throw new Error('source changed during the operation; original preserved');
  return actual;
}
export function readExternalFile(expected, options) {
  sameExternalFile(expected, options);
  const fd = fs.openSync(expected.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || ['dev', 'ino', 'size', 'mtimeMs'].some(k => stat[k] !== expected[k])) throw new Error('source changed before read');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}
