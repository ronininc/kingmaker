// A removable method pack is an explicitly configured, UUID-bound source. It
// never falls back to the bundled catalog: absence and replacement are facts.
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

function mountedDevice(root) {
  const info = lstatSync(root, { throwIfNoEntry: false });
  if (!info?.isDirectory() || info.dev === lstatSync(dirname(root)).dev) return null;
  return info.dev;
}

function volumeUuid(root) {
  try {
    if (process.platform !== 'darwin') return null;
    const text = execFileSync('/usr/sbin/diskutil', ['info', root], { encoding: 'utf8', timeout: 5_000 });
    return /^\s*Volume UUID:\s*(\S+)\s*$/mi.exec(text)?.[1]?.toUpperCase() ?? null;
  } catch { return null; }
}

export function removableMethodsConfigured(env = process.env) {
  return Boolean(String(env.KINGMAKER_METHOD_CARD ?? '').trim() || String(env.KINGMAKER_METHOD_CARD_UUID ?? '').trim() || String(env.KINGMAKER_METHOD_DIR ?? '').trim());
}

export function resolveRemovableMethods({ env = process.env, home = homedir(), configFile = null, mountDevice = mountedDevice, cardIdentity = volumeUuid } = {}) {
  const file = configFile ?? join(home, 'Library', 'Application Support', 'sol-ghost', 'removable-methods.json');
  let stored = null;
  if (!removableMethodsConfigured(env)) {
    try { stored = JSON.parse(readFileSync(file, 'utf8')); } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Kingmaker removable method configuration is invalid at ${file}: ${error.message}`);
    }
  }
  if (!removableMethodsConfigured(env) && !stored) return null;
  const rootValue = String(env.KINGMAKER_METHOD_CARD ?? stored?.card ?? '').trim();
  const expected = String(env.KINGMAKER_METHOD_CARD_UUID ?? stored?.uuid ?? '').trim().toUpperCase();
  const child = String(env.KINGMAKER_METHOD_DIR ?? stored?.directory ?? 'kingmaker-methods').trim();
  if (!rootValue || !isAbsolute(rootValue)) throw new Error('KINGMAKER_METHOD_CARD must be an absolute mounted-volume path');
  if (!expected) throw new Error('KINGMAKER_METHOD_CARD_UUID is required for a removable method source');
  if (!child || isAbsolute(child) || child.split(/[\\/]+/).includes('..')) throw new Error('KINGMAKER_METHOD_DIR must stay relative to the configured method card');
  const root = resolve(rootValue), device = mountDevice(root);
  if (device == null) throw new Error(`Kingmaker method card is unavailable at ${root}; no internal method copy was used`);
  const observed = String(cardIdentity(root) ?? '').trim().toUpperCase();
  if (observed !== expected) throw new Error(`Wrong Kingmaker method card at ${root}: expected UUID ${expected}, found ${observed || 'unavailable'}; no internal method copy was used`);
  const directory = resolve(root, child);
  const rel = relative(root, directory);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('configured method directory escapes the method card');
  const info = lstatSync(directory, { throwIfNoEntry: false });
  if (!info?.isDirectory() || info.dev !== device) throw new Error(`Kingmaker method directory is unavailable on the verified card: ${directory}; no internal method copy was used`);
  const index = join(directory, 'index.json');
  const indexInfo = lstatSync(index, { throwIfNoEntry: false });
  if (!indexInfo?.isFile() || indexInfo.dev !== device) throw new Error(`Kingmaker method index is unavailable on the verified card: ${index}; no internal method copy was used`);
  return Object.freeze({ root, directory, index, indexUrl: pathToFileURL(index), uuid: observed, device });
}
