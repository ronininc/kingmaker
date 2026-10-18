// The launcher's analytics feed: every model call Kingmaker makes is recorded (lib/token-meter.mjs) with no prompt,
// answer or key, and GET /admin/metrics/history sums it per hour or day (lib/metrics-history.mjs). Unknown stays null.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callsFile, meter, meterCloud, meterDataset, meterFail, recordTo, resetMeter, usesFile } from '../lib/token-meter.mjs';
import { historyQuery, readHistory } from '../lib/metrics-history.mjs';
import { claudeUsage } from '../lib/claude-brain.mjs';
import { grokUsage } from '../lib/grok-brain.mjs';
import { createCompanion, lanIp } from '../lib/phone-companion.mjs';

const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const temp = (t, name) => { const d = mkdtempSync(join(tmpdir(), name)); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };

test('recording: each call as one line, no text, cancelled vs error, cloud usage as the provider reported it', (t) => {
  const state = temp(t, 'km-rec-');
  t.after(resetMeter);
  recordTo(state);
  const since = JSON.parse(readFileSync(join(state, 'metrics', 'since.json'), 'utf8')).recordedSince;
  recordTo(state);
  assert.equal(JSON.parse(readFileSync(join(state, 'metrics', 'since.json'), 'utf8')).recordedSince, since, 'recordedSince is set once');

  meter({ model: 'qwen3:1.7b', message: { content: 'SECRET ANSWER' }, eval_count: 3, eval_duration: 1e8, prompt_eval_count: 200, prompt_eval_duration: 2e8 }, { lane: 'router', kind: 'router' });
  meter({ eval_count: 40, eval_duration: 1e9 }, { kind: 'tool', model: 'not-in-any-profile:1b' });
  meterFail({ lane: 'writer', model: 'qwen3:8b', error: Object.assign(new Error('x'), { name: 'AbortError' }) });
  meterFail({ lane: 'writer', model: 'qwen3:8b', error: Object.assign(new Error('x'), { name: 'TimeoutError' }) });
  meterCloud({ provider: 'anthropic', ...claudeUsage(JSON.stringify({ result: 'SECRET', usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 7 }, modelUsage: { 'claude-opus-5-5': {} }, total_cost_usd: 0.0123 })), billing: 'subscription' });
  meterCloud({ provider: 'openai', model: 'chatgpt', billing: 'subscription', outcome: 'error' });

  const raw = readFileSync(callsFile(state), 'utf8');
  assert.ok(!/SECRET/.test(raw), 'no prompt or answer text is ever written');
  const lines = raw.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 6);
  assert.ok(raw.split('\n').filter(Boolean).every((l) => l.startsWith('{"at":"')), 'at comes first (the reader skips by it)');
  assert.deepEqual(lines[0], { at: lines[0].at, provider: 'ollama', lane: 'router', kind: 'router', model: 'qwen3:1.7b', prompt: 200, generated: 3, promptNs: 2e8, evalNs: 1e8, outcome: 'ok' });
  assert.equal(lines[1].lane, 'other'); assert.equal(lines[1].kind, 'tool');
  assert.equal(lines[2].outcome, 'cancelled'); assert.equal(lines[3].outcome, 'error');
  assert.deepEqual({ ...lines[4], at: 0 }, { at: 0, provider: 'anthropic', lane: null, kind: 'turn', model: 'claude-opus-5-5', prompt: 15, generated: 7, costUsd: 0.0123, billing: 'subscription', outcome: 'ok' });
  assert.equal(lines[5].prompt, null); assert.equal(lines[5].costUsd, null, 'Codex reports no usage: null, never 0');
  assert.equal(statSync(callsFile(state)).mode & 0o077, 0, 'the file is 0600');
});

test('provider usage parsers read only what was printed', () => {
  assert.deepEqual(claudeUsage('not json'), { model: null, prompt: null, generated: null, costUsd: null });
  assert.deepEqual(claudeUsage(JSON.stringify({ result: 'x' })), { model: null, prompt: null, generated: null, costUsd: null });
  assert.deepEqual(grokUsage(JSON.stringify({ text: 'hi', stopReason: 'end_turn' })), { model: null, prompt: null, generated: null, costUsd: null });
  assert.deepEqual(grokUsage(JSON.stringify({ text: 'hi', model: 'grok-5', usage: { prompt_tokens: 12, completion_tokens: 4 }, cost_usd: 0.002 })), { model: 'grok-5', prompt: 12, generated: 4, costUsd: 0.002 });
});

test('the query: defaults, limits and errors', () => {
  const now = new Date('2026-10-15T20:00:00.000Z'), q = (s) => historyQuery(new URLSearchParams(s), now);
  const d = q('');
  assert.equal(d.bucket, 'hour'); assert.equal(d.to.toISOString(), now.toISOString()); assert.equal(d.to - d.from, 86_400_000);
  assert.equal(q('from=2026-10-01T00:00:00Z&to=2026-10-15T00:00:00Z').bucket, 'day');
  assert.ok(q('from=nope').error); assert.ok(q('from=2026-10-15T00:00:00Z&to=2026-10-14T00:00:00Z').error);
  assert.ok(q('from=2024-01-01T00:00:00Z&to=2026-01-01T00:00:00Z').error); assert.ok(q('bucket=week').error);
});

test('history: per bucket per model, local vs cloud, datasets and who read them; unknown stays null; only the range', (t) => {
  const state = temp(t, 'km-hist-');
  const base = new Date(2026, 8, 30, 22, 0, 0);   // local 22:00 on Sep 30: two hours later is October (two month files)
  const at = (h, m = 0) => new Date(base.getTime() + h * 3600_000 + m * 60_000).toISOString();
  const recs = [
    { at: at(0, 5), provider: 'ollama', lane: 'router', kind: 'router', model: 'r', prompt: 100, generated: 2, promptNs: 1e8, evalNs: 1e7, outcome: 'ok' },
    { at: at(0, 30), provider: 'ollama', lane: 'writer', kind: 'turn', model: 'w', prompt: 400, generated: 100, promptNs: 5e8, evalNs: 2e9, outcome: 'ok' },
    { at: at(0, 40), provider: 'ollama', lane: 'writer', kind: 'tool', model: 'w', prompt: 400, generated: 100, promptNs: 5e8, evalNs: 2e9, outcome: 'ok' },
    { at: at(1, 10), provider: 'ollama', lane: 'writer', kind: 'turn', model: 'w', prompt: 0, generated: 0, promptNs: 0, evalNs: 0, outcome: 'error' },
    { at: at(2, 15), provider: 'anthropic', lane: null, kind: 'turn', model: 'claude-x', prompt: 10, generated: 5, costUsd: 0.01, billing: 'subscription', outcome: 'ok' },
    { at: at(2, 20), provider: 'openai', lane: 'cloud', kind: 'turn', model: 'chatgpt', prompt: null, generated: null, costUsd: null, billing: 'subscription', outcome: 'ok' },   // an older record's 'cloud' lane reads as null
    { at: at(30), provider: 'ollama', lane: 'writer', kind: 'turn', model: 'w', prompt: 1, generated: 1, promptNs: 1, evalNs: 1, outcome: 'ok' },   // outside the range
  ];
  mkdirSync(join(state, 'metrics'), { recursive: true });
  for (const r of recs) writeFileSync(callsFile(state, new Date(r.at)), `${JSON.stringify(r)}\nnot json\n`, { flag: 'a' });
  const uses = [
    { at: at(0, 31), dataset: 'brain-library', model: 'w', lane: 'writer', kind: 'turn' },
    { at: at(0, 41), dataset: 'brain-library', model: 'w', lane: 'writer', kind: 'tool' },
    { at: at(2, 16), dataset: 'crm', model: 'claude-x', lane: null, kind: 'turn' },
    { at: at(2, 17), dataset: 'brain-library', model: 'w', lane: 'writer', kind: 'turn' },
  ];
  for (const u of uses) writeFileSync(usesFile(state, new Date(u.at)), `${JSON.stringify(u)}\n`, { flag: 'a' });
  writeFileSync(join(state, 'metrics', 'since.json'), JSON.stringify({ recordedSince: at(0) }));

  const h = readHistory(state, { from: base, to: new Date(base.getTime() + 3 * 3600_000), bucket: 'hour' });
  assert.deepEqual(Object.keys(h).sort(), ['bucket', 'datasets', 'from', 'models', 'recent', 'recordedSince', 'series', 'to']);
  assert.equal(h.recordedSince, at(0));
  assert.deepEqual(h.series.map((s) => s.at), [at(0), at(1), at(2)]);
  assert.deepEqual(h.series[0].models, [
    { model: 'w', provider: 'ollama', kind: 'local', lane: 'writer', prompt: 800, generated: 200, requests: 2, costUsd: null, decodeTokS: 50, prefillTokS: 800 },
    { model: 'r', provider: 'ollama', kind: 'local', lane: 'router', prompt: 100, generated: 2, requests: 1, costUsd: null, decodeTokS: null, prefillTokS: 1000 },
  ]);
  assert.deepEqual(h.series[0].datasets, { 'brain-library': 2 });
  assert.deepEqual(h.series[1].models, [{ model: 'w', provider: 'ollama', kind: 'local', lane: 'writer', prompt: 0, generated: 0, requests: 1, costUsd: null, decodeTokS: null, prefillTokS: null }]);
  assert.deepEqual(h.series[1].datasets, {});
  const cloud = Object.fromEntries(h.series[2].models.map((m) => [m.model, m]));
  assert.deepEqual(cloud['claude-x'], { model: 'claude-x', provider: 'anthropic', kind: 'cloud', lane: null, prompt: 10, generated: 5, requests: 1, costUsd: 0.01, decodeTokS: null, prefillTokS: null });
  assert.deepEqual(cloud.chatgpt, { model: 'chatgpt', provider: 'openai', kind: 'cloud', lane: null, prompt: null, generated: null, requests: 1, costUsd: null, decodeTokS: null, prefillTokS: null });
  assert.deepEqual(h.series[2].datasets, { crm: 1, 'brain-library': 1 });
  assert.deepEqual(h.models[0], { model: 'w', provider: 'ollama', kind: 'local', lane: 'writer', prompt: 800, generated: 200, requests: 3, costUsd: null, decodeTokS: 50, prefillTokS: 800 });
  assert.deepEqual(h.datasets, [
    { id: 'brain-library', uses: 3, usedBy: [{ model: 'w', lane: 'writer', kind: 'turn', uses: 2 }, { model: 'w', lane: 'writer', kind: 'tool', uses: 1 }] },
    { id: 'crm', uses: 1, usedBy: [{ model: 'claude-x', lane: null, kind: 'turn', uses: 1 }] },
  ]);
  assert.equal(h.recent.length, 6);
  assert.deepEqual(h.recent[0], { at: at(2, 20), model: 'chatgpt', provider: 'openai', kind: 'cloud', lane: null, job: 'turn', prompt: null, generated: null, costUsd: null, outcome: 'ok' });
  assert.equal(h.recent[5].job, 'router'); assert.equal(h.recent[5].costUsd, null);

  const d = readHistory(state, { from: base, to: new Date(base.getTime() + 48 * 3600_000), bucket: 'day' });
  assert.equal(d.series.reduce((n, s) => n + s.models.reduce((m, x) => m + x.requests, 0), 0), 7);
  assert.equal(d.series.reduce((n, s) => n + Object.values(s.datasets).reduce((m, x) => m + x, 0), 0), 4);

  const none = readHistory(temp(t, 'km-hist-empty-'), { from: base, to: new Date(base.getTime() + 3600_000), bucket: 'hour' });
  assert.deepEqual({ ...none, from: 0, to: 0 }, { from: 0, to: 0, bucket: 'hour', recordedSince: null, series: [], models: [], datasets: [], recent: [] });
});

test('a dataset use is recorded with no content', (t) => {
  const state = temp(t, 'km-uses-');
  t.after(resetMeter);
  recordTo(state);
  meterDataset({ dataset: 'drive:Field notes', model: 'qwen3:8b', lane: 'writer', kind: 'tool' });
  meterDataset({ dataset: '' });
  const lines = readFileSync(usesFile(state), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.deepEqual({ ...lines[0], at: 0 }, { at: 0, dataset: 'drive:Field notes', model: 'qwen3:8b', lane: 'writer', kind: 'tool' });
  assert.equal(statSync(usesFile(state)).mode & 0o077, 0);
});

test('GET /admin/metrics/history on the bridge: loopback only, 400 on a bad query', { timeout: 60_000 }, async (t) => {
  const state = temp(t, 'km-hist-route-');
  const companion = createCompanion({ state, port: 0, setupPort: 0, host: 'localhost', icon: null, onTurn: () => {} });
  t.after(() => companion.stop());
  const port = Number(new URL((await companion.start()).app).port), ca = readFileSync(join(state, 'phone-tls', 'ca.pem'));
  const get = (path, host = '127.0.0.1') => new Promise((resolve, reject) => {
    const req = request({ host, port, path, ca, agent: false }, (res) => { let d = ''; res.setEncoding('utf8'); res.on('data', (x) => { d += x; }); res.on('end', () => { let json = null; try { json = JSON.parse(d); } catch { /* a 403 is plain text */ } resolve({ status: res.statusCode, json }); }); });
    req.on('error', reject); req.end();
  });
  const ok = await get('/admin/metrics/history?bucket=day&from=2026-10-01T00:00:00Z&to=2026-10-15T00:00:00Z');
  assert.equal(ok.status, 200);
  assert.deepEqual(Object.keys(ok.json).sort(), ['bucket', 'datasets', 'from', 'models', 'recent', 'recordedSince', 'series', 'to']);
  assert.equal(ok.json.recordedSince, null); assert.equal(ok.json.bucket, 'day');
  assert.equal((await get('/admin/metrics/history?bucket=week')).status, 400);
  const ip = lanIp();
  if (ip !== '127.0.0.1') assert.equal((await get('/admin/metrics/history', ip)).status, 403);
});

test('every model call site records itself', () => {
  assert.match(src('lib/fast-route.mjs'), /meter\(j, \{ lane: 'router', kind: 'router', model \}\)/);
  assert.match(src('lib/tool-call.mjs'), /meter\(res\.j, \{ kind: 'tool', model \}\)/);
  assert.match(src('lib/local-turn.mjs'), /meter\(j, \{ lane: 'writer', kind: 'turn', model \}\)/);
  assert.match(src('lib/cli.mjs'), /recordTo\(paths\.state\);/);
  assert.match(src('lib/connectors.mjs'), /meter\(j, \{ kind: 'connector', model \}\)/);
  assert.match(src('lib/next-suggest.mjs'), /meter\(j, \{ kind: 'router', model \}\)/);
  assert.match(src('lib/ad-video.mjs'), /meter\(j, \{ lane: 'writer', kind: 'turn', model \}\)/);
  assert.match(src('lib/claude-brain.mjs'), /meterCloud\(\{ provider: 'anthropic', \.\.\.claudeUsage\(stdout\)/);
  assert.match(src('lib/grok-brain.mjs'), /meterCloud\(\{ provider: 'xai'/);
  assert.match(src('lib/chatgpt-brain.mjs'), /meterCloud\(\{ provider: 'openai'/);
});
