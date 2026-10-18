import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BACKEND_RESPAWN_DELAYS_MS, CRASH_LOGS_KEPT, keepCrashLog, planBackendRespawn, superviseBackend } from '../lib/runtime.mjs';

/** A started backend whose exit and readiness the test controls. */
function fakeBackend(pid, { ready = Promise.resolve() } = {}) {
  let resolveExit;
  const exited = new Promise((r) => { resolveExit = r; });
  const child = { pid, exitCode: null, signalCode: null, kill: () => { child.signalCode = 'SIGKILL'; resolveExit({ code: null, signal: 'SIGKILL' }); } };
  const b = {
    child, ready, exited, stopped: 0,
    crash(code = 1) { child.exitCode = code; resolveExit({ code, signal: null }); },
    stop: async () => { b.stopped += 1; if (child.exitCode === null && child.signalCode === null) { child.signalCode = 'SIGTERM'; resolveExit({ code: null, signal: 'SIGTERM' }); } return exited; },
  };
  ready.catch(() => {});
  return b;
}

/** Manual clock + timer queue: run() fires what the supervisor scheduled. */
function harness({ verify = async () => true, portFree = async () => true, relaunchFails = false } = {}) {
  let clock = 1_000_000;
  const timers = [];
  const events = [];
  const launched = [];
  const first = fakeBackend(100);
  const sup = superviseBackend(first, {
    relaunch: async () => { if (relaunchFails) throw new Error('spawn failed'); const b = fakeBackend(101 + launched.length); launched.push(b); return b; },
    onEvent: (name, d) => events.push({ name, ...d }),
    isPortFree: portFree,
    verify,
    now: () => clock,
    schedule: (fn, ms) => { const t = { fn, ms, cancelled: false }; timers.push(t); return t; },
    cancel: (t) => { t.cancelled = true; },
  });
  const settle = () => new Promise((r) => setImmediate(r));
  return {
    sup, first, events, launched, timers,
    advance(ms) { clock += ms; },
    async fire() { const t = timers.shift(); if (t && !t.cancelled) t.fn(); for (let i = 0; i < 5; i += 1) await settle(); },
    settle: async () => { for (let i = 0; i < 5; i += 1) await settle(); },
  };
}

test('respawn plan: the window app\'s numbers (1 s, 3 s, 9 s; give up on the 4th crash within a minute)', () => {
  let times = [];
  const delays = [];
  for (let i = 0; i < 3; i += 1) {
    const p = planBackendRespawn(times, 10_000 + i * 1_000);
    assert.equal(p.respawn, true);
    delays.push(p.delayMs);
    times = p.crashTimes;
  }
  assert.deepEqual(delays, [...BACKEND_RESPAWN_DELAYS_MS]);
  const fourth = planBackendRespawn(times, 14_000);
  assert.equal(fourth.respawn, false);
  assert.equal(fourth.crashes, 4);
  // Crashes older than the window no longer count.
  assert.equal(planBackendRespawn([0, 1_000, 2_000], 70_000).respawn, true);
  // Five healthy minutes earn a fresh budget even with three recent crashes on record.
  const fresh = planBackendRespawn([100_000, 101_000, 102_000], 450_000, { healthySince: 140_000 });
  assert.equal(fresh.respawn, true);
  assert.equal(fresh.delayMs, 1_000);
});

test('a core that dies after launch is restarted with this launch\'s relaunch, re-verified, then reported back', async () => {
  const h = harness();
  h.first.crash(1);
  await h.settle();
  assert.deepEqual(h.events.map((e) => e.name), ['restarting']);
  assert.equal(h.events[0].delayMs, 1_000);
  assert.equal(h.timers[0].ms, 1_000);
  await h.fire();
  assert.equal(h.launched.length, 1);
  assert.deepEqual(h.events.map((e) => e.name), ['restarting', 'respawned', 'recovered']);
  assert.equal(h.sup.current, h.launched[0]);
});

test('an intentional stop is never respawned, and a pending respawn is cancelled', async () => {
  const h = harness();
  await h.sup.stop();
  await h.settle();
  assert.equal(h.first.stopped, 1);
  assert.deepEqual(h.events, [], 'stopping on purpose says nothing and schedules nothing');

  const h2 = harness();
  h2.first.crash(1);
  await h2.settle();
  await h2.sup.stop();
  assert.equal(h2.timers[0].cancelled, true);
  await h2.fire();
  assert.equal(h2.launched.length, 0, 'the cancelled respawn never ran');
});

test('repeated fast crashes: three restarts, then it gives up once and stays down', async () => {
  const h = harness();
  h.first.crash(1);
  await h.settle();
  for (let i = 0; i < 3; i += 1) {
    await h.fire();
    h.advance(2_000);
    h.sup.current.crash(1);
    await h.settle();
  }
  const names = h.events.map((e) => e.name);
  assert.equal(names.filter((n) => n === 'restarting').length, 3);
  assert.equal(names.filter((n) => n === 'gave_up').length, 1);
  assert.equal(names.at(-1), 'gave_up');
  assert.match(h.events.at(-1).reason, /4 times within a minute/);
  assert.equal(h.sup.gaveUp, true);
  assert.equal(h.timers.length, 0, 'nothing more is scheduled after giving up');
});

test('fail closed: a respawned core without its rules is stopped and not respawned', async () => {
  const h = harness({ verify: async () => false });
  h.first.crash(1);
  await h.settle();
  await h.fire();
  assert.deepEqual(h.events.map((e) => e.name), ['restarting', 'respawned', 'gave_up']);
  assert.equal(h.launched[0].stopped, 1);
  await h.settle();
  assert.equal(h.events.filter((e) => e.name === 'restarting').length, 1, 'its stop is not a crash');
});

test('a port held by something else is never fought over: it gives up instead', async () => {
  const h = harness({ portFree: async () => false });
  h.first.crash(1);
  await h.settle();
  await h.fire();
  assert.equal(h.launched.length, 0);
  assert.equal(h.events.at(-1).name, 'gave_up');
  assert.match(h.events.at(-1).reason, /port/);
});

test('a relaunch that cannot start gives up with the reason', async () => {
  const h = harness({ relaunchFails: true });
  h.first.crash(1);
  await h.settle();
  await h.fire();
  assert.equal(h.events.at(-1).name, 'gave_up');
  assert.match(h.events.at(-1).reason, /spawn failed/);
});

test('crash logs: what the dead core printed is kept, newest five', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sg-logs-'));
  for (let i = 0; i < 7; i += 1) {
    writeFileSync(join(dir, 'server.log'), `crash ${i}`);
    assert.ok(keepCrashLog(dir, { at: new Date(Date.UTC(2026, 9, 7, 12, 0, i)) }));
  }
  const kept = readdirSync(dir).filter((n) => n.startsWith('server-crash-')).sort();
  assert.equal(kept.length, CRASH_LOGS_KEPT);
  assert.match(kept.at(-1), /12-00-06/);
  assert.equal(keepCrashLog(dir), null, 'no server.log, nothing to keep');
});
