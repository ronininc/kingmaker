#!/usr/bin/env node
// Read-only production dependency closure. This does not certify semantic/model quality or installed outcomes.
import { closeSync, lstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
function regular(file, executable = false) {
  let stat; try { stat = lstatSync(file); } catch { throw new Error(`production capability is missing: ${file}`); }
  if (!stat.isFile() || !stat.size || (executable && !(stat.mode & 0o111))) throw new Error(`production capability is not a nonempty ${executable ? 'executable ' : ''}regular file: ${file}`);
  return stat;
}
function staticEmbedding(root) {
  const dir = join(root, 'knowledge-runtime', 'models', 'static-embedding');
  const file = join(dir, 'model.safetensors'), stat = regular(file);
  if (regular(join(dir, 'tokenizer.json')).size > 32 * 1024 * 1024) throw new Error('production static embedding tokenizer exceeds its size limit');
  const handle = openSync(file, 'r'); let header, headerLength;
  try {
    const size = Buffer.alloc(8); if (readSync(handle, size, 0, 8, 0) !== 8) throw new Error('short header');
    headerLength = Number(size.readBigUInt64LE());
    if (!Number.isSafeInteger(headerLength) || headerLength <= 0 || headerLength > 16 * 1024 * 1024 || 8 + headerLength > stat.size) throw new Error('invalid header length');
    const bytes = Buffer.alloc(headerLength); if (readSync(handle, bytes, 0, headerLength, 8) !== headerLength) throw new Error('short header');
    header = JSON.parse(bytes.toString('utf8'));
  } catch { throw new Error('production static embedding has an invalid safetensors header'); }
  finally { closeSync(handle); }
  const tensor = header.embeddings, shape = tensor?.shape, offsets = tensor?.data_offsets;
  if (tensor?.dtype !== 'F32' || !Array.isArray(shape) || shape.length !== 2 || shape.some((n) => !Number.isSafeInteger(n) || n <= 0)
    || !Array.isArray(offsets) || offsets.length !== 2 || offsets.some((n) => !Number.isSafeInteger(n) || n < 0)
    || !Number.isSafeInteger(shape[0] * shape[1] * 4) || offsets[1] - offsets[0] !== shape[0] * shape[1] * 4 || 8 + headerLength + offsets[1] > stat.size) throw new Error('production static embedding tensor is invalid or truncated');
  let vocab; try { vocab = JSON.parse(readFileSync(join(dir, 'tokenizer.json'), 'utf8')).model?.vocab; } catch { throw new Error('production static embedding tokenizer is invalid'); }
  if (!vocab || typeof vocab !== 'object' || Array.isArray(vocab) || !Object.keys(vocab).length || Object.values(vocab).some((id) => !Number.isInteger(id) || id < 0 || id >= shape[0])) throw new Error('production static embedding vocabulary does not fit its tensor');
  return { rows: shape[0], dimensions: shape[1], vocabulary: Object.keys(vocab).length };
}
export function validateProductionCapabilityClosure(root, { platform = process.platform, arch = process.arch } = {}) {
  root = resolve(root);
  const embedding = staticEmbedding(root);
  const registryPath = join(root, 'kingmaker-runtime', 'server', 'node_modules', 'playwright-core', 'browsers.json'); regular(registryPath);
  const browser = JSON.parse(readFileSync(registryPath, 'utf8')).browsers?.find((entry) => entry.name === 'chromium-headless-shell');
  if (!browser || !/^\d+$/.test(String(browser.revision))) throw new Error('production Playwright pinned headless-shell revision is missing');
  const platformDir = platform === 'darwin' ? `chrome-headless-shell-mac-${arch === 'arm64' ? 'arm64' : 'x64'}` : platform === 'win32' ? 'chrome-headless-shell-win64' : `chrome-headless-shell-linux${arch === 'arm64' ? '-arm64' : '64'}`;
  const binary = join(root, 'playwright-browsers', `chromium_headless_shell-${browser.revision}`, platformDir, platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell'); regular(binary, platform !== 'win32');
  const launcher = join(root, 'app.asar', 'desktop', 'headless-server.mjs'); regular(launcher);
  if (!readFileSync(launcher, 'utf8').includes('SOLOMON_STATIC_EMBEDDING_DIR')) throw new Error('production headless launcher does not resolve the packaged static embedding');
  return { embedding, browserRevision: String(browser.revision), browserExecutable: binary, scope: 'dependency-layout-only; build source repairs and prove packaged/installed outcomes separately' };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(validateProductionCapabilityClosure(process.argv[2]), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 2; }
}
