// GET /admin/metrics for the Ronin launcher's machine card (lib/bridge-metrics.mjs, lib/token-meter.mjs): measured
// token rates, this Mac's facts, the lanes and whether Ollama holds them, the engine's queue. Loopback only.
// Since the metered-doctrine rework (2026-11-14) the payload carries `device` (this Mac's measured facts)
// instead of `profile`: there is no per-Mac profile anymore — the lanes are the starter floor's picks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bridgeMetrics } from '../lib/bridge-metrics.mjs';
import { meter, meterSnapshot, resetMeter } from '../lib/token-meter.mjs';
import { createCompanion, lanIp } from '../lib/phone-companion.mjs';
import { FLOOR_ROLES } from '../lib/mac-profiles.mjs';

const MAC = { chip: 'M5 Pro', ramGb: 24, model: 'Mac17,1', bandwidth: 307 };
const fakeOllama = ({ tags = [], ps = [], down = false } = {}) => async (url) => {
  if (down) throw new Error('ECONNREFUSED');
  const body = url.endsWith('/api/tags') ? { models: tags.map((name) => ({ name })) } : { models: ps.map((name) => ({ name, model: name })) };
  return { ok: true, json: async () => body };
};

test('the meter: rates over recent real answers, short ones not timed, null before anything ran', () => {
  resetMeter();
  const empty = meterSnapshot();
  assert.equal(empty.decodeTokS, null); assert.equal(empty.prefillTokS, null); assert.equal(empty.generated, 0); assert.match(empty.since, /^\d{4}-\d\d-\d\dT/);
  meter({ eval_count: 100, eval_duration: 2e9, prompt_eval_count: 800, prompt_eval_duration: 1e9 });   // 50 tok/s, 800 tok/s
  meter({ eval_count: 3, eval_duration: 1e9, prompt_eval_count: 5, prompt_eval_duration: 1e9 });       // a router's lane: counted, not timed
  meter(null); meter({ message: { content: 'x' } });
  const s = meterSnapshot();
  assert.equal(s.decodeTokS, 50); assert.equal(s.prefillTokS, 800);
  assert.equal(s.generated, 103); assert.equal(s.prompt, 805);
  meter({ eval_count: 100, eval_duration: 1e9 });   // 100 tok/s: the window is 200 tokens in 3 s
  assert.equal(meterSnapshot().decodeTokS, 66.7);
  resetMeter();
});

test('metrics: version, device facts, the floor lanes with what Ollama holds, the queue and tokens from the engine', async (t) => {
  const state = mkdtempSync(join(tmpdir(), 'km-metrics-'));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const m = await bridgeMetrics({ state, macInfo: MAC, fetchImpl: fakeOllama({ tags: [FLOOR_ROLES.router, FLOOR_ROLES.writer, FLOOR_ROLES.vision], ps: [FLOOR_ROLES.router] }),
    jobs: () => ({ running: 1, queued: 0 }), tokens: () => ({ decodeTokS: 41.2, prefillTokS: 812, generated: 9, prompt: 10, since: '2026-10-15T00:00:00.000Z' }) });
  assert.deepEqual(Object.keys(m).sort(), ['at', 'device', 'jobs', 'kingmaker', 'lanes', 'tokens']);
  assert.ok(!('gpu' in m), 'no GPU numbers without a powermetrics grant');
  assert.ok(!('profile' in m), 'no profile: the class system is retired');
  assert.equal(m.kingmaker.version, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  assert.deepEqual(m.device, { chip: 'M5 Pro', ramGb: 24, model: 'Mac17,1' });
  assert.deepEqual(m.lanes.map((l) => l.role), ['router', 'writer', 'coder', 'vision', 'reasoning']);
  for (const l of m.lanes) assert.deepEqual(Object.keys(l).sort(), ['context', 'loaded', 'model', 'role']);
  const lane = Object.fromEntries(m.lanes.map((l) => [l.role, l]));
  assert.deepEqual(lane.router, { role: 'router', model: FLOOR_ROLES.router, context: null, loaded: true });
  assert.equal(lane.writer.loaded, false); assert.equal(lane.coder.model, FLOOR_ROLES.coder, 'not installed: the floor pick, shown as not loaded');
  assert.equal(lane.writer.context, 4096, 'the writer lane shows the calibration writer context (the 4096 default until the owner changes it)');
  assert.deepEqual(m.jobs, { running: 1, queued: 0 }); assert.equal(m.tokens.decodeTokS, 41.2);

  // The owner's choices: Customize → Router, and the writer's context. (A macProfile key left in an old
  // calibration.json is inert since the rework: normalize() drops it, nothing reads it.)
  writeFileSync(join(state, 'calibration.json'), JSON.stringify({ schema: 1, macProfile: { profile: '16' }, router: { model: 'qwen3:0.6b' }, writer: { context: 4096 } }));
  const o = await bridgeMetrics({ state, macInfo: MAC, fetchImpl: fakeOllama({ down: true }) });
  assert.equal(o.lanes[0].model, 'qwen3:0.6b'); assert.equal(o.lanes[1].context, 4096);
  assert.ok(o.lanes.every((l) => l.loaded === null), 'Ollama down: loaded is unknown, not false');
  assert.equal(o.jobs, null); assert.equal(o.tokens, null);
  assert.ok(!/key|token"|cookie|secret/i.test(JSON.stringify(o).replace(/"tokens"/, '')), 'nothing secret');
});

function call(ca, { host = '127.0.0.1', port, path }) {
  return new Promise((resolve, reject) => {
    const req = request({ host, port, path, ca, agent: false }, (res) => { let d = ''; res.setEncoding('utf8'); res.on('data', (x) => { d += x; }); res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(d); } catch { return null; } })() })); });
    req.on('error', reject); req.end();
  });
}

test('GET /admin/metrics on the bridge: the engine\'s provider, loopback only, 500 when it fails', { timeout: 60_000 }, async (t) => {
  const state = mkdtempSync(join(tmpdir(), 'km-metrics-route-'));
  let fail = false;
  const companion = createCompanion({ state, port: 0, setupPort: 0, host: 'localhost', icon: null, onTurn: () => {},
    metrics: async () => { if (fail) throw new Error('no'); return { at: 'now', kingmaker: { version: '9.9.9' }, device: null, lanes: [], jobs: { running: 0, queued: 2 }, tokens: null }; } });
  t.after(async () => { await companion.stop(); rmSync(state, { recursive: true, force: true }); });
  const port = Number(new URL((await companion.start()).app).port), ca = readFileSync(join(state, 'phone-tls', 'ca.pem'));
  const r = await call(ca, { port, path: '/admin/metrics' });
  assert.equal(r.status, 200); assert.deepEqual(r.json.jobs, { running: 0, queued: 2 }); assert.equal(r.json.kingmaker.version, '9.9.9');
  fail = true; assert.equal((await call(ca, { port, path: '/admin/metrics' })).status, 500);
  const ip = lanIp();
  if (ip !== '127.0.0.1') assert.equal((await call(ca, { host: ip, port, path: '/admin/metrics' })).status, 403);
});

test('without the engine (scripts/ wrapper) the route still answers: no queue, no tokens', { timeout: 60_000 }, async (t) => {
  const state = mkdtempSync(join(tmpdir(), 'km-metrics-hand-'));
  const companion = createCompanion({ state, port: 0, setupPort: 0, host: 'localhost', icon: null });
  t.after(async () => { await companion.stop(); rmSync(state, { recursive: true, force: true }); });
  const port = Number(new URL((await companion.start()).app).port), ca = readFileSync(join(state, 'phone-tls', 'ca.pem'));
  const r = await call(ca, { port, path: '/admin/metrics' });
  assert.equal(r.status, 200); assert.equal(r.json.jobs, null); assert.equal(r.json.tokens, null);
  assert.equal(r.json.lanes.length, 5); assert.ok(r.json.device && r.json.device.ramGb > 0);
});

test('the engine feeds it: its queue, and the meter on its own model calls', () => {
  const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const cli = src('lib/cli.mjs');
  assert.match(cli, /metrics: \(\) => bridgeMetrics\(\{ state: paths\.state, jobs: \(\) => \(\{ \.\.\.work \}\), tokens: meterSnapshot \}\)/);
  // The queue itself is lib/bar-events.mjs createBarTurnQueue, built over the same `work` counters the
  // metrics read: queued++ on submit, queued--/running++ on start, running-- at the end.
  assert.match(cli, /const queueTurn = createBarTurnQueue\(\{ work,/);
  const queue = src('lib/bar-events.mjs');
  assert.match(queue, /work\.queued\+\+;/);
  assert.match(queue, /work\.queued--; work\.running\+\+;/);
  assert.match(queue, /work\.running--;/);
  assert.ok((cli.match(/queueTurn\(/g) || []).length >= 3, 'turns go through the one queue');
  // Each model call site records itself: test/metrics-history.test.mjs.
});
