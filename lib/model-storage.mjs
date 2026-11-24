// Model weights on the smallest machines live on a mounted card. Application
// state and the existing internal Open-JEV lane keep their own paths.
import { lstatSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { totalmem } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const DEFAULT_CARD = '/Volumes/KINGMAKERSD';
const MAX_CARD_RAM = 8 * 2 ** 30;

export const usesModelCard = (totalMemBytes = totalmem()) => totalMemBytes <= MAX_CARD_RAM;

export function isInternalModel(model) {
  const name = String(typeof model === 'string' ? model : model?.tag ?? model?.slug ?? '').toLowerCase();
  return /^(?:zefancai[/-])?open-jev(?:-2b)?(?:-merged|:.*)?$/.test(name);
}

function mountedDevice(root) {
  const info = lstatSync(root, { throwIfNoEntry: false });
  if (!info?.isDirectory() || info.dev === lstatSync(dirname(root)).dev) return null;
  return info.dev;
}

function mountedIdentity(root) {
  try {
    if (process.platform === 'darwin') {
      const text = execFileSync('/usr/sbin/diskutil', ['info', root], { encoding: 'utf8', timeout: 5_000 });
      return /^\s*Volume UUID:\s*(\S+)\s*$/mi.exec(text)?.[1]?.toUpperCase() ?? null;
    }
    const text = execFileSync('/usr/bin/findmnt', ['--noheadings', '--output', 'UUID', '--target', root], { encoding: 'utf8', timeout: 5_000 });
    return text.trim().toUpperCase() || null;
  } catch {
    return null;
  }
}

const cardMissing = (root) => new Error(
  `Kingmaker model card is missing at ${root}. Insert the card or set KINGMAKER_MODEL_CARD to its mount point.`,
);

export function resolveModelStorage(stateDir, { env = process.env, totalMemBytes = totalmem(), mountDevice = mountedDevice, cardIdentity = mountedIdentity } = {}) {
  if (!usesModelCard(totalMemBytes)) {
    return {
      cardRoot: null,
      modelsDir: String(env.KINGMAKER_OLLAMA_MODELS || env.OLLAMA_MODELS || '').trim() || null,
      libraryDir: join(stateDir, 'models', 'library'),
    };
  }
  const configured = String(env.KINGMAKER_MODEL_CARD || '').trim() || DEFAULT_CARD;
  if (!isAbsolute(configured)) throw new Error('KINGMAKER_MODEL_CARD must be an absolute mount point.');
  const cardRoot = resolve(configured);
  const cardDevice = mountDevice(cardRoot);
  if (cardDevice == null) throw cardMissing(cardRoot);
  const expectedIdentity = String(env.KINGMAKER_MODEL_CARD_UUID || '').trim().toUpperCase();
  const observedIdentity = expectedIdentity ? String(cardIdentity(cardRoot) || '').trim().toUpperCase() || null : null;
  if (expectedIdentity && observedIdentity !== expectedIdentity) {
    throw new Error(`Wrong Kingmaker model card at ${cardRoot}: expected UUID ${expectedIdentity}, found ${observedIdentity || 'unavailable'}.`);
  }
  return {
    cardRoot,
    cardDevice,
    cardIdentity: observedIdentity,
    modelsDir: join(cardRoot, 'ollama-models'),
    libraryDir: join(cardRoot, 'models', 'library'),
    mountDevice,
  };
}

/** Keep creation below the checked mount and reject symlinks and nested mounts. */
export function checkCardDirectory(storage, dir, { create = false } = {}) {
  if (!storage.cardRoot) return dir;
  const { cardRoot, cardDevice, mountDevice } = storage;
  const child = relative(cardRoot, dir);
  if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error(`Model directory must be on the Kingmaker model card: ${dir}`);
  }
  if (mountDevice(cardRoot) !== cardDevice) throw cardMissing(cardRoot);
  let current = cardRoot;
  for (const part of child.split(sep).filter(Boolean)) {
    current = join(current, part);
    let info = lstatSync(current, { throwIfNoEntry: false });
    if (!info && create) {
      try { mkdirSync(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      info = lstatSync(current);
    }
    if (!info) break;
    if (!info.isDirectory() || info.dev !== cardDevice) {
      throw new Error(`Model directory must be on the Kingmaker model card: ${current}`);
    }
  }
  if (mountDevice(cardRoot) !== cardDevice) throw cardMissing(cardRoot);
  return dir;
}
