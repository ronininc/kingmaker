import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeBackground, findKingmakerExecutable, runBackgroundCommand } from '../lib/background.mjs';
import { startHeadlessHostAssertion, startIdleSleepAssertion, withIdleSleepAssertion } from '../lib/power.mjs';

test('background service targets an installed Kingmaker app and invokes only a fixed flag', async () => {
  const home = mkdtempSync(join(tmpdir(), 'km-background-'));
  const app = join(home, 'Applications', 'Kingmaker.app');
  const binary = join(app, 'Contents', 'MacOS', 'Kingmaker');
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(binary, 'fixture');
  assert.deepEqual(findKingmakerExecutable({ home, env: {}, modulePath: '/src/lib/background.mjs' }), { app, binary });
  const calls = [];
  const result = await runBackgroundCommand('enable', {
    home, env: {}, modulePath: '/src/lib/background.mjs',
    run: (cmd, args, opts, cb) => {
      calls.push({ cmd, args, opts });
      const at = args.indexOf('--background-result-file');
      if (at >= 0) writeFileSync(args[at + 1], JSON.stringify({ status: 'enabled', message: '' }));
      cb(null, '', '');
    },
  });
  assert.equal(result.ok, true);
  assert.equal(calls[0].cmd, '/usr/bin/open');
  assert.deepEqual(calls[0].args.slice(0, 5), ['-W', '-n', app, '--args', '--background-enable']);
  assert.equal(calls[0].args.at(-2), '--background-result-file');
  assert.deepEqual(calls[1].args, [app], 'enable launches the registered host immediately');
  assert.match(describeBackground(result), /lid open/);
  assert.match(describeBackground(result), /display may sleep/);
  assert.match(describeBackground({ ok: true, status: 'not-found' }), /disabled/);
  assert.equal((await runBackgroundCommand('erase-everything', { home, env: {}, modulePath: '/src/lib/background.mjs' })).ok, false);
});

test('power assertion prevents idle system sleep only for the scoped work', async () => {
  const calls = []; let killed = null;
  const fake = {
    unref() { calls.push('unref'); },
    on() {},
    kill(signal) { killed = signal; },
  };
  const assertion = startIdleSleepAssertion({ platform: 'darwin', pid: 42, run: (bin, args, opts) => { calls.push({ bin, args, opts }); return fake; } });
  assert.equal(assertion.active, true);
  assert.deepEqual(calls[0].args, ['-i', '-w', '42']);
  assert.ok(!calls[0].args.includes('-d'), 'display sleep remains allowed');
  assertion.release();
  assert.equal(killed, 'SIGTERM');
  await assert.rejects(withIdleSleepAssertion(async () => { throw new Error('turn failed'); }, { platform: 'darwin', pid: 42, run: () => fake }), /turn failed/);
});

test('headless host assertion holds system awake on AC while display sleep stays allowed', () => {
  const calls = [];
  const fake = { unref() {}, on() {}, kill() {} };
  const assertion = startHeadlessHostAssertion({ platform: 'darwin', pid: 99, run: (bin, args, opts) => { calls.push({ bin, args, opts }); return fake; } });
  assert.equal(assertion.active, true);
  assert.deepEqual(calls[0].args, ['-s', '-w', '99']);
  assert.ok(!calls[0].args.includes('-d'));
});

test('the menu-bar app uses the supported login-item API and states the sleep boundary', () => {
  const swift = readFileSync(new URL('../app/Kingmaker.swift', import.meta.url), 'utf8');
  assert.match(swift, /SMAppService\.mainApp/);
  assert.match(swift, /service\.register\(\)/);
  assert.match(swift, /service\.unregister\(\)/);
  assert.match(swift, /KINGMAKER_HEADLESS_HOST_MODE/);
  const bundle = JSON.parse(readFileSync(new URL('../app/bundle.json', import.meta.url), 'utf8'));
  assert.ok(bundle.frameworks.includes('ServiceManagement'));
});
