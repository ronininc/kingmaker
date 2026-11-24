// The 8 GB Auto lane uses the measured median for local text work. The
// library supplies its bytes when the card's Ollama store needs them.
import { spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hasPinnedLibraryWeights, materializeLibraryModel } from './brain-library-fetch.mjs';
import { fileMatches } from './github-release-asset.mjs';
import { checkCardDirectory, resolveModelStorage } from './model-storage.mjs';
import { readLocalModel } from './model-sync.mjs';
import { ensureCardOllama } from './ollama-runtime.mjs';
import { classifyTask } from './weight-hunter.mjs';

export const CARD_MEDIAN_TAG = 'huihui_ai/qwen3-abliterated:1.7b';

// A sidecar on the card can outlive a changed file. Reuse checks in this
// process only, and drop them when the blob or its filesystem identity changes.
const verifiedBlobs = new Map();

async function registeredPinMatches(storage, model) {
  const local = readLocalModel(model.tag, storage);
  if (!local?.complete || local.files.length !== 1) return false;
  const [blob] = local.files;
  if (blob.role !== 'weights' || blob.digest !== `sha256:${model.weights.sha256}`) return false;
  checkCardDirectory(storage, dirname(blob.path));
  const stat = lstatSync(blob.path);
  if (!stat.isFile() || stat.size !== model.weights.size) return false;
  const fingerprint = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
  if (verifiedBlobs.get(blob.path) === fingerprint) return true;
  if (!await fileMatches(blob.path, model.weights.sha256, model.weights.size, { trustSidecar: false })) {
    throw new Error(`Ollama's card weights for ${model.tag} did not match the Brain Library SHA-256`);
  }
  checkCardDirectory(storage, dirname(blob.path));
  verifiedBlobs.set(blob.path, fingerprint);
  return true;
}

/** Register verified weights with the Ollama process that owns the card. */
export async function materializeCardLibraryModel(paths, storage, model, {
  ensureRuntime = ensureCardOllama, run = spawnSync, env = process.env, reuseRegistered = false, ...fetchOptions
} = {}) {
  if (!hasPinnedLibraryWeights(model)) throw new Error(`${model.tag} has invalid or incomplete Brain Library weight pins`);
  const dir = join(storage.libraryDir, model.slug, model.weights.sha256);
  const runtime = await ensureRuntime({ paths, storage, env });
  if (!runtime.up || !runtime.baseUrl) throw new Error(runtime.reason || 'Ollama is unavailable on the Kingmaker model card');
  if (reuseRegistered && await registeredPinMatches(storage, model)) {
    return { baseUrl: runtime.baseUrl, availability: 'installed' };
  }
  const result = await materializeLibraryModel(model, {
    ...fetchOptions,
    dir,
    checkDirectory: (options) => checkCardDirectory(storage, dir, options),
    create: true,
    ollamaBin: runtime.bin,
    run: (bin, args) => run(bin, args, { stdio: 'inherit', env: { ...env, OLLAMA_HOST: runtime.baseUrl } }),
  });
  return { ...result, baseUrl: runtime.baseUrl, availability: 'materialized' };
}

export async function chooseCardLibraryModel({
  text, pin, paths, loadCatalog, resolveStorage = resolveModelStorage, ...options
}) {
  if (pin) return null;
  const role = classifyTask(text);
  if (!role || role === 'vision') return null;
  const storage = resolveStorage(paths.state);
  const catalog = await loadCatalog();
  const model = catalog?.models?.find((entry) => entry.tag === CARD_MEDIAN_TAG);
  if (!hasPinnedLibraryWeights(model)) throw new Error(`The Brain Library has no pinned weights for ${CARD_MEDIAN_TAG}`);
  const { baseUrl, availability } = await materializeCardLibraryModel(paths, storage, model, { ...options, reuseRegistered: true });
  return { hunted: true, model: model.tag, role, availability, baseUrl, swap: false };
}
