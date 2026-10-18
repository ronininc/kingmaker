// lib/extensions.mjs — Kingmaker's extension directory: one-click MCP extensions, in Kingmaker's own UI (owner 2026-10-15:
// "i need kingmaker to be able to do this too … with his ui of course … not just blender it should source the link page
// for easy api and token keys when needed for stuff like cloudflare or multiple social media accounts … which should open
// alongside kingmaker with a button to swap windows … it should store all secrets in its pre auto configured vault").
//   • The directory is catalog/extensions.json: each entry checked by hand against its maker's page; a bundle carries its
//     sha256, and a download that doesn't match is refused.
//   • Install kinds: "mcpb" (an MCP Bundle: a zip with manifest.json, unpacked safely and run with Kingmaker's own uv or
//     node) and "remote" (the maker's hosted MCP server, reached through the engine's MCP hub with a key from the vault).
//   • Keys: each names the page where it is made. Kingmaker opens that page beside the bar (lib/side-by-side.mjs); the
//     bar's hidden key box hands the key, in memory only, to the engine's MCP hub, which seals it into the vault the moment
//     the server is registered (one sealed entry per server). Kingmaker never writes a key anywhere. "multi" keys hold
//     several named accounts ("Cloudflare — work", "Cloudflare — personal"): each account is its own registration.
//   • Everything installed goes through REA (lib/rea.mjs) like any connector, and through the engine's MCP hub, whose tools turn
//     on only when the owner approves them. A maker's own warning is shown before Install.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, normalize, resolve, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';

export const CATALOG_PATH = new URL('../catalog/extensions.json', import.meta.url);
export const MAX_BUNDLE_BYTES = 200 * 1024 * 1024;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const clip = (v, n) => String(v ?? '').trim().slice(0, n);

/** The directory: entries with the fields the bar shows. Bad entries are dropped, never half-shown. */
export function loadCatalog(path = CATALOG_PATH) {
  let j; try { j = JSON.parse(readFileSync(path, 'utf8')); } catch { return []; }
  return (Array.isArray(j?.extensions) ? j.extensions : []).filter((e) => ID_RE.test(e?.id || '') && e.name && e.install
    && ((e.install.type === 'mcpb' && /^https:\/\//.test(e.install.url) && /^[a-f0-9]{64}$/.test(e.install.sha256 || ''))
      || (e.install.type === 'remote' && /^https:\/\//.test(e.install.url))));
}

/** What the bar's directory and detail page show (no install internals beyond the kind). */
export function extensionView(e, { installed = [], accounts = {} } = {}) {
  return {
    id: e.id, name: e.name, maker: e.maker, makerUrl: e.makerUrl || null, verified: e.verified === true, summary: e.summary || '',
    description: e.description || '', version: e.version || '', added: e.added || '', homepage: e.homepage || null,
    support: e.support || null, privacy: e.privacy || null, kind: e.install.type, warning: e.warning || null,
    requires: (e.requires || []).map((r) => ({ name: r.name, minVersion: r.minVersion || null, getUrl: r.getUrl || null, addon: r.addon ? { name: r.addon.name, url: r.addon.url, steps: r.addon.steps } : null })),
    keys: (e.keys || []).map((k) => ({ id: k.id, label: k.label, getUrl: k.getUrl, help: k.help || '', multi: k.multi === true, accounts: accounts[k.id] || [] })),
    installed: installed.includes(e.id),
  };
}

// ── the bundle: download, verify, unpack safely ────────────────────────────────────────────────────────
/** Pure: the hex sha256 of a buffer. */
export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Pure: the entries of a zip (central directory), each with its name and a way to read it. Throws on anything odd. */
export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip');
  const count = buf.readUInt16LE(eocd + 10), cdOff = buf.readUInt32LE(eocd + 16);
  const out = [];
  let p = cdOff;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip directory');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), lho = buf.readUInt32LE(p + 42);
    const extAttr = buf.readUInt32LE(p + 38);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    out.push({ name, method, csize, usize, lho, symlink: ((extAttr >>> 16) & 0o170000) === 0o120000,
      read() {
        const lnl = buf.readUInt16LE(lho + 26), lxl = buf.readUInt16LE(lho + 28), start = lho + 30 + lnl + lxl;
        const raw = buf.subarray(start, start + csize);
        const data = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw) : (() => { throw new Error(`zip method ${method}`); })();
        if (data.length !== usize) throw new Error('zip size mismatch');
        return data;
      } });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

/** Unpack a bundle into `dir`, refusing anything that would land outside it (zip-slip), links, or an oversize total. */
export function unpackBundle(buf, dir, { maxTotal = 4 * MAX_BUNDLE_BYTES } = {}) {
  const root = resolve(dir) + sep;
  let total = 0;
  const entries = readZip(buf);
  for (const e of entries) {
    if (e.symlink) throw new Error(`the bundle has a link (${clip(e.name, 80)}): refused`);
    const target = resolve(dir, normalize(e.name));
    if (!(target + (e.name.endsWith('/') ? sep : '')).startsWith(root) || e.name.startsWith('/') || e.name.includes('..')) throw new Error(`the bundle reaches outside its folder (${clip(e.name, 80)}): refused`);
    total += e.usize; if (total > maxTotal) throw new Error('the bundle unpacks too large: refused');
  }
  for (const e of entries) {
    const target = resolve(dir, normalize(e.name));
    if (e.name.endsWith('/')) { mkdirSync(target, { recursive: true }); continue; }
    mkdirSync(resolve(target, '..'), { recursive: true });
    writeFileSync(target, e.read(), { mode: 0o644 });
  }
  return entries.length;
}

/** Pure: a bundle manifest → how to launch it with Kingmaker's own runtimes, or an error. Only stdio servers. */
export function launchFor(manifest, dir, runtimes) {
  const m = manifest?.server?.mcp_config, type = manifest?.server?.type;
  if (!m?.command) return { error: 'the bundle names no command to run' };
  const sub = (s) => String(s).replace(/\$\{__dirname\}/g, dir);
  const args = (Array.isArray(m.args) ? m.args : []).map(sub);
  const env = Object.fromEntries(Object.entries(m.env || {}).filter(([, v]) => !/\$\{user_config\./.test(String(v))).map(([k, v]) => [k, sub(v)]));
  const cmd = String(m.command);
  if (cmd === 'uv' || type === 'uv') {
    if (!runtimes.uv) return { error: 'this bundle runs on uv, which should ship inside Kingmaker' };
    // `uv run` inside the bundle's own folder (its pyproject.toml), with a Python uv fetches and keeps for Kingmaker.
    const rest = cmd === 'uv' ? args : [cmd, ...args];
    return { command: runtimes.uv, args: ['--directory', dir, ...rest], env: { ...env, UV_PYTHON_PREFERENCE: 'only-managed' } };
  }
  if (cmd === 'node' || type === 'node') {
    if (!runtimes.node) return { error: 'this bundle runs on Node, which should ship inside Kingmaker' };
    return { command: runtimes.node, args: cmd === 'node' ? args : [cmd, ...args], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } };
  }
  if (cmd === 'python' || cmd === 'python3' || type === 'python') {
    if (!runtimes.uv) return { error: 'this bundle runs on Python, which Kingmaker runs through uv' };
    return { command: runtimes.uv, args: ['--directory', dir, 'run', 'python', ...args], env: { ...env, UV_PYTHON_PREFERENCE: 'only-managed' } };
  }
  return { error: `the bundle wants "${clip(cmd, 40)}", which Kingmaker doesn't run` };
}

/** Kingmaker's own runtimes: inside the app first (a stock Mac has no Homebrew), a developer's copy only as a fallback. */
export function runtimesFor({ appRoot = '/Applications/Kingmaker.app', env = process.env, exists = existsSync } = {}) {
  const pick = (...c) => c.find((p) => p && exists(p)) || null;
  return {
    uv: pick(env.KINGMAKER_UV, join(appRoot, 'Contents', 'Resources', 'bin', 'uv'), '/opt/homebrew/bin/uv', '/usr/local/bin/uv'),
    node: pick(env.KINGMAKER_NODE, join(appRoot, 'Contents', 'MacOS', 'Solomon'), process.execPath),
  };
}

// ── accounts: several named keys per service, each its own connector ───────────────────────────────────
/** Pure: the connector name for one account of one extension ("cloudflare" + "Work" → "cloudflare-work"). */
export function accountConnectorName(extId, account = 'default') {
  const a = clip(account, 40).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'default';
  return a === 'default' ? extId : `${extId}-${a}`;
}
const accountsPath = (state) => join(state, 'extensions', 'accounts.json');
/** The named accounts per extension (names only: the keys themselves live only in the vault, sealed by the engine's hub). */
export function readAccounts(state) { try { return JSON.parse(readFileSync(accountsPath(state), 'utf8')); } catch { return {}; } }
export function addAccount(state, extId, account) {
  const all = readAccounts(state), name = clip(account, 40) || 'default';
  const list = all[extId] || [];
  if (!list.some((a) => a.name.toLowerCase() === name.toLowerCase())) list.push({ name, connector: accountConnectorName(extId, name), added: new Date().toISOString() });
  all[extId] = list;
  mkdirSync(join(state, 'extensions'), { recursive: true, mode: 0o700 });
  writeFileSync(accountsPath(state) + '.tmp', JSON.stringify(all, null, 1), { mode: 0o600 }); renameSync(accountsPath(state) + '.tmp', accountsPath(state));
  return list.find((a) => a.name.toLowerCase() === name.toLowerCase());
}

// ── install ────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Install one extension. deps: { state, fetchImpl, addConnector(spec, {headers}), runtimes, progress(stage, pct, line) }.
 * A remote server with a key takes `secret` (from the bar's hidden key box, in memory only) and an `account` name; the
 * header goes to the engine's MCP hub, which seals it into the vault. → { ok, connector?, needs?: {key|app}, error? }
 */
export async function installExtension(id, { state, fetchImpl = fetch, addConnector, runtimes = runtimesFor(), progress = () => {}, account = null, secret = null, catalog = loadCatalog() }) {
  const e = catalog.find((x) => x.id === id);
  if (!e) return { ok: false, error: `No extension called ${clip(id, 40)} in Kingmaker's directory.` };
  if (e.install.type === 'remote') {
    const key = (e.keys || [])[0];
    const name = clip(account, 40) || 'default';
    let headers = null;
    if (key) {
      const s = String(secret ?? '').trim();
      if (!s) return { ok: false, needs: { key: { id: key.id, label: key.label, getUrl: key.getUrl, help: key.help, multi: key.multi === true } }, error: `${e.name} needs your ${key.label}.` };
      if (/\s/.test(s) || s.length < 8 || s.length > 4096) return { ok: false, error: `That doesn't look like a ${key.label}.` };
      headers = { Authorization: (e.install.auth || 'bearer') === 'raw' ? s : `Bearer ${s}` };
    }
    progress('connect', 60, `Connecting ${e.name}${name !== 'default' ? ` (${name})` : ''}…`);
    const r = await addConnector({ kind: 'mcp', name: accountConnectorName(e.id, name), url: e.install.url, extension: e.id }, { headers });
    if (r.ok && key) addAccount(state, e.id, name);
    progress(r.ok ? 'done' : 'failed', 100, r.ok ? `${e.name}${name !== 'default' ? ` (${name})` : ''} is connected. Its key is sealed in Kingmaker's vault.` : r.error);
    return r;
  }
  // mcpb: download → verify → unpack → read manifest → launch with Kingmaker's runtimes → REA + the engine's hub.
  progress('download', 5, `Downloading ${e.name} ${e.version}…`);
  const res = await fetchImpl(e.install.url, { signal: AbortSignal.timeout(10 * 60_000) });
  if (!res.ok) return { ok: false, error: `The download failed (${res.status}).` };
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_BUNDLE_BYTES) return { ok: false, error: 'The bundle is too large.' };
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BUNDLE_BYTES) return { ok: false, error: 'The bundle is too large.' };
  progress('verify', 40, 'Checking it is exactly the file its maker published…');
  if (sha256(buf) !== e.install.sha256) return { ok: false, error: `${e.name}'s download doesn't match the file its maker published: not installed.` };
  const dir = join(state, 'extensions', e.id, e.version), tmp = `${dir}.part`;
  rmSync(tmp, { recursive: true, force: true }); mkdirSync(tmp, { recursive: true, mode: 0o700 });
  progress('unpack', 55, 'Unpacking…');
  try { unpackBundle(buf, tmp); } catch (err) { rmSync(tmp, { recursive: true, force: true }); return { ok: false, error: String(err.message) }; }
  let manifest; try { manifest = JSON.parse(readFileSync(join(tmp, 'manifest.json'), 'utf8')); } catch { rmSync(tmp, { recursive: true, force: true }); return { ok: false, error: 'The bundle has no readable manifest.' }; }
  rmSync(dir, { recursive: true, force: true }); renameSync(tmp, dir);
  const launch = launchFor(manifest, dir, runtimes);
  if (launch.error) return { ok: false, error: `${e.name}: ${launch.error}.` };
  progress('connect', 75, 'Reading it (REA) and connecting it through Kingmaker…');
  const r = await addConnector({ kind: 'mcp', name: e.id, command: launch.command, args: launch.args, env: launch.env, path: dir, extension: e.id });
  const needs = (e.requires || []).filter((q) => q.kind === 'app');
  progress(r.ok ? 'done' : 'failed', 100, r.ok ? `${e.name} is installed.${needs.length ? ` It needs ${needs.map((q) => `${q.name}${q.minVersion ? ` ${q.minVersion}+` : ''}`).join(', ')} with its add-on to do anything.` : ''}` : r.error);
  return needs.length && r.ok ? { ...r, needs: { app: needs } } : r;
}
