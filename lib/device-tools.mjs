// INSTALL A PROPOSED TOOL — only on the owner's yes, from a pinned version, with its bytes recorded.
//
// Installing third-party code is a supply-chain risk, so this is the artcraft.mjs pattern for a proposal from the
// candidate search (device-candidates.mjs):
//   1. The proposal must name an npm package at an EXACT version (the official MCP registry's own entry). Anything
//      else (a PyPI package, a bare GitHub repo, a hosted server) stays a proposal: it is never built or run here.
//   2. The version's registry record is read: its tarball must come from registry.npmjs.org, its unpacked size must
//      fit (no large downloads on this Mac), and the tarball bytes must match the registry's sha512 integrity before
//      anything is unpacked. Their sha256 is recorded.
//   3. npm installs that tarball into Ghost's own tools folder with --ignore-scripts (no install script ever runs,
//      even with the owner's yes), production dependencies only; the lockfile's sha256 is recorded too.
//   4. The manifest (<tools>/sol-ghost-tools.json) keeps package, version, tarball sha256 + integrity, lockfile
//      sha256, the bin, and when.
//   5. It is registered with the engine's MCP hub as a stdio server (POST /api/mcp/servers, the owner console): that is
//      a RED proposal in the engine, so it runs only after the owner confirms it with its two challenge words. Its tools
//      then start DISABLED until reviewed, as every new MCP tool in the hub does.
// The caller (device-desk.mjs) reads the install back and acts only on the owner's yes.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { ownerCall } from './client.mjs';

export const NPM_REGISTRY = 'https://registry.npmjs.org';
export const MAX_UNPACKED_BYTES = 60 * 1024 * 1024;
export const MAX_TARBALL_BYTES = 25 * 1024 * 1024;
export const TOOLS_MANIFEST = 'sol-ghost-tools.json';
export const TOOLS_MANIFEST_SCHEMA = 'sol-ghost.tools/1';

export const toolsDir = (paths) => join(paths.state, 'tools');

const EXACT = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]{0,213}$/;

/** Pure: can this proposal be installed here, and if not, why. */
export function installPlan(p) {
  if (!p) return { ok: false, reason: 'No such proposal.' };
  if (p.state === 'installed') return { ok: false, reason: `${p.name} is already installed.` };
  if (p.package?.type !== 'npm') {
    const what = p.package?.type === 'pypi' ? 'a PyPI package' : p.package?.type === 'remote' ? `a hosted server at ${p.package.host}` : 'a GitHub repo with no published package';
    return { ok: false, reason: `${p.name} is ${what}. I install only npm packages at a pinned version myself; this one stays a proposal${p.repo ? ` (${p.repo})` : ''}.` };
  }
  if (!NPM_NAME.test(String(p.package.name)) || !EXACT.test(String(p.package.version ?? ''))) return { ok: false, reason: `${p.name} has no exact version to pin.` };
  return { ok: true, pkg: p.package.name, version: p.package.version };
}

/** Pure: the read-back before an install. */
export function installReadBack(p) {
  const plan = installPlan(p);
  if (!plan.ok) return plan.reason;
  const needs = (p.needsEnv ?? []).filter((v) => v.required).map((v) => v.name);
  return `Install ${plan.pkg} ${plan.version} from npm for ${p.app}: ${p.license ?? 'licence not stated'}${p.repo ? `, source ${p.repo}` : ''}${p.flags?.length ? ` (${p.flags.join('; ')})` : ''}. `
    + `It goes into my own tools folder with its install scripts off, its bytes checked against npm's record and their sha256 kept. `
    + `Then I'll add it as an MCP server, which you confirm with two words; its tools start switched off until you review them.`
    + `${needs.length ? ` It needs ${needs.join(', ')} to work.` : ''} Say yes to install it.`;
}

const sha = (algo, bytes, enc = 'hex') => createHash(algo).update(bytes).digest(enc);

/** Pure: does these bytes' sha512 match an npm SRI integrity string? */
export function integrityMatches(bytes, integrity) {
  const m = /^sha512-([A-Za-z0-9+/=]+)$/.exec(String(integrity ?? '').trim().split(/\s+/).find((x) => x.startsWith('sha512-')) ?? '');
  return Boolean(m) && sha('sha512', bytes, 'base64') === m[1];
}

export function readToolsManifest(dir, read = (p) => readFileSync(p, 'utf8')) {
  try {
    const m = JSON.parse(read(join(dir, TOOLS_MANIFEST)));
    return m?.schema === TOOLS_MANIFEST_SCHEMA && m.tools && typeof m.tools === 'object' ? m : { schema: TOOLS_MANIFEST_SCHEMA, tools: {} };
  } catch { return { schema: TOOLS_MANIFEST_SCHEMA, tools: {} }; }
}

function writeToolsManifest(dir, manifest) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, TOOLS_MANIFEST);
  writeFileSync(`${path}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

const runNpm = (npm, args, { cwd, timeoutMs = 300_000 } = {}) => new Promise((done) => {
  // A plain environment: no keys, no nonce. npm only fetches the dependency tarballs; no script runs.
  const env = { PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`, HOME: process.env.HOME ?? '', npm_config_ignore_scripts: 'true', npm_config_fund: 'false', npm_config_audit: 'false', npm_config_update_notifier: 'false' };
  execFile(npm, args, { cwd, env, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => done({ ok: !error, code: error?.code ?? 0, out: String(stderr || stdout || '').slice(-800) }));
});

export function findNpm(exists = existsSync) {
  return ['/opt/homebrew/bin/npm', '/usr/local/bin/npm'].find((p) => exists(p)) ?? null;
}
export function findNode(exists = existsSync) {
  return ['/opt/homebrew/bin/node', '/usr/local/bin/node'].find((p) => exists(p)) ?? (process.versions.electron ? null : process.execPath);
}

/** Pure: a package.json `bin` → the entry for the package (its own name first), relative to the package. */
export function binEntry(pkgJson, name) {
  const bin = pkgJson?.bin;
  if (typeof bin === 'string') return bin;
  if (bin && typeof bin === 'object') {
    const short = String(name).split('/').pop();
    return bin[short] ?? bin[name] ?? Object.values(bin)[0] ?? null;
  }
  return typeof pkgJson?.main === 'string' ? pkgJson.main : null;
}

/**
 * Install one proposal (the caller already has the owner's yes). → { ok, entry?, reason? }.
 * Injectable: fetchImpl, npm (runner), dir, now, write/read for the manifest.
 */
export async function installTool(p, { dir, fetchImpl = fetch, npm = runNpm, npmBin = findNpm(), nodeBin = findNode(), now = () => new Date(), log = () => {} } = {}) {
  const plan = installPlan(p);
  if (!plan.ok) return { ok: false, reason: plan.reason };
  if (!npmBin) return { ok: false, reason: 'npm is not installed (brew install node).' };
  if (!nodeBin) return { ok: false, reason: 'No Node.js binary to run it with (brew install node).' };
  const enc = plan.pkg.startsWith('@') ? `@${encodeURIComponent(plan.pkg.slice(1))}` : encodeURIComponent(plan.pkg);
  let meta;
  try {
    const res = await fetchImpl(`${NPM_REGISTRY}/${enc}/${encodeURIComponent(plan.version)}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return { ok: false, reason: `npm has no ${plan.pkg} ${plan.version} (HTTP ${res.status}).` };
    meta = await res.json();
  } catch (error) { return { ok: false, reason: `npm did not answer: ${String(error?.message ?? error).slice(0, 120)}` }; }
  const tarball = String(meta?.dist?.tarball ?? '');
  if (!tarball.startsWith(`${NPM_REGISTRY}/`)) return { ok: false, reason: 'Its tarball is not on registry.npmjs.org, so it is not installed.' };
  if (!/^sha512-/.test(String(meta?.dist?.integrity ?? ''))) return { ok: false, reason: 'npm gives no sha512 integrity for it, so it is not installed.' };
  if (Number(meta?.dist?.unpackedSize ?? 0) > MAX_UNPACKED_BYTES) return { ok: false, reason: `It unpacks to ${Math.round(meta.dist.unpackedSize / 1048576)} MB, too large for this Mac's tools folder.` };
  if (meta?.deprecated) return { ok: false, reason: `npm marks ${plan.pkg} ${plan.version} deprecated: ${String(meta.deprecated).slice(0, 120)}` };
  let bytes;
  try {
    const res = await fetchImpl(tarball, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) return { ok: false, reason: `The tarball did not download (HTTP ${res.status}).` };
    bytes = Buffer.from(await res.arrayBuffer());
  } catch (error) { return { ok: false, reason: `The tarball did not download: ${String(error?.message ?? error).slice(0, 120)}` }; }
  if (bytes.length > MAX_TARBALL_BYTES) return { ok: false, reason: 'The tarball is too large.' };
  if (!integrityMatches(bytes, meta.dist.integrity)) return { ok: false, reason: 'The tarball does not match npm\'s sha512 for that version, so nothing was unpacked.' };
  const tarSha256 = sha('sha256', bytes);
  const toolDir = join(dir, p.id);
  rmSync(toolDir, { recursive: true, force: true });
  mkdirSync(toolDir, { recursive: true, mode: 0o700 });
  const tgz = `${p.id}-${plan.version}.tgz`;
  writeFileSync(join(toolDir, tgz), bytes, { mode: 0o600 });
  writeFileSync(join(toolDir, 'package.json'), `${JSON.stringify({ name: `sol-ghost-tool-${p.id}`, private: true, dependencies: { [plan.pkg]: `file:./${tgz}` } }, null, 2)}\n`, { mode: 0o600 });
  log('device_tool_install', { id: p.id, pkg: plan.pkg, version: plan.version, tarSha256 });
  const r = await npm(npmBin, ['install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', '--no-update-notifier'], { cwd: toolDir });
  if (!r.ok) { rmSync(toolDir, { recursive: true, force: true }); return { ok: false, reason: `npm install failed: ${r.out.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 200)}` }; }
  let pkgJson = null;
  try { pkgJson = JSON.parse(readFileSync(join(toolDir, 'node_modules', plan.pkg, 'package.json'), 'utf8')); } catch { /* checked below */ }
  const rel = binEntry(pkgJson, plan.pkg);
  const binPath = rel ? resolve(join(toolDir, 'node_modules', plan.pkg), rel) : null;
  if (!binPath || relative(toolDir, binPath).startsWith('..') || isAbsolute(relative(toolDir, binPath)) || !existsSync(binPath)) {
    rmSync(toolDir, { recursive: true, force: true });
    return { ok: false, reason: `${plan.pkg} has no runnable entry point.` };
  }
  let lockSha256 = null;
  try { lockSha256 = sha('sha256', readFileSync(join(toolDir, 'package-lock.json'))); } catch { /* npm without a lockfile */ }
  const entry = {
    id: p.id, app: p.app, package: plan.pkg, version: plan.version, integrity: meta.dist.integrity, tarballSha256: tarSha256, lockSha256,
    bin: binPath, node: nodeBin, repo: p.repo ?? null, license: p.license ?? null, installedAt: now().toISOString(), registered: null,
  };
  const manifest = readToolsManifest(dir);
  manifest.tools[p.id] = entry;
  writeToolsManifest(dir, manifest);
  return { ok: true, entry };
}

/**
 * Ask the engine's MCP hub to add the installed tool (owner console, the launch nonce). The hub answers with a RED
 * proposal the owner confirms with its two challenge words. → { ok, proposal?, reason? }.
 */
export async function registerTool({ port, nonce, entry, dir, fetchImpl }) {
  const r = await ownerCall(port, '/api/mcp/servers', {
    nonce, method: 'POST', timeoutMs: 30_000, ...(fetchImpl ? { fetchImpl } : {}),
    body: { transport: 'stdio', label: `${entry.package} (${entry.app})`.slice(0, 80), command: entry.node, args: [entry.bin], env: {} },
  }).catch((error) => ({ ok: false, status: 0, json: { error: String(error?.message ?? error) } }));
  const proposal = r.json?.decision?.proposal ?? null;
  if (dir) {
    const manifest = readToolsManifest(dir);
    if (manifest.tools[entry.id]) { manifest.tools[entry.id].registered = proposal ? { proposalId: proposal.proposalId, at: new Date().toISOString() } : null; writeToolsManifest(dir, manifest); }
  }
  if (r.status === 202 && proposal) return { ok: true, proposal };
  return { ok: false, reason: r.json?.decision?.spoken ?? r.json?.message ?? r.json?.error ?? `HTTP ${r.status}` };
}

// OUTSIDE CODE IS NEVER RUN AS-IS (operator doctrine, 2026-10-08: "my governance forces sandboxing of any external code
// to be reverse engineered, not just used"). A proposed tool is handed to the engine's capability-acquisition loop, which
// stages it in quarantine, studies it and builds Kingmaker's own CLI/MCP for the app; nothing from it runs on the Mac
// until the owner approves what comes out. installTool/registerTool above are no longer reached from the desk.

/** Pure: the read-back before a hand-off. */
export function acquisitionReadBack(p) {
  const what = [p.license ?? 'licence not stated', p.repo ?? null, p.package?.type === 'npm' ? `npm ${p.package.name}@${p.package.version}` : null].filter(Boolean).join(', ');
  return `${p.name} for ${p.app} (${what}): I don't run outside code as-is. Say yes and it goes to Kingmaker's acquisition loop, studied in quarantine and rebuilt as our own ${p.app} tool; nothing from it runs on your Mac until you approve what comes out.`;
}

/** Hand a proposal to the engine's acquisition loop as a capability gap (the neutral label only). */
export async function handOffToAcquisition({ port, nonce, proposal, fetchImpl }) {
  const r = await ownerCall(port, '/api/capability-acquisition/gaps/signal', {
    nonce, method: 'POST', timeoutMs: 15_000, ...(fetchImpl ? { fetchImpl } : {}),
    body: { capability: `${proposal.app} control (CLI or MCP)`.slice(0, 120), surface: 'kingmaker-device-scan' },
  }).catch((error) => ({ ok: false, status: 0, json: { error: String(error?.message ?? error) } }));
  if (r.status >= 200 && r.status < 300) return { ok: true };
  return { ok: false, reason: r.json?.error ?? r.json?.message ?? `HTTP ${r.status}` };
}

