// FIRST-RUN DEVICE SCAN, KEYS → VAULT, CANDIDATES, GOVERNED INSTALL, GUIDED KEY ACQUISITION: hermetic.
// Every fixture lives in a temp folder; every network call is a fake; canary key values are searched for in every
// output (said, printed, logged, returned, the map file) in six encodings.

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  appRoutes, appsInText, buildCapabilities, closestCapabilityLine, cooperativePacer, isBareCant, mapCounts, mcpEntry, parseCodexMcp, parsePlistXml,
  readDeviceMap, scanApps, scanDevice, scanDue, scanMcpConfigs, scanPathClis, sessionHosts, urlSchemes, writeDeviceMap, MAP_SCHEMA,
} from '../lib/device-scan.mjs';
import { chooseImports, classifyKeyName, importBody, importKeysToVault, importReadBack, keyShape, parseAssignments, scanKeys } from '../lib/device-keys.mjs';
import { appsToSearch, candidateFlags, findCandidates, licenseClass, matchProposal, scoreCandidate } from '../lib/device-candidates.mjs';
import { installPlan, installTool, integrityMatches, registerTool, readToolsManifest } from '../lib/device-tools.mjs';
import { createDeskOfDevice, deviceDoctorLines, deviceIntent, firstRunLine, ownerWord } from '../lib/device-desk.mjs';
import { createOwnerSession } from '../lib/session.mjs';
import { acquireKey, matchCatalog, matchesShape, parseDialogOutput, promptPaste, PASTE_DIALOG_SCRIPT, saveFromClipboard, setupKeys, storedLine } from '../lib/key-acquire.mjs';
import { callTool } from '../lib/mcp.mjs';
import { resolvePaths } from '../lib/paths.mjs';
import { ghostBackendEnv } from '../lib/profile.mjs';

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const rand = (n) => Array.from(randomBytes(n), (b) => ALNUM[b % ALNUM.length]).join('');
const encodings = (s) => [s, Buffer.from(s).toString('base64').replace(/=+$/, ''), Buffer.from(s).toString('base64url'), Buffer.from(s).toString('hex'), encodeURIComponent(s), s.slice(6, 22)];
/** Where a canary shows up in a text, in any of six encodings (an empty list is a clean result). */
const leaks = (text, canaries) => canaries.flatMap((c) => encodings(c).filter((n) => String(text).includes(n)).map((n) => `${c.slice(0, 6)}…(${n === c ? 'plain' : 'encoded'})`));

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

// ── inventory ────────────────────────────────────────────────────────────────────────────────────────────
test('scan: apps, their own CLIs, AppleScript, links and the hands; PATH links into a bundle; resumable phases', async () => {
  const home = fixtureHome();
  const R = join(home, 'ROOT');
  mkdirSync(join(R, 'Applications', 'Vendor Suite'), { recursive: true });
  mkdirSync(join(R, 'System', 'Applications'), { recursive: true });
  mkdirSync(join(R, 'usr', 'bin'), { recursive: true });
  mkdirSync(join(R, 'opt', 'homebrew', 'bin'), { recursive: true });
  makeApp(join(R, 'Applications'), 'Fooer', { CFBundleIdentifier: 'com.example.fooer', CFBundleShortVersionString: '1.2' }, { bins: ['fooer'] });
  makeApp(join(R, 'Applications'), 'Scripty', { CFBundleIdentifier: 'com.example.scripty' }, { sdef: true });
  makeApp(join(R, 'Applications'), 'Linky', { CFBundleIdentifier: 'com.example.linky', schemes: ['linky', 'https'] });
  makeApp(join(R, 'Applications', 'Vendor Suite'), 'Deep Painter', { CFBundleIdentifier: 'com.vendor.painter' });
  makeApp(join(R, 'Applications'), 'Hidden Agent', { CFBundleIdentifier: 'com.example.agent', LSBackgroundOnly: true });
  makeApp(join(R, 'System', 'Applications'), 'Mail', { CFBundleIdentifier: 'com.apple.mail' }, { sdef: true });
  // /usr/bin/mail is not Mail.app's command line; a PATH symlink into Deep Painter's bundle is its own CLI.
  writeFileSync(join(R, 'usr', 'bin', 'mail'), '#!/bin/sh\n'); chmodSync(join(R, 'usr', 'bin', 'mail'), 0o755);
  writeFileSync(join(R, 'Applications', 'Vendor Suite', 'Deep Painter.app', 'Contents', 'MacOS', 'painter-tool'), '#!/bin/sh\n'); chmodSync(join(R, 'Applications', 'Vendor Suite', 'Deep Painter.app', 'Contents', 'MacOS', 'painter-tool'), 0o755);
  symlinkSync(join(R, 'Applications', 'Vendor Suite', 'Deep Painter.app', 'Contents', 'MacOS', 'painter-tool'), join(R, 'opt', 'homebrew', 'bin', 'painter'));
  const w = fixtureWorld(home, { pathDirs: ['/opt/homebrew/bin', '/usr/bin'] });
  const map0 = { mcp: [], apps: await scanApps(w, { pathLinks: scanPathClis(w).appLinks }), clis: { where: Object.fromEntries(scanPathClis(w).names) }, hands: { name: 'Hands of Horus' } };
  const built = buildCapabilities(map0);
  const by = Object.fromEntries(built.apps.map((a) => [a.name, a]));
  assert.ok(!by['Hidden Agent'], 'a background-only helper is not an app to drive');
  assert.equal(by.Fooer.best, 'cli'); assert.equal(by.Fooer.gap, false);
  assert.equal(by.Scripty.best, 'applescript'); assert.equal(by.Scripty.gap, true);
  assert.equal(by.Linky.best, 'url-scheme'); assert.deepEqual(by.Linky.schemes, ['linky']);
  assert.ok(by['Deep Painter'].routes.some((r) => r.kind === 'cli' && r.via === 'painter'), 'PATH link into the bundle, found in a vendor folder');
  assert.ok(!by.Mail.routes.some((r) => r.kind === 'cli'), '/usr/bin/mail is not Mail.app');
  for (const a of built.apps) assert.equal(a.routes.at(-1).kind, 'hands', 'the hands are every app\'s fallback');

  // Resumable: a scan stopped after two phases picks up at the third and finishes.
  const file = join(home, 'map.json');
  const ac = new AbortController();
  const phases = [];
  await scanDevice({ file, world: w, signal: ac.signal, onPhase: (p) => { phases.push(p); if (phases.length === 2) ac.abort(); } });
  const partial = readDeviceMap(file);
  assert.equal(scanDue(partial), 'resume');
  const again = [];
  const full = await scanDevice({ file, world: w, previous: partial, onPhase: (p) => again.push(p) });
  assert.ok(!again.includes('path'), `phases already done are not redone: ${again}`);
  assert.equal(full.complete, true);
  assert.equal(scanDue(readDeviceMap(file)), null);
  assert.equal((awaitFs.statSync(file).mode & 0o777), 0o600, 'the map is the owner\'s alone');
});

test('scan: MCP configs are read for names, packages and env NAMES only, never args or values', () => {
  const home = fixtureHome();
  const SECRET = `ghp_CANARY${rand(30)}`;
  mkdirSync(join(home, 'Library', 'Application Support', 'Claude'), { recursive: true });
  writeFileSync(join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'), JSON.stringify({ mcpServers: {
    github: { command: '/usr/local/bin/npx', args: ['-y', '@modelcontextprotocol/server-github', `--token=${SECRET}`], env: { GITHUB_PERSONAL_ACCESS_TOKEN: SECRET } },
    figma: { url: `https://mcp.figma.com/mcp?key=${SECRET}` },
  } }));
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(join(home, '.codex', 'config.toml'), `[mcp_servers.node_repl]\ncommand = "node_repl"\n[mcp_servers.node_repl.env]\nAPI_TOKEN = "${SECRET}"\n[other]\nx = 1\n`);
  const w = { home, readFile: (p) => readFileSync(p), stat: (p) => awaitFs.statSync(p) };
  const servers = scanMcpConfigs(w);
  const gh = servers.find((s) => s.name === 'github');
  assert.equal(gh.package, '@modelcontextprotocol/server-github');
  assert.deepEqual(gh.envNames, ['GITHUB_PERSONAL_ACCESS_TOKEN']);
  assert.equal(servers.find((s) => s.name === 'figma').host, 'mcp.figma.com');
  assert.deepEqual(Object.keys(parseCodexMcp(readFileSync(join(home, '.codex', 'config.toml'), 'utf8'))), ['node_repl'], 'the .env sub-table is not a server');
  assert.deepEqual(leaks(JSON.stringify(servers), [SECRET]), []);
  assert.equal(mcpEntry('x', 'y', { command: 'docker', args: ['run', '-i', 'mcp/fetch:latest'] }, 'f').package, 'mcp/fetch:latest');
});

test('scan: Chrome session → hosts only (no paths, no queries); plist reading; URL schemes skip the web\'s own', () => {
  const bytes = Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from('https://mail.google.com/mail/u/0/#inbox?token=abc\0http://app.slack.com/client/T1\0https://mail.google.com/x\0http://localhost:3001/\0https://10.0.0.1/a')]);
  const hosts = sessionHosts(bytes);
  assert.deepEqual(hosts, ['mail.google.com', 'app.slack.com']);
  assert.ok(!hosts.join(' ').includes('token') && !hosts.join(' ').includes('/'));
  const info = parsePlistXml(xmlPlist({ CFBundleIdentifier: 'a.b', NSAppleScriptEnabled: true, schemes: ['zed', 'http'] }));
  assert.equal(info.CFBundleIdentifier, 'a.b'); assert.equal(info.NSAppleScriptEnabled, true);
  assert.deepEqual(urlSchemes(info), ['zed']);
});

test('pace: a congested Mac stretches the scan, an idle one runs straight through', async () => {
  let push = () => {};
  const source = { subscribe: (fn) => { push = fn; return () => { push = () => {}; }; } };
  const slept = [];
  const pace = cooperativePacer({ source, sleep: async (ms) => { slept.push(ms); } });
  assert.equal(await pace.step(100), 0, 'idle: no wait');
  push({ pressureLevel: 'warning', pagingBytesPerSecond: 0, thermal: 'nominal', cpuIdle: 0.5 });
  assert.equal(pace.duty, 0.5);
  assert.equal(await pace.step(100), 100, 'half duty: as long a rest as the work took');
  pace.stop();
});

test('never a bare "I can\'t": the closest capability Ghost has, and the proposal', () => {
  const map = buildCapabilities({
    apps: [{ name: 'Spotify', bundleId: 'com.spotify.client', tokens: ['spotify'], scriptable: true, schemes: ['spotify'], bundledClis: [], pathLinkedClis: [] }],
    proposals: [{ id: 'spotify-mcp', name: '@x/spotify-mcp', app: 'Spotify', bundleId: 'com.spotify.client', state: 'proposed', license: 'MIT', stars: 120, score: 500 }],
    hands: { name: 'Hands of Horus' }, mcp: [], clis: { where: {} },
  });
  assert.equal(isBareCant("I can't control Spotify."), true);
  assert.equal(isBareCant("I can't do that directly, but I can still open it."), false);
  const line = closestCapabilityLine(map, 'skip this song on spotify', "Sorry, I can't control Spotify.");
  assert.match(line, /I can still drive Spotify with its AppleScript dictionary and the Hands of Horus/);
  assert.match(line, /say "acquire @x\/spotify-mcp"/);
  assert.equal(closestCapabilityLine(map, 'skip this song on spotify', 'Skipped.'), null);
  assert.match(closestCapabilityLine(map, 'book me a flight', "I'm unable to do that."), /Hands of Horus/);
  assert.equal(appsInText(map, 'open my spotify')[0].name, 'Spotify');
});

// ── keys on this Mac (names only) ────────────────────────────────────────────────────────────────────────
function keyFixture() {
  const home = fixtureHome();
  const C = { openai: `sk-proj-CANARY${rand(40)}`, stripe: `sk_test_CANARY${rand(30)}`, cf: `CFCANARY${rand(36)}`, groq: `gsk_CANARY${rand(44)}`, gh: `ghp_CANARY${rand(30)}`, pw: `PWCANARY${rand(20)}`, ghost: `tvly-CANARY${rand(30)}` };
  mkdirSync(join(home, 'Projects', 'shop', 'server'), { recursive: true });
  writeFileSync(join(home, 'Projects', 'shop', 'server', '.env'), [
    `OPENAI_API_KEY=${C.openai}`, `DB_PASSWORD=${C.pw}`, `STRIPE_SECRET_KEY="${C.stripe}"`, 'EMPTY_API_KEY=', 'TAVILY_API_KEY=your-key-here',
    `SIGNING_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----"`, 'BILLING_API_KEY=4111111111111111', 'SOLOMON_DESKTOP_CONTROL_NONCE=abcdefabcdefabcdefabcdefabcdef12', '# a comment', '',
  ].join('\n'));
  writeFileSync(join(home, '.zshrc'), `export PATH=/x:$PATH\nexport CLOUDFLARE_API_TOKEN="${C.cf}"\nexport GITHUB_TOKEN=$(security find-generic-password -w)\n`);
  mkdirSync(join(home, 'Projects', 'app'), { recursive: true });
  writeFileSync(join(home, 'Projects', 'app', '.env.local'), `GROQ_API_KEY=${C.groq} # dev\nOPENAI_API_KEY=${C.openai}\n`);
  writeFileSync(join(home, 'Projects', 'app', '.env.bak-1'), `GROQ_API_KEY=${C.groq}\n`);
  mkdirSync(join(home, 'Library', 'Application Support', 'Claude'), { recursive: true });
  writeFileSync(join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'), JSON.stringify({ mcpServers: { gh: { command: 'npx', env: { GITHUB_PERSONAL_ACCESS_TOKEN: C.gh } } } }));
  const ghostHome = join(home, 'ghost-runtime');
  mkdirSync(ghostHome, { recursive: true });
  writeFileSync(join(ghostHome, '.env'), `SOLOMON_TAVILY_API_KEY=${C.ghost}\n`);
  return { home, ghostHome, C };
}

test('keys: names, providers and files only; passwords, private keys, cards, placeholders, references and own secrets skipped', () => {
  const { home, ghostHome, C } = keyFixture();
  const r = scanKeys({ home, ghostRuntimeHome: ghostHome });
  const names = chooseImports(r.entries).map((e) => `${e.name}:${e.provider}:${e.source}`).sort();
  assert.deepEqual(names, [
    'CLOUDFLARE_API_TOKEN:cloudflare:shell', 'GITHUB_PERSONAL_ACCESS_TOKEN:github:mcp-config', 'GROQ_API_KEY:groq:project',
    'OPENAI_API_KEY:openai:project-server', 'SOLOMON_TAVILY_API_KEY:tavily:ghost', 'STRIPE_SECRET_KEY:stripe:project-server',
  ]);
  assert.equal(r.found, 6);
  assert.equal(chooseImports(r.entries).find((e) => e.name === 'OPENAI_API_KEY').alsoIn, 1, 'the same name in a lower-priority file is noted, not imported twice');
  assert.ok(r.skipped.password >= 1 && r.skipped['private-key'] >= 1 && r.skipped['payment-card'] >= 1 && r.skipped.placeholder >= 1 && r.skipped.reference >= 1 && r.skipped['own-secret'] >= 1, JSON.stringify(r.skipped));
  assert.ok(!r.entries.some((e) => /\.bak/.test(e.file)), 'a backup file is not a source');
  assert.deepEqual(leaks(JSON.stringify(r), Object.values(C)), []);
  assert.deepEqual(leaks(importReadBack(r), Object.values(C)), []);
  assert.match(importReadBack(r), /6 API keys on this Mac for 6 services/);
  assert.match(importReadBack(r), /Stripe is a money account/);
  assert.equal(classifyKeyName('SOLOMON_OPENALEPH_API_KEY').provider, 'openaleph');
  assert.equal(classifyKeyName('SOLOMON_SEARXNG_PORT').skip, 'own-secret');
  assert.equal(classifyKeyName('MY_WALLET_SEED').skip, 'seed-phrase');
  assert.equal(keyShape(Buffer.from('postgres://u:p@h/db-long-enough')), 'not-a-key');
  const a = parseAssignments(Buffer.from('export A_TOKEN="x y"\nB_TOKEN=\'v\'\n'));
  assert.equal(a[0].name, 'A_TOKEN'); assert.equal(a[1].name, 'B_TOKEN');
});

test('keys → vault: one owner call with the bytes; nothing comes back; the read buffers are zeroed; an older engine falls back', async () => {
  const { home, ghostHome, C } = keyFixture();
  const scan = scanKeys({ home, ghostRuntimeHome: ghostHome });
  const reads = [];
  const readBytes = (p) => { const b = readFileSync(p); reads.push(b); return b; };
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = init.body ? Buffer.from(init.body).toString('utf8') : '';
    calls.push({ url, nonce: init.headers['x-solomon-desktop-nonce'], body });
    const keys = JSON.parse(body).keys;
    return new Response(JSON.stringify({ ok: true, data: { receiptId: 'sol_gme_1', imported: keys.map((k) => ({ envName: k.envName, provider: k.provider, row: 'device-key' })), refused: [], appliedToEnv: [] } }), { status: 200 });
  };
  const logs = [];
  const r = await importKeysToVault({ port: 1, nonce: 'n'.repeat(64), scan, home, readBytes, fetchImpl, log: (e, d) => logs.push(JSON.stringify({ e, d })) });
  assert.equal(calls.length, 1, 'ONE call');
  assert.match(calls[0].url, /\/api\/key-handoff\/console\/import$/);
  assert.equal(calls[0].nonce, 'n'.repeat(64));
  for (const v of [C.openai, C.stripe, C.cf, C.groq, C.gh, C.ghost]) assert.equal(calls[0].body.split(v).length - 1, 1, 'each key exactly once, only in the request body');
  assert.ok(!calls[0].body.includes(C.pw));
  assert.equal(r.ok, true); assert.equal(r.receiptId, 'sol_gme_1'); assert.equal(r.imported.length, 6);
  assert.deepEqual(leaks(JSON.stringify(r) + logs.join(''), Object.values(C)), []);
  for (const b of reads) assert.ok(b.every((x) => x === 0), 'every buffer read from a key file is zero-filled');

  // An older engine (no /console/import): the key handoff for what its catalog knows; the rest wait.
  const seen = [];
  const old = async (url, init) => {
    seen.push(url.replace(/^http:\/\/127\.0\.0\.1:1/, ''));
    if (url.endsWith('/console/import')) return new Response('{}', { status: 404 });
    if (url.endsWith('/start')) return new Response(JSON.stringify({ ok: true, data: { id: 'kh_123456' } }), { status: 200 });
    if (url.endsWith('/console/seal')) return new Response(JSON.stringify({ ok: true, data: { state: 'SEALED_AWAITING_CONFIRM' } }), { status: 200 });
    return new Response('{"ok":true}', { status: 200 });
  };
  const r2 = await importKeysToVault({ port: 1, nonce: 'n'.repeat(64), scan, home, fetchImpl: old });
  assert.equal(r2.route, 'handoff');
  assert.deepEqual(r2.imported.map((x) => x.provider).sort(), ['github', 'stripe']);
  assert.ok(seen.includes('/api/key-handoff/kh_123456/decline'), 'sealed and left off: connecting is a later yes');
  assert.ok(r2.refused.some((x) => x.reason === 'NOT_IN_THIS_BUILD'));
  assert.throws(() => importBody([{ envName: 'A_KEY', provider: 'a', source: 'paste', secret: Buffer.from('has space in it ok') }]), /NOT_A_KEY_SHAPE/);
});

// ── candidates ────────────────────────────────────────────────────────────────────────────────────────────
test('candidates: licence first (AGPL / non-commercial flagged), stars, recency; archived and gone repos dropped; only app names leave', async () => {
  assert.equal(licenseClass('MIT'), 'permissive'); assert.equal(licenseClass('Apache-2.0'), 'permissive'); assert.equal(licenseClass('MPL-2.0'), 'weak-copyleft');
  assert.equal(licenseClass('GPL-3.0'), 'copyleft'); assert.equal(licenseClass('AGPL-3.0'), 'agpl'); assert.equal(licenseClass('BUSL-1.1'), 'non-commercial'); assert.equal(licenseClass('NOASSERTION'), 'unknown');
  assert.match(candidateFlags({ license: 'AGPL-3.0', stars: 5000 }).join(), /AGPL/);
  const app = { name: 'Spotify', bundleId: 'com.spotify.client', tokens: ['spotify'], gap: true, system: false };
  assert.ok(scoreCandidate({ name: 'spotify-mcp', license: 'MIT', stars: 10 }, app) > scoreCandidate({ name: 'spotify-mcp', license: 'AGPL-3.0', stars: 50000 }, app), 'a permissive licence outranks stars');
  const map = { apps: [app, { name: 'Calculator', bundleId: 'com.apple.calculator', gap: true, system: true, tokens: [] }, { name: 'Kingmaker', bundleId: 'com.ronininc.solghost', gap: false, self: true, tokens: [] }], proposals: [], candidates: { consent: { granted: true }, searched: {} } };
  assert.deepEqual(appsToSearch(map).map((a) => a.name), ['Spotify'], 'Chess-like system apps and Ghost itself are not searched');
  const urls = [];
  const now = new Date('2026-10-08T00:00:00Z');
  const fetchImpl = async (url) => {
    urls.push(url);
    if (url.startsWith('https://registry.modelcontextprotocol.io')) return new Response(JSON.stringify({ servers: [
      { server: { name: 'io.github.a/spotify-mcp', description: 'Spotify MCP server', version: '1.0.0', repository: { url: 'https://github.com/a/spotify-mcp' }, packages: [{ registryType: 'npm', identifier: '@a/spotify-mcp', version: '1.0.0', environmentVariables: [{ name: 'SPOTIFY_CLIENT_ID', isRequired: true }] }] } },
      { server: { name: 'io.github.gone/spotify-x', description: 'spotify thing', version: '0.1.0', repository: { url: 'https://github.com/gone/spotify-x' }, packages: [{ registryType: 'npm', identifier: 'spotify-x', version: '0.1.0' }] } },
    ] }), { status: 200 });
    if (url.startsWith('https://api.github.com/search')) return new Response(JSON.stringify({ items: [
      { full_name: 'b/spotify-cli-agpl', name: 'spotify-cli-agpl', html_url: 'https://github.com/b/spotify-cli-agpl', description: 'Spotify CLI', stargazers_count: 9000, pushed_at: '2026-09-01T00:00:00Z', license: { spdx_id: 'AGPL-3.0' } },
      { full_name: 'c/spotify-old', name: 'spotify-old', html_url: 'https://github.com/c/spotify-old', description: 'spotify', archived: true, license: { spdx_id: 'MIT' } },
      { full_name: 'd/spotify-fork', name: 'spotify-fork', fork: true, description: 'spotify', license: { spdx_id: 'MIT' } },
    ] }), { status: 200 });
    if (url === 'https://api.github.com/repos/a/spotify-mcp') return new Response(JSON.stringify({ stargazers_count: 300, pushed_at: '2026-09-20T00:00:00Z', license: { spdx_id: 'MIT' } }), { status: 200 });
    if (url === 'https://api.github.com/repos/gone/spotify-x') return new Response('{}', { status: 404 });
    return new Response('{}', { status: 404 });
  };
  const saved = [];
  const r = await findCandidates({ map, save: (m) => saved.push(m), fetchImpl, sleep: async () => {}, now: () => now });
  assert.equal(r.searched, 1);
  const props = map.proposals;
  assert.equal(props[0].name, '@a/spotify-mcp'); assert.equal(props[0].license, 'MIT'); assert.equal(props[0].installable, true);
  assert.deepEqual(props[0].needsEnv.map((v) => v.name), ['SPOTIFY_CLIENT_ID']);
  assert.ok(!props.some((p) => /spotify-old|spotify-fork|spotify-x/.test(p.name)), 'archived, forks and repos GitHub does not have are never proposed');
  for (const u of urls) assert.ok(!/key|token|secret|\/Users\//i.test(u.replace(/spotify/gi, '')), `only the app's name leaves: ${u}`);
  assert.equal(matchProposal(map, 'the spotify one').id, props[0].id);

  // GitHub's rate limit ends the run; the next one resumes with that app.
  const limited = { apps: [app], proposals: [], candidates: { searched: {} } };
  const r2 = await findCandidates({ map: limited, fetchImpl: async (url) => (url.includes('api.github.com') ? new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }) : new Response('{"servers":[]}', { status: 200 })), sleep: async () => {} });
  assert.equal(r2.stoppedFor, 'rate-limited');
  assert.deepEqual(appsToSearch(limited).map((a) => a.name), ['Spotify']);
});

// ── governed install ──────────────────────────────────────────────────────────────────────────────────────
test('install: npm only, at the exact version, tarball checked against npm\'s sha512, scripts off, sha256 recorded, registered as a RED proposal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghost-tools-'));
  assert.equal(installPlan({ name: 'x', package: { type: 'pypi', name: 'x', version: '1.0.0' } }).ok, false);
  assert.equal(installPlan({ name: 'x', package: { type: 'remote', host: 'h' } }).ok, false);
  assert.equal(installPlan({ name: 'x', package: { type: 'npm', name: 'x', version: '^1.0.0' } }).ok, false, 'a range is not a pin');
  const tarball = Buffer.from(`fake tarball ${rand(20)}`);
  const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
  const p = { id: 'a-spotify-mcp', name: '@a/spotify-mcp', app: 'Spotify', package: { type: 'npm', name: '@a/spotify-mcp', version: '1.0.0' }, license: 'MIT', repo: 'https://github.com/a/spotify-mcp' };
  const fetchImpl = async (url) => {
    if (url === 'https://registry.npmjs.org/@a%2Fspotify-mcp/1.0.0') return new Response(JSON.stringify({ dist: { tarball: 'https://registry.npmjs.org/@a/spotify-mcp/-/spotify-mcp-1.0.0.tgz', integrity, unpackedSize: 1000 } }), { status: 200 });
    if (url.endsWith('.tgz')) return new Response(tarball, { status: 200 });
    return new Response('{}', { status: 404 });
  };
  const npmCalls = [];
  const npm = async (bin, args, { cwd }) => {
    npmCalls.push(args);
    const pkg = join(cwd, 'node_modules', '@a', 'spotify-mcp');
    mkdirSync(join(pkg, 'dist'), { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@a/spotify-mcp', bin: { 'spotify-mcp': 'dist/index.js' } }));
    writeFileSync(join(pkg, 'dist', 'index.js'), '');
    writeFileSync(join(cwd, 'package-lock.json'), '{}');
    return { ok: true, out: '' };
  };
  const r = await installTool(p, { dir, fetchImpl, npm, npmBin: '/x/npm', nodeBin: '/x/node' });
  assert.equal(r.ok, true, r.reason);
  assert.ok(npmCalls[0].includes('--ignore-scripts'), 'no install script ever runs');
  assert.equal(r.entry.tarballSha256, createHash('sha256').update(tarball).digest('hex'));
  assert.equal(readToolsManifest(dir).tools['a-spotify-mcp'].integrity, integrity);
  assert.ok(r.entry.bin.endsWith(join('node_modules', '@a', 'spotify-mcp', 'dist', 'index.js')));
  assert.equal(integrityMatches(Buffer.from('other'), integrity), false);
  const bad = await installTool({ ...p, id: 'bad' }, { dir, fetchImpl: async (url) => (url.endsWith('.tgz') ? new Response(Buffer.from('tampered'), { status: 200 }) : fetchImpl(url)), npm, npmBin: '/x/npm', nodeBin: '/x/node' });
  assert.equal(bad.ok, false); assert.match(bad.reason, /does not match npm's sha512/); assert.equal(existsSync(join(dir, 'bad')), false, 'nothing unpacked');
  const offRegistry = await installTool({ ...p, id: 'off' }, { dir, fetchImpl: async (url) => (url.includes('/1.0.0') && !url.endsWith('.tgz') ? new Response(JSON.stringify({ dist: { tarball: 'https://evil.example/x.tgz', integrity } }), { status: 200 }) : fetchImpl(url)), npm, npmBin: '/x/npm', nodeBin: '/x/node' });
  assert.equal(offRegistry.ok, false);
  let posted = null;
  const reg = await registerTool({ port: 1, nonce: 'n'.repeat(64), entry: r.entry, dir, fetchImpl: async (url, init) => { posted = { url, body: JSON.parse(init.body) }; return new Response(JSON.stringify({ ok: true, decision: { kind: 'PROPOSED', proposal: { proposalId: 'p1', challenge: 'amber falcon', riskTier: 'RED' } } }), { status: 202 }); } });
  assert.equal(reg.ok, true); assert.equal(reg.proposal.challenge, 'amber falcon');
  assert.match(posted.url, /\/api\/mcp\/servers$/);
  assert.deepEqual({ t: posted.body.transport, c: posted.body.command, a: posted.body.args }, { t: 'stdio', c: '/x/node', a: [r.entry.bin] });
});

// ── the desk: read back, then only his word ───────────────────────────────────────────────────────────────
function deskFixture({ voiceAuthority = 'owner', voiceApproves = true, map, impl = {} } = {}) {
  const home = fixtureHome();
  const paths = { runtimeHome: join(home, 'runtime'), state: join(home, 'state') };
  mkdirSync(paths.runtimeHome, { recursive: true });
  const file = join(paths.runtimeHome, 'device-capabilities.json');
  if (map) writeDeviceMap(file, map);
  const said = []; const printed = []; const calls = [];
  const desk = createDeskOfDevice({
    paths, port: 1, nonce: 'n'.repeat(64), say: async (l) => { said.push(l); }, out: (l) => printed.push(l), voiceAuthority, voiceApproves, file,
    impl: {
      scanDevice: async () => ({ schema: MAP_SCHEMA, apps: [], phases: Object.fromEntries(['apps', 'packages', 'path', 'mcp', 'hands', 'web'].map((p) => [p, { doneAt: new Date().toISOString() }])), complete: true, scannedAt: new Date().toISOString() }),
      scanKeys: () => ({ found: 1, byProvider: { openai: 1 }, entries: [{ name: 'OPENAI_API_KEY', provider: 'openai', label: 'OpenAI', file: '~/x/.env', source: 'project' }], skipped: {} }),
      findCandidates: async () => { calls.push('find'); return { searched: 0, proposals: 0 }; },
      importKeysToVault: async () => { calls.push('import'); return { ok: true, imported: [{ envName: 'OPENAI_API_KEY', provider: 'openai' }], refused: [], receiptId: 'r1', route: 'console/import' }; },
      installTool: async () => { calls.push('install'); return { ok: true, entry: { id: 'x', version: '1.0.0', tarballSha256: 'ab' } }; },
      registerTool: async () => { calls.push('register'); return { ok: true, proposal: { proposalId: 'p', challenge: 'two words' } }; },
      handOff: async ({ proposal }) => { calls.push(`handoff:${proposal.app}`); return { ok: true }; },
      freeCatalog: async () => ({ ok: true, providers: [{ id: 'groq', label: 'Groq', envName: 'GROQ_API_KEY', lane: 'fast models', freeTier: 'free, no card', keyPageUrl: 'https://console.groq.com/keys', signupUrl: 'https://console.groq.com/login', steps: 'Copy it.', shape: { prefix: 'gsk_', minLength: 40, maxLength: 100, charset: 'base62-dash' }, stored: false }, { id: 'tavily', label: 'Tavily', envName: 'SOLOMON_TAVILY_API_KEY', stored: true, shape: { prefix: 'tvly-', minLength: 20, maxLength: 120, charset: 'base62-dash' } }] }),
      acquireKey: async (p) => { calls.push(`acquire:${p.id}`); return { action: 'save', stored: true }; },
      setupKeys: async (gaps) => { calls.push(`setup:${gaps.map((g) => g.id).join(',')}`); return { stored: gaps.map((g) => g.id), skipped: [], stopped: false }; },
      saveFromClipboard: async (p) => { calls.push(`clip:${p.id}`); return { ok: true, receiptId: 'r2', probe: { state: 'LIVE' } }; },
      ...impl,
    },
  });
  return { desk, said, printed, calls, file };
}

test('desk: intents; a read-back waits for HIS word (typed, or spoken when his voice is his word)', async () => {
  assert.deepEqual(deviceIntent('put my keys in the vault'), { kind: 'keys-import' });
  assert.deepEqual(deviceIntent('Ghost, scan my Mac'.replace(/^Ghost,\s*/, '')), { kind: 'scan' });
  assert.deepEqual(deviceIntent('set up my keys'), { kind: 'setup-keys' });
  assert.deepEqual(deviceIntent('get me a Groq key'), { kind: 'get-key', arg: 'Groq' });
  assert.equal(deviceIntent('what is the weather'), null);
  assert.equal(ownerWord({ typed: true }, 'propose', false), true);
  assert.equal(ownerWord({ spoken: true }, 'propose', true), false);
  assert.equal(ownerWord({ spoken: true }, 'verified', true), false);
  assert.equal(ownerWord({ spoken: true, attested: true }, 'verified', true), true);

  const f = deskFixture({ voiceAuthority: 'propose' });
  await f.desk.handle('put my keys in the vault', { spoken: true });
  assert.ok(f.desk.pending());
  assert.match(f.said.at(-1), /Only your word can put them there/);
  await f.desk.answer('yes', { spoken: true });
  assert.deepEqual(f.calls, [], 'a spoken yes under propose authority imports nothing');
  assert.ok(f.desk.pending(), 'still waiting for his word');
  assert.match(f.said.at(-1), /That needs your word/);
  await f.desk.answer('yes', { typed: true });
  assert.deepEqual(f.calls, ['import']);
  assert.match(f.said.at(-1), /Sealed 1 key for 1 service in the vault \(receipt r1\)/);

  const g = deskFixture({ map: { schema: MAP_SCHEMA, apps: [], phases: {}, proposals: [{ id: 'a-spotify-mcp', name: '@a/spotify-mcp', app: 'Spotify', package: { type: 'npm', name: '@a/spotify-mcp', version: '1.0.0' }, state: 'proposed', score: 1 }] } });
  // Outside code is never run as-is (operator doctrine 2026-10-08): "install"/"acquire" hands it to Kingmaker's
  // acquisition loop (quarantine, study, our own rebuild); nothing is npm-installed or registered.
  await g.desk.handle('install spotify-mcp', { spoken: true });
  assert.match(g.said.at(-1), /@a\/spotify-mcp for Spotify .*I don't run outside code as-is\. Say yes and it goes to Kingmaker's acquisition loop/);
  await g.desk.answer('no', { spoken: true });
  assert.deepEqual(g.calls, []);
  await g.desk.handle('acquire spotify-mcp', { spoken: true });
  await g.desk.answer('yes', { spoken: true });
  assert.deepEqual(g.calls, ['handoff:Spotify'], 'handed off; never installed or registered');
  assert.match(g.said.at(-1), /Handed to Kingmaker's acquisition loop: .*Nothing from it runs here until you approve what comes out\./);

  // A read-back lapses.
  let t = Date.now();
  const h = deskFixture();
  const lapse = createDeskOfDevice({ paths: { runtimeHome: mkdtempSync(join(tmpdir(), 'lapse-')), state: tmpdir() }, port: 1, nonce: 'n'.repeat(64), now: () => new Date(t), impl: { scanKeys: () => ({ found: 1, byProvider: { a: 1 }, entries: [{ name: 'A_API_KEY', provider: 'a', label: 'A', file: 'f', source: 'project' }] }) } });
  await lapse.handle('put my keys in the vault', { typed: true });
  t += 3 * 60_000;
  assert.equal(lapse.pending(), false);
  void h;
});

test('desk: online search needs his consent, kept for later; first start scans and says one line, once', async () => {
  const f = deskFixture({ voiceAuthority: 'propose' });
  await f.desk.handle('find tools for my apps', { spoken: true });
  assert.deepEqual(f.calls, []);
  assert.match(f.said.at(-1), /Only your word/);
  const g = deskFixture();
  await g.desk.handle('find tools for my apps', { spoken: true });
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(g.calls.includes('find'));
  assert.equal(readDeviceMap(g.file).candidates.consent.granted, true);

  const announced = [];
  const b = deskFixture();
  await b.desk.runBackground({ announce: (l) => announced.push(l) });
  await b.desk.runBackground({ announce: (l) => announced.push(l) });
  assert.equal(announced.length, 1);
  assert.match(announced[0], /I've scanned this Mac/);
  assert.match(announced[0], /1 free API Kingmaker can use has no key yet \(Groq\): say "set up my keys"/);
  assert.match(firstRunLine(readDeviceMap(b.file)), /put my keys in the vault/);
});

// ── guided key acquisition ────────────────────────────────────────────────────────────────────────────────
const GROQ = { id: 'groq', label: 'Groq', envName: 'GROQ_API_KEY', lane: 'fast cloud models', freeTier: 'free, no card', keyPageUrl: 'https://console.groq.com/keys', signupUrl: 'https://console.groq.com/login', steps: 'Press Create API Key and copy it.', shape: { prefix: 'gsk_', minLength: 40, maxLength: 100, charset: 'base62-dash' } };

test('paste box: a hidden native dialog bound to one provider; Save / Skip / Stop / Cancel; bytes zeroed', async () => {
  assert.match(PASTE_DIALOG_SCRIPT, /with hidden answer/);
  assert.match(PASTE_DIALOG_SCRIPT, /with title "Kingmaker — " & label/);
  const KEY = `gsk_CANARY${rand(44)}`;
  let out = null;
  const exec = async (file, args) => { assert.equal(file, '/usr/bin/osascript'); assert.equal(args[2], 'Groq'); out = Buffer.from(`Save\n${KEY}\n`); return { code: 0, stdout: out }; };
  const r = await promptPaste('Groq', { exec });
  assert.equal(r.action, 'save'); assert.equal(r.bytes.toString(), KEY);
  assert.ok(out.every((b) => b === 0), 'the dialog\'s output buffer is zero-filled');
  assert.deepEqual(parseDialogOutput(Buffer.from('Skip\n')), { action: 'skip' });
  assert.deepEqual(parseDialogOutput(Buffer.from(''), 1), { action: 'cancel' });
  assert.deepEqual(parseDialogOutput(Buffer.from('TIMEOUT\n')), { action: 'timeout' });
  assert.equal((await promptPaste('Groq', { batch: true, exec: async () => ({ code: 1, stdout: Buffer.alloc(0) }) })).action, 'stop');
  assert.equal(matchesShape(GROQ.shape, Buffer.from(KEY)), true);
  assert.equal(matchesShape(GROQ.shape, Buffer.from(`xyz_${rand(44)}`)), false);
  assert.equal(matchesShape({ minLength: 13, maxLength: 19, charset: 'printable' }, Buffer.from('4111111111111111')), false, 'a card number is never a key');
  assert.equal(matchCatalog([GROQ, { id: 'nvidia', label: 'NVIDIA NIM' }], 'nim').id, 'nvidia');
});

test('one key: his Chrome opens on the key page (Apple events, never open -a), the box opens, Save seals through the vault path with a probe; nothing leaks', async () => {
  const KEY = `gsk_CANARY${rand(44)}`;
  const opened = []; const said = []; const logs = [];
  let posted = null;
  const answerBytes = Buffer.from(KEY);
  const fetchImpl = async (url, init) => {
    posted = { url, body: Buffer.from(init.body).toString('utf8') };
    return new Response(JSON.stringify({ ok: true, data: { receiptId: 'sol_gme_9', imported: [{ envName: 'GROQ_API_KEY', provider: 'groq', row: 'device-key' }], refused: [], probes: [{ provider: 'groq', state: 'LIVE' }] } }), { status: 200 });
  };
  const r = await acquireKey(GROQ, {
    port: 1, nonce: 'n'.repeat(64), say: async (l) => said.push(l), out: (l) => said.push(l), log: (e, d) => logs.push(JSON.stringify(d)), fetchImpl,
    open: async (targets, opts) => { opened.push({ targets, opts }); return { where: 'chrome', windows: 1 }; },
    prompt: async (label) => { assert.equal(label, 'Groq'); return { action: 'save', bytes: answerBytes }; },
  });
  assert.equal(r.stored, true);
  assert.deepEqual(opened[0].targets, [{ kind: 'url', target: 'https://console.groq.com/keys' }]);
  assert.equal(opened[0].opts.chromeOnly, true, 'his visible Chrome only, by Apple events');
  assert.match(posted.url, /\/console\/import$/);
  const body = JSON.parse(posted.body);
  assert.equal(body.probe, true); assert.equal(body.keys[0].envName, 'GROQ_API_KEY'); assert.equal(body.keys[0].provider, 'groq'); assert.equal(body.keys[0].source, 'paste');
  assert.ok(answerBytes.every((b) => b === 0), 'the pasted bytes are zero-filled');
  assert.match(said.join(' '), /Sealed your Groq key in the vault \(receipt sol_gme_9\)\. I checked it: Groq accepted it/);
  assert.deepEqual(leaks(said.join('\n') + logs.join('\n') + JSON.stringify(r), [KEY]), []);

  // Cancel stores nothing; a wrong-shaped paste is refused before anything is sent.
  let sent = 0;
  const c = await acquireKey(GROQ, { port: 1, nonce: 'x'.repeat(64), open: async () => ({ where: 'chrome' }), prompt: async () => ({ action: 'cancel' }), fetchImpl: async () => { sent += 1; return new Response('{}'); } });
  assert.equal(c.stored, false); assert.equal(sent, 0);
  const wrong = await acquireKey(GROQ, { port: 1, nonce: 'x'.repeat(64), say: async (l) => said.push(l), open: async () => ({ where: 'chrome' }), prompt: async () => ({ action: 'save', bytes: Buffer.from(`sk-wrong${rand(40)}`) }), fetchImpl: async () => { sent += 1; return new Response('{}'); } });
  assert.equal(wrong.stored, false); assert.equal(sent, 0);
  assert.match(said.at(-1), /Nothing stored: that isn't a Groq key\./);
  assert.match(storedLine(GROQ, { ok: true, probe: { state: 'NO_PROBE' } }), /no read-only check/);
});

test('set up my keys: one provider at a time, Skip moves on, Stop ends; save it: the clipboard once', async () => {
  const P2 = { ...GROQ, id: 'mistral', label: 'Mistral', envName: 'MISTRAL_API_KEY', shape: { minLength: 32, maxLength: 64, charset: 'base62' } };
  const P3 = { ...GROQ, id: 'huggingface', label: 'Hugging Face', envName: 'HF_TOKEN', shape: { prefix: 'hf_', minLength: 30, maxLength: 80, charset: 'base62' } };
  const answers = [{ action: 'skip' }, { action: 'stop' }];
  const prompts = [];
  const r = await setupKeys([P2, P3, GROQ], { port: 1, nonce: 'n'.repeat(64), open: async () => ({ where: 'chrome' }), prompt: async (label, o) => { prompts.push(`${label}:${o.batch}`); return answers.shift(); } });
  assert.deepEqual(prompts, ['Mistral:true', 'Hugging Face:true']);
  assert.deepEqual(r, { stored: [], skipped: ['mistral'], stopped: true });

  const KEY = `gsk_CANARY${rand(44)}`;
  const clip = Buffer.from(KEY);
  let reads = 0;
  const s = await saveFromClipboard(GROQ, { port: 1, nonce: 'n'.repeat(64), read: async () => { reads += 1; return clip; }, fetchImpl: async () => new Response(JSON.stringify({ ok: true, data: { imported: [{ envName: 'GROQ_API_KEY' }], probes: [] } }), { status: 200 }) });
  assert.equal(s.ok, true); assert.equal(reads, 1, 'read once');
  assert.ok(clip.every((b) => b === 0));
  assert.equal((await saveFromClipboard(GROQ, { port: 1, nonce: 'n'.repeat(64), read: async () => null })).reason, 'CLIPBOARD_EMPTY');
});

test('desk keys: a stored provider is never asked again (once per vault); get-key reads back then opens; a bare "save it" stays the engine\'s without a key page', async () => {
  const f = deskFixture();
  assert.equal(await f.desk.handle('save it', { spoken: true }), null, 'no key page opened yet: "save it" is the engine\'s');
  await f.desk.handle('get me a Tavily key', { spoken: true });
  assert.match(f.said.at(-1), /I already have your Tavily key in the vault/);
  assert.equal(f.desk.pending(), false);
  await f.desk.handle('get me a Groq key', { spoken: true });
  assert.match(f.said.at(-1), /Groq: free, no card\. It powers fast models\. I'll open its key page in Chrome and a hidden paste box for it\. Signing up, the terms, any check and your password are yours/);
  await f.desk.answer('yes', { spoken: true });
  assert.deepEqual(f.calls, ['acquire:groq']);
  await f.desk.handle('save it', { spoken: true });
  assert.match(f.said.at(-1), /I'll read your clipboard once and seal it as your Groq key\. Say yes\./);
  await f.desk.answer('yes', { spoken: true });
  assert.deepEqual(f.calls, ['acquire:groq', 'clip:groq']);
  await f.desk.handle('set up my keys', { typed: true });
  await f.desk.answer('yes', { typed: true });
  assert.equal(f.calls.at(-1), 'setup:groq', 'only the providers without a key');
  assert.equal(await f.desk.handle('get me a Stripe key', { typed: true }), null, 'not a free-tier API: the engine\'s own key handoff answers');
});

test('reinstall: a new app location keeps the same data dir and the same vault (secure root outside every bundle)', () => {
  const home = '/Users/someone';
  const env = { HOME: home };
  const a = resolvePaths({ ...env, KINGMAKER_RUNTIME_APP: '/Applications/Kingmaker.app', SOL_GHOST_RUNTIME: 'app' }, home, { modulePath: '/Applications/Kingmaker.app/Contents/Resources/sol-ghost/lib/paths.mjs', exists: () => false });
  const b = resolvePaths({ ...env, KINGMAKER_RUNTIME_APP: '/Volumes/New/Solomon.app', SOL_GHOST_RUNTIME: 'app' }, home, { modulePath: '/Users/someone/Downloads/Kingmaker 2.app/Contents/Resources/sol-ghost/lib/paths.mjs', exists: () => false });
  assert.equal(a.runtimeHome, b.runtimeHome);
  assert.equal(a.runtimeHome, '/Users/someone/Library/Application Support/sol-ghost/runtime');
  const secrets = { nonce: 'n'.repeat(64), voiceKey: 'k'.repeat(64) };
  const ea = ghostBackendEnv({ env, paths: { ...a, voice: { wakePhraseFile: 'w' } }, port: 3001, secrets, ghostBin: null });
  const eb = ghostBackendEnv({ env, paths: { ...b, voice: { wakePhraseFile: 'w' } }, port: 3001, secrets, ghostBin: null });
  assert.equal(ea.SOLOMON_SECURE_ROOT, '/Users/someone/.solomon-secure');
  assert.equal(ea.SOLOMON_SECURE_ROOT, eb.SOLOMON_SECURE_ROOT);
  assert.equal(ea.SOLOMON_HEADLESS_HOME, eb.SOLOMON_HEADLESS_HOME);
  for (const app of [a.app, b.app, '/Applications/Kingmaker.app', '/Users/someone/Downloads/Kingmaker 2.app']) assert.ok(!ea.SOLOMON_SECURE_ROOT.startsWith(app) && !a.runtimeHome.startsWith(app));
});

// ── MCP: read-only, never a key ─────────────────────────────────────────────────────────────────────────────
test('mcp: device_capabilities is read-only and shows key counts by provider only; kingmaker_turn adds the closest capability', async () => {
  const map = buildCapabilities({
    schema: MAP_SCHEMA, scannedAt: '2026-10-08T00:00:00Z', complete: true, hands: { name: 'Hands of Horus' }, mcp: [], clis: { where: {}, count: 3 },
    apps: [{ name: 'Spotify', bundleId: 'com.spotify.client', tokens: ['spotify'], scriptable: true, schemes: [], bundledClis: [], pathLinkedClis: [] }],
    proposals: [], keys: { found: 2, byProvider: { openai: 1, groq: 1 }, entries: [{ name: 'OPENAI_API_KEY', file: '~/Projects/secret-project/.env' }] },
  });
  const r = await callTool('device_capabilities', {}, { readMap: () => map });
  const textOut = r.content[0].text;
  assert.match(textOut, /"byProvider"/);
  assert.ok(!textOut.includes('secret-project') && !textOut.includes('OPENAI_API_KEY'), 'never where a key is, never its name list');
  const t = await callTool('kingmaker_turn', { text: 'pause spotify' }, { port: 1, readMap: () => map, fetchImpl: async () => new Response(JSON.stringify({ data: { spokenResponse: "I can't control Spotify." } }), { status: 200 }) });
  assert.match(t.content[0].text, /"closestCapability": "I can still drive Spotify/);
});

test('counts: what the doctor and the first-run line say', () => {
  const map = buildCapabilities({ apps: [{ name: 'A', bundleId: 'a', tokens: ['aaaa'], bundledClis: [{ bin: 'aaaa', path: 'p' }] }, { name: 'B', bundleId: 'b', tokens: [], scriptable: true }], mcp: [], clis: { count: 7, where: {} } });
  const c = mapCounts(map);
  assert.equal(c.apps, 2); assert.equal(c.direct, 1); assert.equal(c.gaps, 1); assert.equal(c.applescript, 1); assert.equal(c.clis, 7);
  assert.deepEqual(appRoutes({ name: 'X', tokens: ['xx'], webApp: true }).gap, true, 'a web app driven through Chrome is still searched for a tool of its own');
});

test('candidates: the app must be in the tool\'s NAME (a passing mention is not enough); Apple\'s apps need apple or mac; consent persists', async () => {
  const { concernsApp, searchTerms } = await import('../lib/device-candidates.mjs');
  const spotify = { name: 'Spotify', bundleId: 'com.spotify.client', tokens: ['spotify'] };
  assert.equal(concernsApp({ name: 'spotify-mcp', description: '' }, spotify), true);
  assert.equal(concernsApp({ name: 'skills', description: 'skills for spotify and more' }, spotify), false);
  const dev = { name: 'Developer', bundleId: 'developer.apple.wwdc-Release', tokens: ['developer'] };
  assert.equal(concernsApp({ name: 'amazon-q-developer-cli', description: 'Amazon Q' }, dev), false, 'an Apple app needs apple or mac');
  assert.equal(concernsApp({ name: 'apple-notes-mcp', description: 'Apple Notes on macOS' }, { name: 'Notes', bundleId: 'com.apple.Notes', tokens: ['notes'] }), true);
  assert.equal(searchTerms({ name: 'DuckDuckGo 2', bundleId: 'com.duckduckgo.mobile.ios', tokens: ['duckduckgo'] }).github, 'duckduckgo');
  const edit = { name: 'Edit', bundleId: 'com.sony.Edit', tokens: ['edit'] };
  assert.equal(concernsApp({ name: 'editor', description: 'a text editor' }, edit), false, '"edit" is not "editor"');
  assert.equal(concernsApp({ name: 'mcp-remote', description: 'remote MCP proxy' }, { name: 'Remote', bundleId: 'com.sony.Remote', tokens: ['remote'] }), false, 'an everyday name needs its maker');
  assert.equal(concernsApp({ name: 'sony-remote-mcp', description: '' }, { name: 'Remote', bundleId: 'com.sony.Remote', tokens: ['remote'] }), true);
  assert.equal(searchTerms({ name: 'Viewer', bundleId: 'com.sony.Viewer', tokens: ['viewer'] }).github, 'sony viewer');
  assert.equal(concernsApp({ name: 'go-whatsapp-web-multidevice', description: '' }, { name: 'WhatsApp', bundleId: '', tokens: ['whatsapp'] }), true);
  assert.equal(concernsApp({ name: 'iterm-mcp', description: '' }, { name: 'iTerm', bundleId: 'com.googlecode.iterm2', tokens: ['iterm', 'iterm2'] }), true);
  // A repo that publishes itself on npm becomes installable at npm's exact latest version; a look-alike name is refused.
  const { npmPackageForRepo } = await import('../lib/device-candidates.mjs');
  const npmFetch = (repoUrl) => async (url) => {
    if (url === 'https://raw.githubusercontent.com/a/spotify-mcp/HEAD/package.json') return new Response(JSON.stringify({ name: '@a/spotify-mcp' }), { status: 200 });
    if (url === 'https://registry.npmjs.org/@a%2Fspotify-mcp/latest') return new Response(JSON.stringify({ version: '1.4.2', repository: { url: repoUrl } }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  assert.deepEqual(await npmPackageForRepo('a/spotify-mcp', { fetchImpl: npmFetch('git+https://github.com/a/spotify-mcp.git') }), { type: 'npm', name: '@a/spotify-mcp', version: '1.4.2' });
  assert.equal(await npmPackageForRepo('a/spotify-mcp', { fetchImpl: npmFetch('git+https://github.com/evil/spotify-mcp.git') }), null, 'npm must point back at the same repo');
  assert.equal(await npmPackageForRepo('a/spotify-mcp', { fetchImpl: npmFetch('git+https://github.com/a/spotify-mcp-fork.git') }), null);
  // Proposals made under a looser rule are dropped on the next run; installed ones stay.
  const stale = { apps: [{ ...dev, gap: true }], candidates: { searched: { [dev.bundleId]: { at: new Date().toISOString() } } }, proposals: [
    { id: 'aso-skills', name: 'aso-skills', app: 'Developer', bundleId: dev.bundleId, state: 'proposed', description: 'developer tools' },
    { id: 'kept', name: 'amazon-q-developer-cli', app: 'Developer', bundleId: dev.bundleId, state: 'installed' },
  ] };
  await findCandidates({ map: stale, fetchImpl: async () => { throw new Error('no network expected'); }, sleep: async () => {} });
  assert.deepEqual(stale.proposals.map((p) => p.id), ['kept']);
  const f = deskFixture({ map: { schema: MAP_SCHEMA, apps: [], phases: {} } });
  f.desk.setConsent(true, 'typed');
  assert.equal(readDeviceMap(f.file).candidates.consent.granted, true);
  f.desk.setConsent(false, 'spoken');
  assert.equal(readDeviceMap(f.file).candidates.consent.granted, false);
});

test('session: an answer that only says it cannot is followed by what Ghost CAN do; the doctor shows the scan', async () => {
  const lines = [];
  const session = createOwnerSession({
    port: 3001, secrets: { nonce: 'n'.repeat(64) }, runtimeHome: null, voiceOut: false, out: (l) => lines.push(l),
    turnImpl: async () => ({ ok: true, spoken: "I can't control Spotify.", raw: { ok: true, data: {} } }),
    capabilityLine: (text, spoken) => (/spotify/i.test(text) && /can't/.test(spoken) ? 'I can still drive Spotify with the Hands of Horus right now.' : null),
  });
  await session.runTurn('pause spotify', { owner: true });
  assert.equal(lines.at(-1), "  ◆ I can't control Spotify. I can still drive Spotify with the Hands of Horus right now.");
  assert.match(deviceDoctorLines(null)[0], /not run yet/);
  const map = buildCapabilities({ schema: MAP_SCHEMA, scannedAt: '2026-10-08T09:00:00Z', complete: true, apps: [{ name: 'B', bundleId: 'b', tokens: [], scriptable: true }], mcp: [], clis: { count: 9, where: {} }, keys: { found: 3, byProvider: { cloudflare: 1, 'ronin-crm': 1, openaleph: 1 }, freeTier: { gaps: ['groq'], labels: ['Groq'] } } });
  const doc = deviceDoctorLines(map).join('\n');
  assert.match(doc, /1 apps, 0 direct .* 9 CLIs, 0 MCP servers; 1 gaps, 0 tools proposed \(online search off/);
  assert.match(doc, /API keys on this Mac: 3 for .*not in the vault yet.*free APIs with no key: Groq/);
});

test('acquire: a proposal goes to Kingmaker\'s acquisition loop as a neutral gap label, never run as-is', async () => {
  const { handOffToAcquisition, acquisitionReadBack } = await import('../lib/device-tools.mjs');
  let posted = null;
  const r = await handOffToAcquisition({ port: 1, nonce: 'n'.repeat(64), proposal: { name: '@x/spotify-mcp', app: 'Spotify', repo: 'https://github.com/x/spotify-mcp' },
    fetchImpl: async (url, init) => { posted = { url: String(url), body: JSON.parse(init.body) }; return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }); } });
  assert.equal(r.ok, true);
  assert.match(posted.url, /\/api\/capability-acquisition\/gaps\/signal$/);
  assert.deepEqual(posted.body, { capability: 'Spotify control (CLI or MCP)', surface: 'kingmaker-device-scan' }, 'only the neutral label leaves; no repo, no request text');
  assert.match(acquisitionReadBack({ name: 'gh-x', app: 'Notes', license: 'MIT', repo: 'https://github.com/a/gh-x' }), /I don't run outside code as-is/);
});


test('a cached map from an older Kingmaker: a route kind it renamed reads as the engine route, never a missing one', () => {
  const old = { schema: MAP_SCHEMA, apps: [{ name: 'Blender', bundleId: 'org.blenderfoundation.blender', routes: [{ kind: 'renamed-engine-route', via: 'engine', detail: 'its Blender engine' }, { kind: 'hands', via: 'hands' }] }] };
  const m = readDeviceMap('/x', () => JSON.stringify(old));
  assert.equal(m.apps[0].routes[0].kind, 'engine');
  assert.equal(m.apps[0].routes[1].kind, 'hands');
  const line = closestCapabilityLine(m, 'open Blender and make a cube', "I can't do that.");
  assert.ok(line == null || /its Blender engine|Hands of Horus/.test(line), String(line));
});
