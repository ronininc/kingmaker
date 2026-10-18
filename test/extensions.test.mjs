// Kingmaker's extension directory (lib/extensions.mjs): the catalog, verified bundles unpacked safely, launch with
// Kingmaker's own runtimes, keys handed to the engine's hub (sealed there) and several accounts per service.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { crc32 } from 'node:zlib';
import { accountConnectorName, extensionView, installExtension, launchFor, loadCatalog, readAccounts, readZip, sha256, unpackBundle } from '../lib/extensions.mjs';

/** A minimal stored (uncompressed) zip, so hostile names can be built on purpose. */
function zip(files) {
  const locals = [], centrals = []; let off = 0;
  for (const [name, text] of files) {
    const data = Buffer.from(text), n = Buffer.from(name), crc = crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, n, data); centrals.push(ch, n); off += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}
const manifest = { manifest_version: '0.4', name: 'Demo', version: '1.0.0', server: { type: 'uv', entry_point: 'demo/__init__.py', mcp_config: { command: 'uv', args: ['run', 'demo-mcp'] } } };
const bundle = zip([['manifest.json', JSON.stringify(manifest)], ['demo/__init__.py', 'print("hi")\n'], ['pyproject.toml', '[project]\nname="demo"\n']]);
const demoCatalog = (buf) => [
  { id: 'demo', name: 'Demo', version: '1.0.0', install: { type: 'mcpb', url: 'https://example.org/demo.mcpb', sha256: sha256(buf) }, requires: [{ kind: 'app', name: 'Blender', minVersion: '5.1' }] },
  { id: 'cf', name: 'Cloudflare', install: { type: 'remote', url: 'https://mcp.cloudflare.com/mcp', auth: 'bearer' }, keys: [{ id: 'cloudflare', label: 'Cloudflare API token', getUrl: 'https://dash.cloudflare.com/profile/api-tokens', multi: true }] },
];
const fetchOf = (buf) => async () => new Response(buf, { status: 200, headers: { 'content-length': String(buf.length) } });
const runtimes = { uv: '/K/bin/uv', node: '/K/MacOS/Solomon' };

test('the directory: real, checked entries only (Blender, Cloudflare, GitHub, Postiz), as the bar shows them', () => {
  const c = loadCatalog();
  assert.deepEqual(c.map((e) => e.id).sort(), ['blender', 'cloudflare', 'github', 'postiz']);
  const blender = c.find((e) => e.id === 'blender');
  assert.match(blender.install.sha256, /^[a-f0-9]{64}$/);
  const v = extensionView(blender, { installed: ['blender'] });
  assert.equal(v.verified, true); assert.equal(v.installed, true); assert.match(v.warning, /without guards/);
  assert.equal(v.requires[0].addon.url.endsWith('mcp-1.0.3.zip'), true);
  for (const id of ['cloudflare', 'github', 'postiz']) {
    const k = extensionView(c.find((e) => e.id === id)).keys[0];
    assert.match(k.getUrl, /^https:\/\//, `${id} links straight to where its key is made`); assert.equal(k.multi, true);
  }
});

test('a bundle is unpacked only inside its folder: zip-slip, absolute paths and links are refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ext-'));
  assert.equal(unpackBundle(bundle, join(dir, 'ok')), 3);
  assert.equal(JSON.parse(readFileSync(join(dir, 'ok', 'manifest.json'), 'utf8')).name, 'Demo');
  assert.throws(() => unpackBundle(zip([['../../evil.sh', 'x']]), join(dir, 'a')), /outside its folder/);
  assert.throws(() => unpackBundle(zip([['/etc/evil', 'x']]), join(dir, 'b')), /outside its folder/);
  assert.equal(existsSync(join(dir, 'evil.sh')), false);
  assert.throws(() => readZip(Buffer.from('not a zip at all, not even close')), /not a zip/);
});

test('launch: uv bundles run with Kingmaker\'s own uv inside their folder; unknown runtimes are refused', () => {
  assert.deepEqual(launchFor(manifest, '/S/ext/demo', runtimes), { command: '/K/bin/uv', args: ['--directory', '/S/ext/demo', 'run', 'demo-mcp'], env: { UV_PYTHON_PREFERENCE: 'only-managed' } });
  const node = launchFor({ server: { type: 'node', mcp_config: { command: 'node', args: ['${__dirname}/server/index.js'] } } }, '/S/x', runtimes);
  assert.deepEqual(node.args, ['/S/x/server/index.js']); assert.equal(node.env.ELECTRON_RUN_AS_NODE, '1');
  assert.match(launchFor({ server: { mcp_config: { command: 'bash', args: ['-c', 'curl … | sh'] } } }, '/S/x', runtimes).error, /doesn't run/);
  assert.match(launchFor(manifest, '/S/x', { uv: null }).error, /ship inside Kingmaker/);
  const withUserConfig = launchFor({ server: { type: 'uv', mcp_config: { command: 'uv', args: ['run', 'x'], env: { API_KEY: '${user_config.api_key}', MODE: 'fast' } } } }, '/S/x', runtimes);
  assert.equal('API_KEY' in withUserConfig.env, false, 'an unfilled user_config secret is never passed as text'); assert.equal(withUserConfig.env.MODE, 'fast');
});

test('install a bundle: verified, unpacked, connected through REA and the engine; a tampered download is refused', async () => {
  const state = mkdtempSync(join(tmpdir(), 'ext-state-')), added = [], stages = [];
  const r = await installExtension('demo', { state, catalog: demoCatalog(bundle), fetchImpl: fetchOf(bundle), runtimes, progress: (s) => stages.push(s),
    addConnector: async (spec) => { added.push(spec); return { ok: true, connector: { name: spec.name } }; } });
  assert.equal(r.ok, true); assert.deepEqual(r.needs.app.map((a) => a.name), ['Blender']);
  assert.deepEqual(stages, ['download', 'verify', 'unpack', 'connect', 'done']);
  assert.equal(added[0].command, '/K/bin/uv'); assert.ok(existsSync(join(state, 'extensions', 'demo', '1.0.0', 'manifest.json')));
  const tampered = Buffer.concat([bundle, Buffer.from(' ')]);
  const bad = await installExtension('demo', { state, catalog: demoCatalog(bundle), fetchImpl: fetchOf(tampered), runtimes, addConnector: async () => ({ ok: true }) });
  assert.equal(bad.ok, false); assert.match(bad.error, /doesn't match the file its maker published/);
});

test('a remote extension with a key: asks for it (with its page), hands it to the hub as a header, never stores it; several accounts', async () => {
  const state = mkdtempSync(join(tmpdir(), 'ext-state-')), seen = [];
  const add = async (spec, opts) => { seen.push({ spec, opts }); return { ok: true, connector: { name: spec.name } }; };
  const ask = await installExtension('cf', { state, catalog: demoCatalog(bundle), addConnector: add });
  assert.equal(ask.ok, false); assert.equal(ask.needs.key.getUrl, 'https://dash.cloudflare.com/profile/api-tokens');
  const token = 'cf_' + 'a'.repeat(37);
  assert.equal((await installExtension('cf', { state, catalog: demoCatalog(bundle), addConnector: add, secret: token, account: 'Work' })).ok, true);
  assert.equal((await installExtension('cf', { state, catalog: demoCatalog(bundle), addConnector: add, secret: 'cf_' + 'b'.repeat(37), account: 'Personal' })).ok, true);
  assert.deepEqual(seen.map((x) => x.spec.name), ['cf-work', 'cf-personal']);
  assert.equal(seen[0].opts.headers.Authorization, `Bearer ${token}`, 'the key goes to the hub, which seals it');
  assert.equal(JSON.stringify(seen[0].spec).includes(token), false, 'the key is never part of what is saved');
  assert.deepEqual(readAccounts(state).cf.map((a) => a.name), ['Work', 'Personal']);
  assert.equal(JSON.stringify(readAccounts(state)).includes('aaaa'), false, 'account names only, never keys');
  assert.equal(accountConnectorName('cf', 'default'), 'cf');
  assert.match((await installExtension('cf', { state, catalog: demoCatalog(bundle), addConnector: add, secret: 'has a space in it' })).error, /doesn't look like/);
});
