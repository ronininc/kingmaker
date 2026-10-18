// The bar link key is never on a command line: every process the companion spawns (openssl, scutil, the by-hand opener)
// is recorded here, and none has the key in its argv. Inside the engine a phone's turn spawns nothing at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Record every spawn before lib/phone-companion.mjs is loaded (it imports execFile and execFileSync).
const spawned = [];
for (const name of ['execFile', 'execFileSync', 'spawn', 'spawnSync', 'exec', 'execSync']) {
  const real = cp[name];
  cp[name] = function recorded(file, args, ...rest) { spawned.push([String(file), ...(Array.isArray(args) ? args.map(String) : [])]); return real.call(this, file, args, ...rest); };
}
syncBuiltinESMExports();
const { createCompanion } = await import('../lib/phone-companion.mjs');

function call(ca, { port, method = 'GET', path, body = null, cookie = null }) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, ca, agent: false, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) } }, (res) => {
      let data = ''; res.setEncoding('utf8'); res.on('data', (d) => { data += d; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: data }));
    });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
}
async function pairedPhone(companion, ca, port) {
  const { link } = companion.pairLink();
  const r = await call(ca, { port, path: `/?pair=${/#pair=([a-f0-9]{32})$/.exec(link)[1]}` });
  return /km=[a-f0-9]{48}/.exec(String(r.headers['set-cookie']))[0];
}

test('inside the engine a phone turn goes to onTurn in-process: no URL, no spawn, no key made', { timeout: 60_000 }, async (t) => {
  const state = mkdtempSync(join(tmpdir(), 'km-argv-engine-'));
  const turns = [];
  const companion = createCompanion({ state, port: 0, setupPort: 0, host: 'localhost', icon: null, onTurn: (text) => { turns.push(text); } });
  t.after(async () => { await companion.stop(); rmSync(state, { recursive: true, force: true }); });
  const port = Number(new URL((await companion.start()).app).port), ca = readFileSync(join(state, 'phone-tls', 'ca.pem'));
  const phone = await pairedPhone(companion, ca, port);
  const before = spawned.length;
  assert.equal((await call(ca, { port, method: 'POST', path: '/turn', cookie: phone, body: { text: 'what is on my calendar' } })).status, 200);
  assert.deepEqual(turns, ['what is on my calendar']);
  assert.equal(spawned.length, before, 'a phone turn spawns nothing');
  assert.throws(() => readFileSync(join(state, 'bar-link.key')), /ENOENT/, 'the engine path never needs the bar key');
});

test('a refused in-process turn answers 503', { timeout: 60_000 }, async (t) => {
  const state = mkdtempSync(join(tmpdir(), 'km-argv-refuse-'));
  const companion = createCompanion({ state, port: 0, setupPort: 0, host: 'localhost', icon: null, onTurn: () => { throw new Error('Kingmaker runs without its bar'); } });
  t.after(async () => { await companion.stop(); rmSync(state, { recursive: true, force: true }); });
  const port = Number(new URL((await companion.start()).app).port), ca = readFileSync(join(state, 'phone-tls', 'ca.pem'));
  const phone = await pairedPhone(companion, ca, port);
  assert.equal((await call(ca, { port, method: 'POST', path: '/turn', cookie: phone, body: { text: 'hi' } })).status, 503);
});

test('by hand, the bar URL (with its key) goes to the opener on stdin; no spawned argv has the key', { timeout: 60_000 }, async (t) => {
  const state = mkdtempSync(join(tmpdir(), 'km-argv-hand-'));
  // A stand-in for /usr/bin/osascript: writes down its argv and stdin, opens nothing.
  const fake = join(state, 'osascript'), argvOut = join(state, 'argv.txt'), stdinOut = join(state, 'stdin.txt');
  writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvOut}'\ncat > '${stdinOut}'\n`); chmodSync(fake, 0o755);
  const companion = createCompanion({ state, port: 0, setupPort: 0, host: 'localhost', icon: null, osascript: fake });
  t.after(async () => { await companion.stop(); rmSync(state, { recursive: true, force: true }); });
  const port = Number(new URL((await companion.start()).app).port), ca = readFileSync(join(state, 'phone-tls', 'ca.pem'));
  const key = readFileSync(join(state, 'bar-link.key'), 'utf8').trim();
  assert.match(key, /^[a-f0-9]{48}$/);
  const phone = await pairedPhone(companion, ca, port);
  assert.equal((await call(ca, { port, method: 'POST', path: '/turn', cookie: phone, body: { text: 'hello "bar"' } })).status, 200);

  assert.deepEqual(readFileSync(argvOut, 'utf8').trim().split('\n'), ['-l', 'JavaScript', '-'], 'the opener gets no URL on its command line');
  const script = readFileSync(stdinOut, 'utf8');
  assert.ok(script.includes(`kingmaker://bar?text=hello%20%22bar%22&key=${key}`), 'the URL goes on stdin');
  assert.match(script, /c\.activates=false/, 'it opens without taking focus');
  assert.ok(spawned.length > 0, 'spawns were recorded');
  for (const argv of spawned) assert.ok(!argv.join(' ').includes(key), `no argv carries the bar key: ${argv[0]}`);
});
