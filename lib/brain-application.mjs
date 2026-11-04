// Optional applications published by the Brain Library. Downloads are immutable release assets, verified before any
// unpack/install step, and live outside Kingmaker's signed bundle so an application can be removed independently.
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const applicationDir = (state, app) => join(state, 'brain-library', 'applications', app.id, app.version);

async function download(url, path, fetchImpl = fetch) {
  const response = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(3_600_000) });
  if (!response.ok || !response.body) throw new Error(`download answered ${response.status}`);
  const hash = createHash('sha256'), out = createWriteStream(path, { mode: 0o600 });
  for await (const chunk of response.body) { hash.update(chunk); if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve)); }
  await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve())));
  return hash.digest('hex');
}

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`);
};

/** Download, verify, unpack and build one reviewed Brain Library application. Safe to rerun. */
export async function installLibraryApplication(app, { state, repo, uv, fetchImpl = fetch, freeGb = null } = {}) {
  if (!app?.id || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(app.id) || !/^[a-f0-9]{64}$/.test(app.sha256 || '')) throw new Error('invalid application record');
  if (!uv || !existsSync(uv)) throw new Error('Kingmaker\'s uv runtime is missing');
  if (freeGb != null && freeGb < app.size / 1e9 * 2 + 2) throw new Error(`${freeGb.toFixed(1)} GB free; ${app.name} needs at least ${(app.size / 1e9 * 2 + 2).toFixed(1)} GB during installation`);
  const dest = applicationDir(state, app);
  if (existsSync(join(dest, '.venv', 'bin', 'python')) && existsSync(join(dest, 'webui.sh'))) return { path: dest, already: true };
  const parent = join(state, 'brain-library', 'applications', app.id); mkdirSync(parent, { recursive: true, mode: 0o700 });
  const archive = join(parent, `${app.asset}.part`), stage = join(parent, `${app.version}.part`);
  rmSync(archive, { force: true }); rmSync(stage, { recursive: true, force: true }); mkdirSync(stage, { recursive: true, mode: 0o700 });
  try {
    const url = `https://github.com/${repo}/releases/download/${app.release}/${app.asset}`;
    const got = await download(url, archive, fetchImpl);
    if (got !== app.sha256) throw new Error(`download SHA-256 ${got} does not match the Brain Library`);
    const listing = spawnSync('/usr/bin/tar', ['-tzf', archive], { encoding: 'utf8' });
    if (listing.status !== 0) throw new Error('application archive is not readable');
    const names = listing.stdout.split('\n').filter(Boolean);
    if (!names.length || names.some((name) => name.startsWith('/') || name.includes('../') || !(name === `${app.root}/` || name.startsWith(`${app.root}/`)))) throw new Error('application archive reaches outside its expected folder');
    run('/usr/bin/tar', ['-xzf', archive, '-C', stage, '--no-same-owner']);
    const root = join(stage, app.root);
    if (!existsSync(join(root, 'uv.lock')) || !existsSync(join(root, 'webui.sh'))) throw new Error('application archive is missing its locked runtime entrypoints');
    run(uv, ['python', 'install', app.python], { cwd: root });
    run(uv, ['sync', '--frozen', '--python', app.python], { cwd: root });
    rmSync(dest, { recursive: true, force: true }); renameSync(root, dest);
    return { path: dest, already: false };
  } finally {
    rmSync(archive, { force: true }); rmSync(stage, { recursive: true, force: true });
  }
}

/** Start the installed local WebUI and wait until its health endpoint answers. */
export async function useLibraryApplication(app, { state, spawnImpl = spawn, fetchImpl = fetch } = {}) {
  const dir = applicationDir(state, app), health = `${app.use.url}/_stcore/health`;
  try { if ((await fetchImpl(health, { signal: AbortSignal.timeout(1500) })).ok) return { url: app.use.url, already: true }; } catch { /* start it */ }
  if (!existsSync(join(dir, '.venv', 'bin', 'python'))) throw new Error(`${app.name} is not installed; pull it first`);
  const log = openSync(join(dir, 'kingmaker-webui.log'), 'a', 0o600);
  const port = new URL(app.use.url).port;
  let child;
  try { child = spawnImpl(app.use.command, app.use.args, { cwd: dir, detached: true, stdio: ['ignore', log, log], env: { ...process.env, BROWSER: 'true', MPT_WEBUI_HOST: '127.0.0.1', MPT_WEBUI_PORT: port } }); }
  finally { closeSync(log); }
  child.unref();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    try { if ((await fetchImpl(health, { signal: AbortSignal.timeout(1000) })).ok) return { url: app.use.url, already: false }; } catch { /* keep waiting */ }
  }
  throw new Error(`${app.name} did not become healthy; see ${join(dir, 'kingmaker-webui.log')}`);
}
