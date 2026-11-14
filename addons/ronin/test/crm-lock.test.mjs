// One Kingmaker, one company: the owner's install (profile ronininc) links only to the Ronin CRM.
import './_bind.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeCrmLock, crmLockChangeBlocked, isLockedCrmUrl, isOtherTenantApp, CRM_LOCKS } from '../crm-lock.mjs';

test('every lock-state writer can refuse a live daemon using recorded process evidence', () => {
  const paths = { state: '/state' };
  assert.equal(crmLockChangeBlocked(paths, { readDaemonState: () => ({ pid: 4242 }), pidAlive: (pid) => pid === 4242 }), true);
  assert.equal(crmLockChangeBlocked(paths, { readDaemonState: () => ({ pid: 4242 }), pidAlive: () => false }), false);
  assert.equal(crmLockChangeBlocked(paths, { readDaemonState: () => null, pidAlive: () => true }), false);
});

test('a Ronin office desk or an explicit lock binds the install to Ronin; anything else keeps the no-CRM default', async () => {
  const files = (map) => (p) => { const k = Object.keys(map).find((f) => p.endsWith(f)); if (!k) throw new Error('ENOENT'); return JSON.stringify(map[k]); };
  const paths = { state: '/s' };
  assert.equal(activeCrmLock(paths, files({ 'ronin-desk.json': { schema: 1, crm: 'ronininc', enabled: true } }))?.url, 'https://www.ronininc.org');
  assert.equal(activeCrmLock(paths, files({ 'crm-lock.json': { schema: 1, tenant: 'ronininc' } }))?.url, 'https://www.ronininc.org');
  assert.equal(activeCrmLock(paths, files({ 'ronin-desk.json': { schema: 1, crm: 'ronininc', enabled: false } })), null);
  assert.equal(activeCrmLock(paths, files({ 'crm-lock.json': { schema: 1, tenant: 'orosolu' } })), null, 'this build binds no other company');
  assert.equal(activeCrmLock(paths, files({})), null);
  const { setCrmLock } = await import('../crm-lock.mjs');
  const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const real = { state: mkdtempSync(join(tmpdir(), 'km-lock-')) };
  assert.throws(() => setCrmLock(real, 'orosolu'), /unknown CRM/);
  setCrmLock(real, 'ronininc');
  assert.equal(activeCrmLock(real)?.tenant, 'ronininc');
});

test('only https on Ronin\'s own hosts counts as the locked CRM', () => {
  const lock = CRM_LOCKS.ronininc;
  for (const ok of ['https://www.ronininc.org', 'https://ronininc.org/mcp/solomon', 'https://WWW.RONININC.ORG/api']) assert.equal(isLockedCrmUrl(ok, lock), true, ok);
  for (const bad of ['http://www.ronininc.org', 'https://orosolu.com', 'https://crm.orosolu.com', 'https://www.ronininc.org.evil.example', 'https://evil.example/?u=ronininc.org', 'not a url', '']) assert.equal(isLockedCrmUrl(bad, lock), false, bad);
});

test('the backend binds env CRM transport to the exact locked tenant and host; unlocked installs keep overrides', async () => {
  const { ghostBackendEnv } = await import('../../../lib/profile.mjs');
  const paths = { runtimeHome: '/r', state: '/s', userData: '/u', logs: '/l', resources: '/res', voice: { wakePhraseFile: '/w' } };
  const args = { paths, port: 3001, secrets: { nonce: 'n', voiceKey: 'v' }, ghostBin: null };
  const foreign = { RONIN_CRM_MCP_TOKEN: 'tok', RONIN_CRM_MCP_URL: 'https://crm.orosolu.com/mcp', SOLOMON_HOME_CRM_URL: 'https://orosolu.com', SOLOMON_CRM_MCP_CONFIG: '{"serverUrl":"https://crm.orosolu.com/mcp","headers":{"Authorization":"Bearer foreign"}}' };
  const locked = ghostBackendEnv({ ...args, env: foreign, crmLock: CRM_LOCKS.ronininc, addon: roninAddon });
  assert.equal(locked.RONIN_CRM_MCP_TOKEN, 'tok');
  assert.equal(locked.RONIN_CRM_MCP_URL, 'https://www.ronininc.org/mcp/solomon');
  assert.equal(locked.SOLOMON_HOME_CRM_URL, 'https://www.ronininc.org');
  assert.deepEqual([locked.SOLOMON_CRM_LOCK_TENANT, locked.SOLOMON_CRM_LOCK_HOSTS], ['ronininc', 'www.ronininc.org,ronininc.org']);
  assert.equal(locked.SOLOMON_CRM_MCP_CONFIG, undefined, 'the independent generic CRM lane is removed while locked');
  const unlocked = ghostBackendEnv({ ...args, env: {
    ...foreign,
    SOLOMON_CRM_LOCK_TENANT: 'ronininc',
    SOLOMON_CRM_LOCK_HOSTS: 'www.ronininc.org,ronininc.org',
    SOLOMON_CRM_LOCK_MCP_URL: 'https://www.ronininc.org/mcp/solomon',
  }, crmLock: null });
  assert.equal(unlocked.RONIN_CRM_MCP_URL, foreign.RONIN_CRM_MCP_URL);
  assert.equal(unlocked.RONIN_CRM_MCP_TOKEN, foreign.RONIN_CRM_MCP_TOKEN);
  assert.equal(unlocked.SOLOMON_CRM_MCP_CONFIG, foreign.SOLOMON_CRM_MCP_CONFIG);
  assert.equal(unlocked.SOLOMON_CRM_LOCK_TENANT, undefined);
  assert.equal(unlocked.SOLOMON_CRM_LOCK_HOSTS, undefined);
  assert.equal(unlocked.SOLOMON_CRM_LOCK_MCP_URL, undefined);
});

test('the other company\'s apps are recognised by name, bundle id or path', () => {
  assert.equal(isOtherTenantApp({ name: 'Orosolu', bundleId: 'com.google.Chrome.app.abpokgnkiekpdkijoeicmnfbegnkmeck', path: '~/Applications/Chrome Apps.localized/Orosolu.app' }), true);
  assert.equal(isOtherTenantApp({ name: 'Oro Solu CRM' }), true);
  assert.equal(isOtherTenantApp({ name: 'Spotify', bundleId: 'com.spotify.client', path: '/Applications/Spotify.app' }), false);
});

test('a device map written before the lock removes the other company from every cached action surface', async () => {
  const { readDeviceMap, MAP_SCHEMA } = await import('../../../lib/device-scan.mjs');
  const oro = { name: 'Orosolu', bundleId: 'com.google.Chrome.app.abpokgnkiekpdkijoeicmnfbegnkmeck', path: '~/Applications/Chrome Apps.localized/Orosolu.app' };
  // This is the exact partially-sanitized state PR #56 can leave: the foreign app is already gone,
  // while its real string gap ID and independent proposal/search caches remain.
  const stored = JSON.stringify({ schema: MAP_SCHEMA, apps: [{ name: 'Spotify', bundleId: 'com.spotify.client' }],
    gaps: [oro.bundleId, 'com.spotify.client'],
    proposals: [{ id: 'oro-proposal', app: 'Orosolu', bundleId: oro.bundleId, state: 'proposed' }, { id: 'spotify-proposal', app: 'Spotify', bundleId: 'com.spotify.client', state: 'proposed' }],
    candidates: { searched: { [oro.bundleId]: { at: '2026-10-13T00:00:00Z' }, Orosolu: { at: '2026-10-13T00:00:00Z' }, Spotify: { at: '2026-10-13T00:00:00Z' } }, lastRun: { searched: 2 } } });
  const m = readDeviceMap('/x', () => stored, CRM_LOCKS.ronininc);
  assert.deepEqual(m.apps.map((a) => a.name), ['Spotify']);
  assert.deepEqual(m.gaps, ['com.spotify.client']);
  assert.deepEqual(m.proposals.map((p) => p.id), ['spotify-proposal']);
  assert.deepEqual(Object.keys(m.candidates.searched), ['Spotify']);
  assert.equal(m.candidates.lastRun, undefined);

  // An entirely unsanitized older map may have no proposal tying the opaque Chrome bundle ID back
  // to its app. The app itself must provide that identity before it is filtered out.
  const unsanitized = JSON.stringify({ schema: MAP_SCHEMA, apps: [oro, { name: 'Spotify', bundleId: 'com.spotify.client' }],
    gaps: [oro.bundleId, 'com.spotify.client'], proposals: [],
    candidates: { searched: { [oro.bundleId]: { at: '2026-10-13T00:00:00Z' }, Spotify: { at: '2026-10-13T00:00:00Z' } } } });
  const old = readDeviceMap('/x', () => unsanitized, CRM_LOCKS.ronininc);
  assert.deepEqual(old.apps.map((a) => a.name), ['Spotify']);
  assert.deepEqual(old.gaps, ['com.spotify.client']);
  assert.deepEqual(Object.keys(old.candidates.searched), ['Spotify']);
});


// ── moved from the core tests with the add-on (2026-10-16): the engine environment and the device scan on a locked install
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ghostBackendEnv } from '../../../lib/profile.mjs';
import { scanApps } from '../../../lib/device-scan.mjs';
import * as roninAddon from '../index.mjs';
import { exposeAddon } from '../../../lib/addons.mjs';

exposeAddon('ronin', roninAddon);   // as register(host) does, so the core's device scan sees the lock rules

const paths = { runtimeHome: '/Users/owner/Library/Application Support/sol-ghost/runtime', state: '/Users/owner/Library/Application Support/sol-ghost', userData: '/u', logs: '/l', resources: '/r', voice: { wakePhraseFile: '/w' } };
function fixtureHome() {
  const home = mkdtempSync(join(tmpdir(), 'ghost-scan-'));
  return home;
}
const xmlPlist = (dict) => `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n${Object.entries(dict).map(([k, v]) => (v === true ? `<key>${k}</key><true/>` : Array.isArray(v) ? `<key>CFBundleURLTypes</key><array><dict><key>CFBundleURLSchemes</key><array>${v.map((x) => `<string>${x}</string>`).join('')}</array></dict></array>` : `<key>${k}</key><string>${v}</string>`)).join('\n')}\n</dict></plist>\n`;
function makeApp(root, name, dict, { sdef = false, bins = [], macos = [] } = {}) {
  const app = join(root, `${name}.app`);
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
  mkdirSync(join(app, 'Contents', 'Resources'), { recursive: true });
  writeFileSync(join(app, 'Contents', 'Info.plist'), xmlPlist(dict));
  if (sdef) writeFileSync(join(app, 'Contents', 'Resources', `${name}.sdef`), '<dictionary/>');
  for (const b of bins) { mkdirSync(join(app, 'Contents', 'Resources', 'app', 'bin'), { recursive: true }); writeFileSync(join(app, 'Contents', 'Resources', 'app', 'bin', b), '#!/bin/sh\n'); chmodSync(join(app, 'Contents', 'Resources', 'app', 'bin', b), 0o755); }
  for (const b of macos) { writeFileSync(join(app, 'Contents', 'MacOS', b), '#!/bin/sh\n'); chmodSync(join(app, 'Contents', 'MacOS', b), 0o755); }
  return app;
}
/** A world rooted in a temp folder: /Applications etc. are mapped under it; plutil "fails" so the XML reader is used. */
function fixtureWorld(home, { pathDirs = [] } = {}) {
  const real = (p) => (p.startsWith(home) ? p : join(home, 'ROOT', p));
  const fs = { readdirSync: (p) => [], ...awaitFs };
  return {
    home,
    env: { PATH: pathDirs.join(':'), HOME: home, SOL_GHOST_PEEKABOO_BIN: join(home, 'bin', 'peekaboo') },
    readdir: (p) => awaitFs.readdirSync(real(p)),
    stat: (p) => awaitFs.statSync(real(p)),
    lstat: (p) => awaitFs.lstatSync(real(p)),
    realpath: (p) => { const r = awaitFs.realpathSync(real(p)); return r.startsWith(join(home, 'ROOT')) ? r.slice(join(home, 'ROOT').length) : r; },
    readFile: (p) => awaitFs.readFileSync(real(p)),
    run: async () => ({ ok: false, stdout: '' }),
    exists: (p) => awaitFs.existsSync(real(p)),
    _fs: fs,
  };
}
const awaitFs = await import('node:fs');

test('a Ronin-locked install pins "my CRM" to Ronin; an override toward another CRM or a foreign check-in is dropped', async () => {
  const secrets = { nonce: 'n'.repeat(64), voiceKey: 'v'.repeat(64) };
  const crmLock = CRM_LOCKS.ronininc;
  assert.equal(ghostBackendEnv({ env: { PATH: '/usr/bin' }, paths, port: 3001, secrets, ghostBin: null }).SOLOMON_HOME_CRM_URL, undefined, 'no lock: the product default (no CRM) is unchanged');
  const plain = ghostBackendEnv({ env: { PATH: '/usr/bin' }, paths, port: 3001, secrets, ghostBin: null, crmLock, addon: roninAddon });
  assert.equal(plain.SOLOMON_HOME_CRM_URL, 'https://www.ronininc.org');
  const oro = ghostBackendEnv({ env: { PATH: '/usr/bin', SOLOMON_HOME_CRM_URL: 'https://crm.orosolu.com', SOLOMON_SEEKER_CHECKIN_URL: 'https://crm.orosolu.com/mcp/seeker' }, paths, port: 3001, secrets, ghostBin: null, crmLock, addon: roninAddon });
  assert.equal(oro.SOLOMON_HOME_CRM_URL, 'https://www.ronininc.org');
  assert.equal(oro.SOLOMON_SEEKER_CHECKIN_URL, undefined);
  const ronin = ghostBackendEnv({ env: { PATH: '/usr/bin', SOLOMON_SEEKER_CHECKIN_URL: 'https://www.ronininc.org/api/seeker/checkin' }, paths, port: 3001, secrets, ghostBin: null, crmLock, addon: roninAddon });
  assert.equal(ronin.SOLOMON_SEEKER_CHECKIN_URL, 'https://www.ronininc.org/api/seeker/checkin', 'a Ronin check-in is kept');
});

test('scan: on a Ronin-locked install the other company\'s app (OroSolu web app) is left out of the device map', async () => {
  const home = fixtureHome();
  const R = join(home, 'ROOT');
  mkdirSync(join(R, 'Applications'), { recursive: true });
  mkdirSync(join(R, 'System', 'Applications'), { recursive: true });
  makeApp(join(R, 'Applications'), 'Orosolu', { CFBundleIdentifier: 'com.google.Chrome.app.abpokgnkiekpdkijoeicmnfbegnkmeck' });
  makeApp(join(R, 'Applications'), 'Fooer', { CFBundleIdentifier: 'com.example.fooer' });
  const w = fixtureWorld(home, { pathDirs: [] });
  assert.ok((await scanApps(w)).some((a) => a.name === 'Orosolu'), 'no lock: the scan is unchanged');
  const names = (await scanApps(w, { lock: CRM_LOCKS.ronininc })).map((a) => a.name);
  assert.ok(names.includes('Fooer'));
  assert.ok(!names.some((n) => /orosolu/i.test(n)), JSON.stringify(names));
});
