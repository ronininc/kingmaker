// The CRM marks Solomon offline when heartbeats stop. Kingmaker must POST only after Solomon
// answers on http://127.0.0.1:3301 — a live Kingmaker process is not a beat.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { superviseBackend } from '../lib/runtime.mjs';
import {
  CRM_HEARTBEAT_URL, HEARTBEAT_INTERVAL_MS, SOLOMON_LIVENESS_URL, SOLOMON_LOOPBACK,
  beatOnce, pickHeartbeatToken, resolveHeartbeatToken, startSolomonHeartbeat,
} from '../lib/solomon-heartbeat.mjs';

const DESK = 'ronin_desk_kingmaker_desk_token_value';
const SOLOMON = 'ronin_solomon_issued_token_value';
const KING = 'ronin_king_oversight_token_value';

function mockFetch(solomon = 'up') {
  const calls = [];
  const state = { solomon };
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, authorization: init?.headers?.authorization, body: init?.body });
    if (String(url).startsWith(SOLOMON_LOOPBACK)) {
      if (state.solomon === 'refused') throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3301'), { code: 'ECONNREFUSED' });
      if (state.solomon === 'down') return { ok: false, status: 503 };
      return { ok: true, status: 200 };
    }
    return { ok: true, status: 200 };
  };
  return { calls, state, fetchImpl, crm: () => calls.filter((c) => c.url === CRM_HEARTBEAT_URL) };
}

test('a beat is POST /api/kingmaker/solomon/heartbeat only after Solomon answers on :3301', async () => {
  const up = mockFetch('up');
  const beat = await beatOnce({ fetchImpl: up.fetchImpl, token: DESK });
  assert.equal(beat.beat, true);
  assert.equal(beat.kind, 'desk');
  assert.equal(beat.ok, true);
  assert.equal(up.calls[0].url, SOLOMON_LIVENESS_URL);
  assert.equal(up.calls[0].method, 'GET');
  assert.equal(up.crm().length, 1);
  const posted = up.crm()[0];
  assert.equal(posted.method, 'POST');
  assert.equal(posted.authorization, `Bearer ${DESK}`);
  assert.deepEqual(JSON.parse(posted.body), { solomon: SOLOMON_LOOPBACK });
  assert.equal(posted.url, 'https://www.ronininc.org/api/kingmaker/solomon/heartbeat');
});

test('Solomon down, refused, or not on :3301 stays silent — a live Kingmaker process does not beat', async () => {
  for (const solomon of ['down', 'refused']) {
    const net = mockFetch(solomon);
    const beat = await beatOnce({ fetchImpl: net.fetchImpl, token: DESK, processUp: true, kingmakerPid: 4242 });
    assert.equal(beat.beat, false);
    assert.equal(beat.reason, 'solomon-down');
    assert.equal(net.crm().length, 0, solomon);
    assert.equal(net.calls.length, 1);
    assert.equal(net.calls[0].url, SOLOMON_LIVENESS_URL);
  }
  let called = false;
  const refused = await beatOnce({
    token: DESK,
    livenessUrl: 'http://127.0.0.1:3001/api/health',
    fetchImpl: () => { called = true; return { ok: true, status: 200 }; },
  });
  assert.equal(refused.beat, false);
  assert.equal(refused.reason, 'refused-probe');
  assert.equal(called, false, 'the engine on :3001 is not Solomon on :3301');
});

test('token preference is kingmaker desk, then an issued Solomon token, then ronin_king_', async () => {
  assert.equal(pickHeartbeatToken([
    { token: KING }, { token: SOLOMON }, { kind: 'desk', token: DESK },
  ]).kind, 'desk');
  assert.equal(pickHeartbeatToken([{ token: KING }, { token: SOLOMON }]).token, SOLOMON);
  assert.equal(pickHeartbeatToken([{ token: KING }]).kind, 'king');
  assert.equal(pickHeartbeatToken([{ token: 'not-a-crm-token' }, { kind: 'desk', token: SOLOMON }]), null);
  assert.equal(pickHeartbeatToken([{ token: 'ronin_desk_some_other_desk' }]), null, 'an unmarked desk token is not the kingmaker desk');

  const env = { KINGMAKER_DESK_TOKEN: DESK, SOLOMON_TOKEN: SOLOMON, RONIN_KING_TOKEN: KING };
  assert.equal(resolveHeartbeatToken({ env }).token, DESK);
  assert.equal(resolveHeartbeatToken({ env: { RONIN_KING_TOKEN: KING } }).kind, 'king');
  assert.equal(resolveHeartbeatToken({ env: { SOLOMON_ISSUED_TOKEN: SOLOMON, RONIN_KING_TOKEN: KING } }).token, SOLOMON);

  const dir = mkdtempSync(join(tmpdir(), 'km-heart-'));
  mkdirSync(join(dir, 'crm'));
  writeFileSync(join(dir, 'crm-credentials.json'), JSON.stringify({
    credentials: [
      { grant: 'desk:muse', desk: 'muse', token: 'ronin_desk_muse_other' },
      { grant: 'desk:kingmaker', desk: 'kingmaker', token: DESK },
      { token: KING },
    ],
  }));
  assert.equal(resolveHeartbeatToken({ state: dir, env: {} }).token, DESK);
  writeFileSync(join(dir, 'crm', 'solomon.token'), `${SOLOMON}\n`);
  assert.equal(resolveHeartbeatToken({
    state: dir,
    env: {},
    readFile: (p) => p.endsWith('solomon.token') ? SOLOMON : '',
  }).token, SOLOMON);
});

test('a real Solomon on 127.0.0.1:3301 is probed; closing it stops the beat', async (t) => {
  const server = createServer((req, res) => {
    assert.equal(req.url, '/api/health');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(3301, '127.0.0.1', resolve);
    });
  } catch (error) {
    if (error?.code === 'EADDRINUSE') { server.close(); return t.skip('127.0.0.1:3301 is already in use'); }
    throw error;
  }
  const crm = [];
  const fetchImpl = async (url, init) => {
    if (String(url).startsWith(SOLOMON_LOOPBACK)) return fetch(url, init);
    crm.push({ url: String(url), authorization: init?.headers?.authorization, origin: init?.headers?.origin });
    return { ok: true, status: 200 };
  };
  try {
    const up = await beatOnce({ fetchImpl, token: DESK });
    assert.equal(up.beat, true);
    assert.equal(crm.length, 1);
    assert.equal(crm[0].url, CRM_HEARTBEAT_URL);
    assert.equal(crm[0].authorization, `Bearer ${DESK}`);
    assert.equal(crm[0].origin, undefined);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  const down = await beatOnce({ fetchImpl, token: DESK, processUp: true });
  assert.equal(down.beat, false);
  assert.equal(down.reason, 'solomon-down');
  assert.equal(crm.length, 1, 'Solomon gone: no second POST, even though this process is still running');
});

test('the supervisor pulse beats on Solomon\'s answer and stays silent when Solomon is down', async () => {
  const net = mockFetch('up');
  const timers = [];
  const logs = [];
  const pulse = startSolomonHeartbeat({
    env: { KINGMAKER_DESK_TOKEN: DESK, RONIN_KING_TOKEN: KING },
    fetchImpl: net.fetchImpl,
    log: (event, detail) => logs.push({ event, detail }),
    schedule: (fn, ms) => { const t = { fn, ms, cancelled: false }; timers.push(t); return t; },
    cancel: (t) => { t.cancelled = true; },
  });
  for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r));
  assert.equal(net.crm().length, 1);
  assert.equal(net.crm()[0].authorization, `Bearer ${DESK}`);
  assert.equal(timers[0].ms, HEARTBEAT_INTERVAL_MS);
  assert.equal(logs[0].event, 'solomon_heartbeat');
  assert.equal(logs[0].detail.beat, true);
  assert.equal(JSON.stringify(logs).includes(DESK), false, 'the token is not logged');

  net.state.solomon = 'refused';
  timers[0].fn();
  for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r));
  assert.equal(net.crm().length, 1, 'a later cycle with Solomon down does not POST');
  assert.equal(logs.at(-1).detail.reason, 'solomon-down');

  const queued = timers.at(-1);
  pulse.stop();
  assert.equal(queued.cancelled, true);
  queued.fn();
  for (let i = 0; i < 4; i += 1) await new Promise((r) => setImmediate(r));
  assert.equal(net.crm().length, 1, 'stop ends the pulse');
});

test('superviseBackend owns the pulse: crashing the child is not a beat, and stop silences it', async () => {
  const net = mockFetch('refused');
  const timers = [];
  let resolveExit;
  const exited = new Promise((r) => { resolveExit = r; });
  const child = { pid: 7, exitCode: null, signalCode: null, kill() {} };
  const first = { child, ready: Promise.resolve(), exited, stop: async () => exited };
  const sup = superviseBackend(first, {
    relaunch: async () => first,
    schedule: (fn, ms) => { const t = { fn, ms, cancelled: false }; timers.push(t); return t; },
    cancel: (t) => { t.cancelled = true; },
    heartbeat: {
      env: { SOLOMON_TOKEN: SOLOMON },
      fetchImpl: net.fetchImpl,
      schedule: (fn, ms) => { const t = { fn, ms, cancelled: false }; timers.push(t); return t; },
      cancel: (t) => { t.cancelled = true; },
    },
  });
  for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r));
  assert.equal(net.crm().length, 0);
  assert.equal(net.calls[0].url, SOLOMON_LIVENESS_URL);

  child.exitCode = 1;
  resolveExit({ code: 1, signal: null });
  for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r));
  assert.equal(net.crm().length, 0, 'the supervised process dying does not POST, and staying up would not either');

  net.state.solomon = 'up';
  const heart = timers.find((t) => t.ms === HEARTBEAT_INTERVAL_MS);
  assert.ok(heart, 'the pulse is on the supervisor\'s clock');
  heart.fn();
  for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r));
  assert.equal(net.crm().length, 1);
  assert.equal(net.crm()[0].authorization, `Bearer ${SOLOMON}`);

  const before = net.crm().length;
  await sup.stop();
  for (const t of timers) if (!t.cancelled) t.fn();
  for (let i = 0; i < 4; i += 1) await new Promise((r) => setImmediate(r));
  assert.equal(net.crm().length, before);
});
