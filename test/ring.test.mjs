import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { findRingApp, startRing, voicePlan } from '../lib/ring.mjs';
import { isolatedRun, resolvePaths } from '../lib/paths.mjs';

const EXE = 'Contents/MacOS/Kingmaker';
const LEGACY_EXE = 'Contents/MacOS/Sol Ghost';

test('ring app: an explicit SOL_GHOST_RING_APP is the only ring; else bundle, ~/Applications, /Applications, dev build', () => {
  const moduleDir = '/X/Kingmaker.app/Contents/Resources/sol-ghost/lib';
  const all = new Set([`/X/Kingmaker.app/${EXE}`, `/Users/o/Applications/Kingmaker.app/${EXE}`, `/Applications/Kingmaker.app/${EXE}`]);
  const exists = (p) => all.has(p);
  assert.equal(findRingApp({ os: 'darwin', home: '/Users/o', exists, moduleDir, env: {} }), `/X/Kingmaker.app/${EXE}`, 'inside a bundle, its own menu bar agent');
  assert.equal(findRingApp({ os: 'darwin', home: '/Users/o', exists, moduleDir: '/src/kingmaker/lib', env: {} }), `/Users/o/Applications/Kingmaker.app/${EXE}`, 'from a checkout, the installed app');
  assert.equal(findRingApp({ os: 'darwin', home: '/Users/o', exists: (p) => p === `/src/kingmaker/dist/Kingmaker.app/${EXE}`, moduleDir: '/src/kingmaker/lib', env: {} }), `/src/kingmaker/dist/Kingmaker.app/${EXE}`, 'or the dev build');
  assert.equal(findRingApp({ os: 'darwin', home: '/Users/o', exists: (p) => p === `/Users/o/Applications/Sol Ghost.app/${LEGACY_EXE}`, moduleDir: '/src/kingmaker/lib', env: {} }), `/Users/o/Applications/Sol Ghost.app/${LEGACY_EXE}`, 'a Mac not yet reinstalled: the old Sol Ghost.app');
  assert.equal(findRingApp({ os: 'darwin', home: '/Users/o', exists: (p) => p === `/Y/Sol Ghost.app/${LEGACY_EXE}`, moduleDir, env: { SOL_GHOST_RING_APP: '/Y/Sol Ghost.app' } }), `/Y/Sol Ghost.app/${LEGACY_EXE}`, 'an explicit old app keeps its old executable name');
  assert.equal(findRingApp({ os: 'darwin', home: '/Users/o', exists, moduleDir, env: { SOL_GHOST_RING_APP: '/nope/Ring.app' } }), null, 'an explicit ring that is missing is no ring, never a silent fallback');
  assert.equal(findRingApp({ os: 'linux', home: '/home/o', exists: () => true, moduleDir, env: {} }), null, 'no ring off macOS');
});

function fakeRing({ ready = true, exitEarly = false } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stdin = new PassThrough();
  child.pid = 4242;
  const written = [];
  child.stdin.on('data', (d) => written.push(...String(d).split('\n').filter(Boolean)));
  child.kill = () => { setImmediate(() => child.emit('exit', null, 'SIGTERM')); };
  child.stdin.on('finish', () => setImmediate(() => child.emit('exit', 0, null)));
  setImmediate(() => {
    if (exitEarly) child.emit('exit', 1, null);
    else if (ready) child.stdout.write('@@glow ready windows=[11, 12, 13, 14]\n');
  });
  return { child, written, spawnImpl: (bin, args, opts) => { child.opts = opts; return child; } };
}

test('startRing: waits for "@@glow ready", then feeds it @@ghost lines; closing stdin ends it', async () => {
  const f = fakeRing();
  const lines = [];
  const ring = await startRing({ binary: '/ring', spawnImpl: f.spawnImpl, onLine: (l) => lines.push(l) });
  assert.equal(ring.ok, true);
  assert.equal(f.child.opts.env.SOL_GHOST_GLOW_ATTACH, '1', 'the app runs in attach mode (it starts no engine)');
  ring.send('speaking');
  ring.send('awake', { voiceApproves: true });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(f.written, ['@@ghost {"state":"speaking"}', '@@ghost {"state":"awake","voiceApproves":true}']);
  assert.deepEqual(lines, ['@@glow ready windows=[11, 12, 13, 14]']);
  ring.stop();
  assert.deepEqual(await ring.exited, { code: 0, signal: null });
});

test('startRing: no binary, a ring that never says ready, or one that dies first is NOT a ring', async () => {
  assert.equal((await startRing({ binary: null })).ok, false);
  const silent = fakeRing({ ready: false });
  const timedOut = await startRing({ binary: '/ring', spawnImpl: silent.spawnImpl, timeoutMs: 30 });
  assert.equal(timedOut.ok, false);
  assert.match(timedOut.reason, /did not come up/);
  const dead = fakeRing({ exitEarly: true });
  const died = await startRing({ binary: '/ring', spawnImpl: dead.spawnImpl });
  assert.equal(died.ok, false);
  assert.match(died.reason, /exited before it was ready/);
});

test('voice never runs without the ring outside the app', () => {
  assert.deepEqual(voicePlan({ wantsVoice: false, agent: false, ring: null }), { listening: false, line: null });
  assert.deepEqual(voicePlan({ wantsVoice: true, agent: true, ring: null }), { listening: true, line: null }, 'under Sol Ghost.app the app is the ring');
  assert.deepEqual(voicePlan({ wantsVoice: true, agent: false, ring: { ok: true } }), { listening: true, line: null });
  const off = voicePlan({ wantsVoice: true, agent: false, ring: { ok: false, reason: 'the ring did not come up within 10 s' } });
  assert.equal(off.listening, false);
  assert.match(off.line, /never runs without the ring, and the ring did not come up/);
});

test('cli: the only way voice turns on is the ring plan, and the ring follows every state', () => {
  const all = readFileSync(new URL('../lib/cli.mjs', import.meta.url), 'utf8');
  const src = all.slice(all.indexOf('async function cmdStart('), all.indexOf('export function savedVoiceAuthority('));
  assert.ok(src.length > 1000, 'found the start command');
  assert.match(src, /const listening = plan\.listening;/);
  assert.equal((src.match(/\blistening\s*=(?!=)/g) ?? []).length, 1, 'nothing else assigns listening');
  assert.match(src, /else ring\?\.send\?\.\(look, extra\);/, 'every emitted state reaches the ring');
  assert.match(src, /ring\.exited\.then\(\(\) => \{[\s\S]{0,120}voice\?\.stop\?\.\(\)/, 'losing the ring stops the microphone');
});

test('a run with its own runtime home keeps its daemon file and logs there, never the operator\'s', () => {
  const sandbox = resolvePaths({ SOL_GHOST_RUNTIME_HOME: '/tmp/verify-home' }, '/Users/o', { exists: () => false });
  assert.equal(isolatedRun({ SOL_GHOST_RUNTIME_HOME: '/tmp/verify-home' }), true);
  assert.equal(sandbox.stateFile, '/tmp/verify-home/sol-ghost-daemon.json');
  assert.equal(sandbox.logs, '/tmp/verify-home/sol-ghost-logs');
  const normal = resolvePaths({}, '/Users/o', { exists: () => false });
  assert.equal(normal.stateFile, '/Users/o/Library/Application Support/sol-ghost/daemon.json');
  assert.equal(normal.logs, '/Users/o/Library/Application Support/sol-ghost/logs');
  const moved = resolvePaths({ SOL_GHOST_HOME: '/tmp/sg', SOL_GHOST_RUNTIME_HOME: '/tmp/rt' }, '/Users/o', { exists: () => false });
  assert.equal(moved.stateFile, '/tmp/sg/daemon.json', 'SOL_GHOST_HOME still moves everything');
});
