import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asksToAnnounce, claimedLine, createTaskAnnouncer, followStream } from '../lib/announcements.mjs';
import { streamBackgroundTasks, streamEvents, streamFeatureWatch } from '../lib/client.mjs';
import { DESKTOP_NONCE_HEADER } from '../lib/profile.mjs';
import { createOwnerSession } from '../lib/session.mjs';

const ARMED = Date.parse('2026-10-07T12:00:00Z');
const task = (over) => ({ id: 'task_1', tenantId: 'primary', status: 'done', readyLine: "It's ready — the poster is in your reports.", finishedAt: '2026-10-07T12:05:00Z', ...over });
const ASK = 'sol_fwa_openai_0123456789abcdef';
const secrets = { nonce: 'n'.repeat(64), voiceKey: 'k'.repeat(64) };
const tick = () => new Promise((r) => setImmediate(r));
const settle = async (n = 8) => { for (let i = 0; i < n; i += 1) await tick(); };

test('a finished task\'s readyLine is said once; old, unfinished, unlined and foreign tasks are not', () => {
  const a = createTaskAnnouncer({ armedAtMs: ARMED });
  const snapshot = {
    type: 'tasks.snapshot',
    data: { tenantId: 'primary', tasks: [task({ id: 'old', finishedAt: '2026-10-07T11:00:00Z' }), task({ id: 'running', status: 'running', readyLine: null, finishedAt: null })] },
  };
  assert.deepEqual(a.linesFor(snapshot), [], 'what finished before Ghost listened is not announced');
  assert.deepEqual(a.linesFor({ type: 'task.changed', data: { tenantId: 'primary', task: task() } }), [{ id: 'task_1', line: "It's ready — the poster is in your reports." }]);
  assert.deepEqual(a.linesFor({ type: 'task.changed', data: { tenantId: 'primary', task: task() } }), [], 'once');
  assert.deepEqual(a.linesFor({ type: 'tasks.snapshot', data: { tenantId: 'primary', tasks: [task()] } }), [], 'a reconnect snapshot does not repeat it');
  assert.equal(a.linesFor({ type: 'task.changed', data: { tenantId: 'primary', task: task({ id: 'f', status: 'failed', readyLine: 'The code did not finish: out of memory.' }) } }).length, 1, 'an honest failure line is said too');
  assert.deepEqual(a.linesFor({ type: 'task.changed', data: { tenantId: 'primary', task: task({ id: 'quiet', readyLine: '' }) } }), []);
  assert.deepEqual(a.linesFor({ type: 'task.changed', data: { tenantId: 'other', task: task({ id: 'x', tenantId: 'other' }) } }), [], 'another tenant\'s task is never said');
  assert.deepEqual(a.linesFor({ type: 'task.changed', data: { tenantId: 'primary', task: task({ id: 'y', tenantId: 'other' }) } }), []);
});

test('capability asks: only PENDING, unannounced, well-formed ids not yet tried; none when the spoken line is off', () => {
  const snap = { voiceLine: true, pending: [
    { askId: ASK, state: 'PENDING', announced: false },
    { askId: 'sol_fwa_x_00000000', state: 'APPROVING', announced: false },
    { askId: 'sol_fwa_y_11111111', state: 'PENDING', announced: true },
    { askId: 'not-an-ask', state: 'PENDING', announced: false },
  ] };
  assert.deepEqual(asksToAnnounce(snap), [ASK]);
  assert.deepEqual(asksToAnnounce(snap, new Set([ASK])), []);
  assert.deepEqual(asksToAnnounce({ ...snap, voiceLine: false }), [], 'left unclaimed for a screen');
  assert.deepEqual(asksToAnnounce(null), []);
  assert.equal(claimedLine({ json: { data: { claimed: [ASK], line: 'OpenAI launched X.  Want me to build it?' } } }), 'OpenAI launched X. Want me to build it?');
  assert.equal(claimedLine({ json: { data: { claimed: [], line: null } } }), '');
});

test('followStream: reconnects when a stream ends, stops for good when refused, stops on abort', async () => {
  const controller = new AbortController();
  const waits = [];
  let opens = 0;
  const result = await followStream({
    name: 's', signal: controller.signal,
    sleep: async (ms) => { waits.push(ms); },
    open: async ({ onOpen }) => {
      opens += 1;
      if (opens === 1) { onOpen(); return; }                       // ended (core restart)
      if (opens === 2) throw Object.assign(new Error('x'), { status: 502 });
      throw Object.assign(new Error('no'), { status: 403 });
    },
  });
  assert.equal(result, 'refused');
  assert.equal(opens, 3);
  assert.deepEqual(waits, [1_000, 2_000], 'backoff after a lost connection, reset once live');
  controller.abort();
  assert.equal(await followStream({ name: 's', signal: controller.signal, open: async () => { throw new Error('never'); } }), 'stopped');
});

test('the streams Ghost opens are the task and feature-watch streams, with the owner nonce, never the conversation feed', async () => {
  const urls = [];
  const fetchImpl = async (url, init) => { urls.push({ url, headers: init.headers }); return { ok: false, status: 404, body: null }; };
  for (const open of [streamBackgroundTasks, streamFeatureWatch]) {
    await assert.rejects(open(3001, { headers: { [DESKTOP_NONCE_HEADER]: 'n' }, onEvent: () => {}, fetchImpl }), (e) => e.status === 404);
  }
  assert.deepEqual(urls.map((u) => u.url), ['http://127.0.0.1:3001/api/tasks/events?tenantId=primary', 'http://127.0.0.1:3001/api/feature-watch/events?tenantId=primary']);
  assert.ok(urls.every((u) => u.headers[DESKTOP_NONCE_HEADER] === 'n' && u.headers.accept === 'text/event-stream'));
  assert.ok(urls.every((u) => !u.url.includes('/api/conversation/feed')));
});

test('streamEvents parses frames (CRLF too) and reports the stream open', async () => {
  const body = (async function* () { yield new TextEncoder().encode('event: task.changed\r\ndata: {"a":1}\r\n\r\n: keep-alive\n\nevent: x\ndata: '); yield new TextEncoder().encode('{"b":2}\n\n'); })();
  const got = [];
  let opened = false;
  await streamEvents(3001, '/api/tasks/events', { onOpen: () => { opened = true; }, onEvent: (f) => got.push(f), fetchImpl: async () => ({ ok: true, status: 200, body }) });
  assert.equal(opened, true);
  assert.deepEqual(got, [{ type: 'task.changed', data: { a: 1 } }, { type: 'x', data: { b: 2 } }]);
});

/** A session whose speech and streams are fakes: `said` is what was spoken, in order. */
function fakeSession({ turnImpl, backgroundTasks, featureWatch, claimAsks } = {}) {
  const said = [];
  const speaking = [];
  const session = createOwnerSession({
    port: 3001, secrets, runtimeHome: null, out: () => {}, voiceOut: true,
    turnImpl: turnImpl ?? (async () => ({ ok: true, spoken: 'Done.', raw: { data: {} } })),
    speakImpl: (line) => { said.push(line); let end; const done = new Promise((r) => { end = r; }); speaking.push(end); return { done, stop: end }; },
    streams: {
      backgroundTasks: backgroundTasks ?? (async () => new Promise(() => {})),
      featureWatch: featureWatch ?? (async () => new Promise(() => {})),
      claimAsks: claimAsks ?? (async () => ({ ok: true, json: { data: { claimed: [], line: null } } })),
    },
  });
  const finishSpeaking = async () => { while (speaking.length) { speaking.shift()(); await settle(); } };
  return { session, said, finishSpeaking };
}

test('ONE SPEAKER: an announcement waits for the turn in flight and for the line being said', async () => {
  let finishTurn;
  const { session, said, finishSpeaking } = fakeSession({ turnImpl: () => new Promise((r) => { finishTurn = () => r({ ok: true, spoken: 'Here is your answer.', raw: { data: {} } }); }) });
  const turnDone = session.runTurn('what time is it', { owner: true });
  await settle();
  session.announce("It's ready — your code is written.");
  await settle();
  assert.deepEqual(said, [], 'never over a turn in flight');
  finishTurn();
  await settle();
  assert.deepEqual(said, ['Here is your answer.'], 'the turn\'s own answer first');
  await finishSpeaking();
  await turnDone;
  await finishSpeaking();
  assert.deepEqual(said, ['Here is your answer.', "It's ready — your code is written."]);
});

test('background tasks: the stream\'s finished task is said once, even across a reconnect', async () => {
  let opens = 0;
  const controller = new AbortController();
  const { session, said, finishSpeaking } = fakeSession({
    backgroundTasks: async (_port, { headers, onEvent, onOpen }) => {
      assert.equal(headers[DESKTOP_NONCE_HEADER], secrets.nonce, 'the owner process reads its own tasks');
      opens += 1;
      onOpen();
      onEvent({ type: 'tasks.snapshot', data: { tenantId: 'primary', tasks: opens === 1 ? [] : [task({ finishedAt: new Date().toISOString() })] } });
      if (opens === 1) { onEvent({ type: 'task.changed', data: { tenantId: 'primary', task: task({ finishedAt: new Date().toISOString() }) } }); return; }
      if (opens >= 2) { controller.abort(); }
    },
  });
  // followStream's reconnect pause is an unref'd timer (it must not keep the CLI alive), so hold the test's event
  // loop open while the stream reconnects.
  const keepAlive = setInterval(() => {}, 1_000);
  try { await session.watchBackgroundTasks(controller.signal); } finally { clearInterval(keepAlive); }
  await finishSpeaking();
  assert.equal(opens, 2);
  assert.deepEqual(said, ["It's ready — the poster is in your reports."]);
});

test('capability asks: the line is claimed with the nonce, said once, and a second snapshot claims nothing', async () => {
  const claims = [];
  const controller = new AbortController();
  const { session, said, finishSpeaking } = fakeSession({
    featureWatch: async (_port, { onEvent, onOpen }) => {
      onOpen();
      await onEvent({ type: 'feature-watch', data: { voiceLine: true, pending: [{ askId: ASK, state: 'PENDING', announced: false }] } });
      await onEvent({ type: 'feature-watch', data: { voiceLine: true, pending: [{ askId: ASK, state: 'PENDING', announced: true }] } });
      await onEvent({ type: 'feature-watch', data: { voiceLine: true, pending: [{ askId: ASK, state: 'PENDING', announced: false }] } });
      controller.abort();
    },
    claimAsks: async (_port, askIds, { headers }) => {
      claims.push({ askIds, nonce: headers[DESKTOP_NONCE_HEADER] });
      return { ok: true, json: { data: { claimed: askIds, line: 'OpenAI launched realtime video. Want me to look at building it?' } } };
    },
  });
  await session.watchFeatureWatch(controller.signal);
  await finishSpeaking();
  assert.deepEqual(claims, [{ askIds: [ASK], nonce: secrets.nonce }]);
  assert.deepEqual(said, ['OpenAI launched realtime video. Want me to look at building it?']);
});
