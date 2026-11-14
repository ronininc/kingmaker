// Owner calls (lib/owner-call.mjs): the Mac side of the free FaceTime Audio owner call. Everything Mac-specific is a
// stub here (open, osascript, sox, say, the audio-activity helper, whisper, fetch); nothing dials, records or reads
// a credential.
import './_bind.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  APPROVE_PHRASES, audioDevicesFrom, batchItemLine, batchQuestion, beforeDeadline, boundBytes, classifyBatchReply, createFaceTimeWatch,
  createMacRunners, createOwnerCallApi, createOwnerCallLoop, DEFAULT_VOICES, deadlineMs, facetimeUrl, listenOnce, maskHandle,
  normalizeHandle, OWNER_CALL_BASE, ownerCallCommand, ownerCallConfigPath, ownerCallDoctor, placeOwnerCall, readOwnerCallConfig,
  readOwnerCallSecrets, recordArgs, saveOwnerCallSecrets, validHandle, voiceForCaller, writeOwnerCallConfig,
  OwnerCallHttpError,
} from '../owner-call.mjs';

const HANDLE = '+16025550100';
const T0 = 1_760_000_000_000;

function clock(start = T0) {
  let t = start;
  return { now: () => t, sleep: async (ms) => { t += ms; }, advance: (ms) => { t += ms; } };
}

function fakeWatch({ initial = false } = {}) {
  let state = null; let started = false; let stopped = 0;
  return {
    start() { started = true; state = initial; return { ok: true }; },
    connected: () => state,
    stop() { stopped += 1; state = null; },
    set(v) { state = v; },
    get started() { return started; },
    get stopped() { return stopped; },
  };
}

/** A FaceTime that answers on dial (unless told not to), hears scripted replies, and can drop the call mid-speech. */
function fakeMac({ answer = true, heard = [], dropAfterLines = null, hearThrows = null } = {}) {
  const w = fakeWatch();
  const log = { dialled: [], spoken: [], voices: [], tones: 0, heard: 0, ended: 0, confirmed: 0 };
  const mac = {
    watch: () => w,
    async dial(handle) { log.dialled.push(facetimeUrl(handle)); if (answer) w.set(true); return { code: 0, out: '', err: '' }; },
    async confirmPrompt() { log.confirmed += 1; return { code: 0, out: 'clicked:FaceTime\n', err: '' }; },
    async endCall() { log.ended += 1; w.set(false); return { code: 0, out: 'ended', err: '' }; },
    async forceQuit() { return { code: 0 }; },
    speak(text, voice) {
      log.spoken.push(text); log.voices.push(voice);
      if (dropAfterLines !== null && log.spoken.length >= dropAfterLines) w.set(false);
      return { done: Promise.resolve(), stop: () => {} };
    },
    tone() { log.tones += 1; return { done: Promise.resolve(), stop: () => {} }; },
    async hear() {
      log.heard += 1;
      if (hearThrows) throw hearThrows;
      const next = heard.shift() ?? { text: '' };
      if (next.hangup) w.set(false);
      return { text: next.text ?? '', hangup: Boolean(next.hangup) };
    },
  };
  return { mac, log, watch: w };
}

function fakeTransport(startBody, { resultThrows = null, resultBody = { ok: true } } = {}) {
  const calls = [];
  return {
    calls,
    start: async (b) => { calls.push(['start', b]); return typeof startBody === 'function' ? startBody(b) : startBody; },
    answered: async (b) => { calls.push(['answered', b]); return { ok: true }; },
    missed: async (b) => { calls.push(['missed', b]); return { ok: true }; },
    result: async (b) => { calls.push(['result', b]); if (resultThrows) throw resultThrows; return resultBody; },
  };
}

const msgCall = { id: 'req-msg-1', kind: 'message', caller: 'codex', caller_name: 'Codex', reason: 'deploy finished', message: 'The deploy finished.', created_at: T0 };
const msgStart = { ok: true, id: 'req-msg-1', kind: 'message', caller: 'codex', caller_name: 'Codex', message: 'The deploy finished.', reason: 'deploy finished' };
const batchCall = { id: 'req-batch-1', kind: 'outbound_batch', caller: 'ronin-crm', caller_name: 'Ronin CRM', reason: 'pending outbound', message: null, created_at: T0 };
const batchStart = (deadline = T0 + 5 * 60_000) => ({
  ok: true, id: 'req-batch-1', kind: 'outbound_batch', caller: 'ronin-crm', caller_name: 'Ronin CRM', batch_id: 'b1', manifest_hash: 'h1', approval_deadline: deadline,
  items: [
    { ord: 1, recipient: 'Jane Doe <jane@example.com>', channel: 'email', subject: 'Re: proposal', body: 'SECRET BODY ONE' },
    { ord: 2, recipient: 'Acme Ops', channel: 'email', subject: 'Invoice 42.', body: 'SECRET BODY TWO' },
  ],
});

function place(call, transport, mac, extra = {}) {
  const c = extra.clock ?? clock();
  return placeOwnerCall(call, { transport, mac, handle: HANDLE, sessionId: 'sess-1', now: c.now, sleep: c.sleep, pollMs: 250, ...extra });
}
const results = (t) => t.calls.filter(([r]) => r === 'result').map(([, b]) => b);

// ── the handle ──────────────────────────────────────────────────────────────────────────────────────────────────

test('handle: only an E.164 phone number or an email address; anything else is refused', () => {
  assert.deepEqual(validHandle('+16025550100'), { kind: 'phone', handle: '+16025550100' });
  assert.deepEqual(validHandle('Ana@Example.com'), { kind: 'email', handle: 'ana@example.com' });
  for (const bad of ['', ' +16025550100', '6025550100', '+1602', 'tel:+16025550100', '+16025550100?x=1', '+16025550100&open=evil', 'ana@example', 'a..b@example.com',
    'ana@example.com/../x', 'facetime://ana@example.com', '"; do shell script "x', '+1 602 555 0100', null, undefined, 16025550100]) {
    assert.equal(validHandle(bad), null, `refused: ${bad}`);
    assert.throws(() => facetimeUrl(bad), /Refusing to dial/);
  }
  assert.equal(normalizeHandle('(602) 555-0100'), '+16025550100');
  assert.equal(normalizeHandle('+44 20 7946 0958'), '+442079460958');
  assert.equal(normalizeHandle('call me maybe'), null);
  assert.equal(facetimeUrl('+16025550100'), 'facetime-audio://+16025550100');
  assert.equal(maskHandle('+16025550100'), '+1••••••0100');
  assert.equal(maskHandle('ana@example.com'), 'a•••@example.com');
});

test('dials ONLY the saved handle, whatever the request or the CRM says', async () => {
  const { mac, log } = fakeMac({ heard: [{ text: 'Thanks.' }] });
  const call = { ...msgCall, handle: '+19995550000', to: 'evil@example.com' };
  const t = fakeTransport({ ...msgStart, handle: '+19995550000', to: 'evil@example.com', phone: '+18885550000' });
  const r = await place(call, t, mac);
  assert.equal(r.outcome, 'reply');
  assert.deepEqual(log.dialled, ['facetime-audio://+16025550100']);
  // The default runner: `open facetime-audio://<saved handle>`, nothing else.
  const runs = [];
  const runners = createMacRunners({ paths: { state: '/x', resources: '/r', voice: {} }, config: readOwnerCallConfig({ state: '/nonexistent' }), run: async (cmd, args) => { runs.push([cmd, args]); return { code: 0 }; } });
  await runners.dial(HANDLE);
  assert.deepEqual(runs, [['/usr/bin/open', ['facetime-audio://+16025550100']]]);
  assert.throws(() => runners.dial('+16025550100; open -a Terminal'), /Refusing to dial/);
  assert.equal(runs.length, 1, 'a bad handle never reaches open');
});

test('a bad saved handle: nothing is started, nothing is dialled', async () => {
  const { mac, log } = fakeMac();
  const t = fakeTransport(msgStart);
  const r = await placeOwnerCall(msgCall, { transport: t, mac, handle: 'ana', sessionId: 's', ...clock() });
  assert.deepEqual(r, { outcome: 'skipped', reason: 'bad_handle' });
  assert.equal(t.calls.length, 0);
  assert.equal(log.dialled.length, 0);
});

// ── callers and voices ──────────────────────────────────────────────────────────────────────────────────────────

test('every agent calls through the same machinery; only the name and the voice differ', async () => {
  const callers = ['claude', 'codex', 'grok', 'muse', 'kingmaker', 'ronin-crm'];
  const voices = callers.map((c) => voiceForCaller(c, null));
  assert.deepEqual(voices.map((v) => v.name), ['Claude', 'Codex', 'Grok', 'Muse', 'Kingmaker', 'Ronin CRM']);
  assert.equal(new Set(voices.map((v) => v.kokoro)).size, 6, 'distinct Kokoro voices');
  assert.equal(new Set(voices.map((v) => v.say)).size, 6, 'distinct say voices');
  // An agent not in the map is never refused: its own name, the fallback voice.
  const other = voiceForCaller('newbot', 'New Bot');
  assert.equal(other.name, 'New Bot'); assert.ok(other.kokoro && other.say);
  for (const caller of [...callers, 'newbot']) {
    const { mac, log } = fakeMac({ heard: [{ text: 'ok thanks' }] });
    const name = voiceForCaller(caller, null).name;
    const t = fakeTransport({ ...msgStart, caller, caller_name: name });
    const r = await place({ ...msgCall, caller, caller_name: name }, t, mac);
    assert.equal(r.outcome, 'reply', caller);
    assert.equal(log.spoken[0], `This is ${name}, for Ronin. The deploy finished.`);
    assert.equal(log.voices[0].kokoro, voiceForCaller(caller, null).kokoro);
  }
});

test('the voice map is configurable per caller', () => {
  const dir = mkdtempSync(join(tmpdir(), 'km-owner-call-'));
  const paths = { state: join(dir, 'state') };
  const c0 = readOwnerCallConfig(paths);
  assert.equal(c0.enabled, false, 'off by default');
  assert.deepEqual(c0.devices, { speak: 'BlackHole 2ch', hear: 'BlackHole 16ch', hearRemix: '1,2' });
  const c1 = writeOwnerCallConfig(paths, { voices: { grok: { say: 'Alex' }, 'Bad Caller!': { say: 'x' } }, devices: { speak: 'Loopback A' } });
  assert.equal(c1.voices.grok.say, 'Alex');
  assert.equal(c1.voices.grok.kokoro, DEFAULT_VOICES.grok.kokoro);
  assert.equal(c1.voices['Bad Caller!'], undefined);
  assert.equal(c1.devices.speak, 'Loopback A');
  assert.equal(c1.enabled, false);
  assert.equal(writeOwnerCallConfig(paths, { enabled: true }).enabled, true);
  assert.equal(readOwnerCallConfig(paths).voices.grok.say, 'Alex', 'a later write keeps earlier settings');
  assert.equal(statSync(ownerCallConfigPath(paths)).mode & 0o777, 0o600);
});

// ── message calls ───────────────────────────────────────────────────────────────────────────────────────────────

test('message: opening + message, the reply prompt and tone, one reply posted as information', async () => {
  const { mac, log } = fakeMac({ heard: [{ text: ' Tell them I will call back after lunch. ' }] });
  const t = fakeTransport(msgStart);
  const c = clock();
  const r = await place(msgCall, t, mac, { clock: c });
  assert.equal(r.outcome, 'reply');
  assert.deepEqual(log.spoken.slice(0, 2), ['This is Codex, for Ronin. The deploy finished.', 'Any reply? Speak after the tone.']);
  assert.equal(log.tones, 1);
  assert.deepEqual(t.calls.map(([r]) => r), ['start', 'answered', 'result']);
  assert.deepEqual(t.calls[0][1], { id: 'req-msg-1', session_id: 'sess-1' });
  assert.equal(typeof t.calls[1][1].connected_at, 'number');
  assert.deepEqual(results(t), [{ id: 'req-msg-1', session_id: 'sess-1', outcome: 'reply', transcript: 'Tell them I will call back after lunch.', transport_event_id: 'km-owner-call:sess-1:req-msg-1:reply' }]);
  assert.ok(log.ended >= 1, 'the call is ended');
});

test('message: no reply → silence; a reply is bounded to 4 KB', async () => {
  const { mac } = fakeMac({ heard: [{ text: '[BLANK_AUDIO]' }] });
  const t = fakeTransport(msgStart);
  assert.equal((await place(msgCall, t, mac)).outcome, 'silence');
  assert.equal(results(t)[0].outcome, 'silence');
  assert.equal(results(t)[0].transcript, undefined);
  assert.ok(Buffer.byteLength(boundBytes('é'.repeat(5000)), 'utf8') <= 4000);
});

// ── outbound batch ──────────────────────────────────────────────────────────────────────────────────────────────

test('batch: reads recipient, channel and subject for each item, never a body, then asks once', async () => {
  const { mac, log } = fakeMac({ heard: [{ text: 'No.' }] });
  const t = fakeTransport(batchStart());
  const r = await place(batchCall, t, mac);
  assert.equal(r.outcome, 'deny');
  assert.deepEqual(log.spoken.slice(0, 4), [
    'This is Ronin CRM, for Ronin.',
    '1. Jane Doe <jane@example.com>, by email: Re: proposal.',
    '2. Acme Ops, by email: Invoice 42.',
    'Say okay to send these 2, or say no.',
  ]);
  assert.ok(log.spoken.every((line) => !/SECRET BODY/.test(line)), 'no body is ever spoken');
  assert.equal(batchItemLine({ ord: 3, recipient: 'X', channel: 'email', subject: 'Hi', body: 'nope' }), '3. X, by email: Hi.');
  assert.equal(batchQuestion(10), 'Say okay to send these 10, or say no.');
  assert.deepEqual(results(t), [{ id: 'req-batch-1', session_id: 'sess-1', outcome: 'deny', phrase: 'no', transcript: 'No.', transport_event_id: 'km-owner-call:sess-1:req-batch-1:deny' }]);
  assert.equal(log.spoken.at(-1), 'Nothing was sent. Goodbye.');
});

test('grammar: only the five approval phrases approve; everything else sends nothing', () => {
  assert.deepEqual(APPROVE_PHRASES, ['okay', 'ok', 'yes', 'okay send them', 'yes send them']);
  const table = [
    ['okay', 'approve'], ['Okay.', 'approve'], ['OK', 'approve'], ['ok!', 'approve'], ['Yes.', 'approve'], ['  yes  ', 'approve'],
    ['Okay, send them.', 'approve'], ['okay send them', 'approve'], ['Yes, send them!', 'approve'],
    ['no', 'deny'], ['No.', 'deny'], ['Nope', 'deny'], ["Don't.", 'deny'], ['don’t send them', 'deny'], ['Stop.', 'deny'], ['do not send', 'deny'],
    ['not yet', 'ambiguous'], ['okay but skip three', 'ambiguous'], ['yes please', 'ambiguous'], ['sure', 'ambiguous'], ['okay okay', 'ambiguous'],
    ['send them', 'ambiguous'], ['yeah', 'ambiguous'], ['o.k.', 'ambiguous'], ['okay send them all', 'ambiguous'], ['I said okay', 'ambiguous'],
    ['', 'silence'], ['   ', 'silence'], ['[BLANK_AUDIO]', 'silence'], ['(music)', 'silence'], ['...', 'silence'], [null, 'silence'],
  ];
  for (const [said, outcome] of table) assert.equal(classifyBatchReply(said).outcome, outcome, JSON.stringify(said));
  assert.equal(classifyBatchReply('Okay, send them.').phrase, 'okay send them');
});

test('batch approve before the deadline: approve posted once with phrase, affirmed_at and an event id; result spoken', async () => {
  const { mac, log } = fakeMac({ heard: [{ text: 'Okay.' }] });
  const t = fakeTransport(batchStart(), { resultBody: { ok: true, approved: true, dispatch: 'started' } });
  const c = clock();
  const r = await place(batchCall, t, mac, { clock: c });
  assert.deepEqual(r, { outcome: 'approve', sending: true });
  const [res] = results(t);
  assert.equal(results(t).length, 1);
  assert.equal(res.outcome, 'approve');
  assert.equal(res.phrase, 'okay');
  assert.equal(res.transport_event_id, 'km-owner-call:sess-1:req-batch-1:approve');
  assert.equal(typeof res.affirmed_at, 'number');
  assert.ok(res.affirmed_at < batchStart().approval_deadline);
  assert.equal(log.spoken.at(-1), 'Sending those 2. Goodbye.');
  // The approve reached the CRM before the call was ended.
  assert.ok(log.ended >= 1);
});

test('batch approve the CRM did not accept → "Nothing was sent."', async () => {
  const { mac, log } = fakeMac({ heard: [{ text: 'yes' }] });
  const t = fakeTransport(batchStart(), { resultBody: { ok: false, error: 'batch_expired' } });
  const r = await place(batchCall, t, mac);
  assert.deepEqual(r, { outcome: 'approve', sending: false });
  assert.equal(log.spoken.at(-1), 'Nothing was sent. Goodbye.');
});

test('batch: an approval at or past the deadline (or an unreadable one) is reported ambiguous, never approve', async () => {
  for (const deadline of [T0 + 2_000, T0 - 1, 'not a date', null]) {
    const { mac, log } = fakeMac({ heard: [{ text: 'Okay.' }] });
    const t = fakeTransport(batchStart(deadline));
    const r = await place(batchCall, t, mac);
    assert.equal(r.outcome, 'ambiguous', String(deadline));
    assert.ok(results(t).every((b) => b.outcome !== 'approve'));
    assert.match(log.spoken.at(-1), /after the approval window closed\. Nothing was sent/);
  }
  assert.equal(deadlineMs('2026-10-13T12:00:00Z'), Date.parse('2026-10-13T12:00:00Z'));
  assert.equal(deadlineMs(1_760_000_000), 1_760_000_000_000);
  assert.equal(beforeDeadline(T0 + 60_000, T0), true);
  assert.equal(beforeDeadline(T0 + 4_000, T0), false, 'inside the safety margin');
});

test('batch: silence gets one retry; two silences → silence', async () => {
  const a = fakeMac({ heard: [{ text: '' }, { text: 'ok' }] });
  const ta = fakeTransport(batchStart());
  assert.equal((await place(batchCall, ta, a.mac)).outcome, 'approve');
  assert.equal(a.log.heard, 2);
  assert.equal(a.log.spoken.filter((l) => l.startsWith('I did not hear anything. Say okay to send these 2')).length, 1);
  const b = fakeMac({ heard: [{ text: '' }, { text: '[BLANK_AUDIO]' }] });
  const tb = fakeTransport(batchStart());
  assert.equal((await place(batchCall, tb, b.mac)).outcome, 'silence');
  assert.equal(b.log.heard, 2);
  assert.deepEqual(results(tb).map((x) => x.outcome), ['silence']);
});

test('missed: not connected within 45 s → call ended, missed posted, nothing spoken', async () => {
  const { mac, log } = fakeMac({ answer: false });
  const t = fakeTransport(batchStart());
  const c = clock();
  const r = await place(batchCall, t, mac, { clock: c });
  assert.equal(r.outcome, 'missed');
  assert.ok(c.now() - T0 >= 45_000, 'waited the full 45 s');
  assert.ok(c.now() - T0 < 50_000);
  assert.deepEqual(t.calls.map(([x]) => x), ['start', 'missed']);
  assert.equal(log.spoken.length, 0);
  assert.ok(log.ended >= 1);
});

test('hangup mid-read → hangup posted, no approve, nothing heard', async () => {
  const { mac, log } = fakeMac({ dropAfterLines: 2, heard: [{ text: 'okay' }] });
  const t = fakeTransport(batchStart());
  const r = await place(batchCall, t, mac);
  assert.equal(r.outcome, 'hangup');
  assert.equal(log.heard, 0, 'never listened for an approval');
  assert.deepEqual(results(t).map((x) => x.outcome), ['hangup']);
  assert.ok(log.ended >= 1);
});

test('hangup while listening → hangup, even if words were caught', async () => {
  const { mac } = fakeMac({ heard: [{ text: 'okay', hangup: true }] });
  const t = fakeTransport(batchStart());
  assert.equal((await place(batchCall, t, mac)).outcome, 'hangup');
  assert.deepEqual(results(t).map((x) => x.outcome), ['hangup']);
});

test('any error → no approve, nothing sent; the failure is reported and the call ended', async () => {
  const { mac, log } = fakeMac({ hearThrows: new Error('sox could not record') });
  const t = fakeTransport(batchStart());
  const r = await place(batchCall, t, mac);
  assert.equal(r.outcome, 'ambiguous');
  assert.deepEqual(results(t).map((x) => x.outcome), ['ambiguous']);
  assert.ok(log.ended >= 1);
  // A speak failure before the question: same.
  const s = fakeMac();
  s.mac.speak = () => ({ done: Promise.reject(new Error('say could not play')), stop: () => {} });
  const ts = fakeTransport(batchStart());
  assert.equal((await place(batchCall, ts, s.mac)).outcome, 'ambiguous');
  assert.ok(results(ts).every((x) => x.outcome !== 'approve'));
  // A dial that fails: missed, never answered.
  const d = fakeMac();
  d.mac.dial = async () => ({ code: 1, err: 'no FaceTime' });
  const td = fakeTransport(batchStart());
  assert.equal((await place(batchCall, td, d.mac)).outcome, 'missed');
  assert.deepEqual(td.calls.map(([x]) => x), ['start', 'missed']);
});

test('an approve whose POST fails is uncertain: never retried, never reported twice', async () => {
  const { mac, log } = fakeMac({ heard: [{ text: 'okay' }] });
  const t = fakeTransport(batchStart(), { resultThrows: new Error('network down') });
  const r = await place(batchCall, t, mac);
  assert.equal(r.outcome, 'approve_uncertain');
  assert.equal(results(t).length, 1, 'exactly one result attempt');
  assert.match(log.spoken.at(-1), /could not confirm/);
});

test('start refused or nothing to send → nothing is dialled', async () => {
  for (const [body, outcome] of [[{ ok: false, error: 'nothing_to_send' }, 'nothing_to_send'], [{ ok: false, error: 'expired' }, 'start_refused'], [{ ...msgStart, kind: 'outbound_batch' }, 'start_refused']]) {
    const { mac, log } = fakeMac();
    const r = await place(msgCall, fakeTransport(body), mac);
    assert.equal(r.outcome, outcome);
    assert.equal(log.dialled.length, 0);
  }
  const { mac, log } = fakeMac();
  const t = fakeTransport(() => { throw new Error('offline'); });
  assert.equal((await place(msgCall, t, mac)).outcome, 'start_failed');
  assert.equal(log.dialled.length, 0);
});

test('FaceTime already on a call, or call detection not working → skipped before the CRM hears anything', async () => {
  const busy = fakeMac();
  busy.mac.watch = () => fakeWatch({ initial: true });
  const t1 = fakeTransport(msgStart);
  assert.deepEqual(await place(msgCall, t1, busy.mac), { outcome: 'skipped', reason: 'facetime_busy' });
  assert.equal(t1.calls.length, 0);
  const deaf = fakeMac();
  deaf.mac.watch = () => ({ start: () => ({ ok: true }), connected: () => null, stop() {} });
  const t2 = fakeTransport(msgStart);
  assert.deepEqual(await place(msgCall, t2, deaf.mac), { outcome: 'skipped', reason: 'audio_activity_silent' });
  assert.equal(t2.calls.length, 0);
  const missing = fakeMac();
  missing.mac.watch = () => ({ start: () => ({ ok: false, reason: 'helper_not_installed' }), connected: () => null, stop() {} });
  assert.deepEqual(await place(msgCall, fakeTransport(msgStart), missing.mac), { outcome: 'skipped', reason: 'helper_not_installed' });
});

// ── the loop ────────────────────────────────────────────────────────────────────────────────────────────────────

function loopWith({ enabled = true, ronin = true, pending, mac, transport, secrets = { handle: HANDLE, token: 't'.repeat(32) }, sleep = null }) {
  let apiMade = 0;
  const loop = createOwnerCallLoop({
    paths: { state: '/nonexistent' },
    readConfig: () => ({ ...readOwnerCallConfig({ state: '/nonexistent' }), enabled }),
    readSecrets: () => secrets,
    roninLocked: () => ronin,
    api: () => { apiMade += 1; return { ...transport, pending: async () => { transport.calls.push(['pending']); return typeof pending === 'function' ? pending() : pending; } }; },
    mac, sessionId: 'sess-loop', ...clock(), ...(sleep ? { sleep } : {}), intervalMs: 1,
  });
  return { loop, apiMade: () => apiMade };
}

test('off → no polling at all; not Ronin or not set up → no polling either', async () => {
  const { mac } = fakeMac();
  for (const opts of [{ enabled: false }, { ronin: false }]) {
    const t = fakeTransport(msgStart);
    const { loop, apiMade } = loopWith({ ...opts, pending: { calls: [msgCall] }, mac, transport: t });
    const r = await loop.tick();
    assert.equal(r.off, true);
    assert.equal(apiMade(), 0); assert.equal(t.calls.length, 0);
  }
  const t = fakeTransport(msgStart);
  const { loop, apiMade } = loopWith({ pending: { calls: [msgCall] }, mac, transport: t, secrets: { handle: '', token: '' } });
  assert.equal((await loop.tick()).reason, 'not_set_up');
  assert.equal(apiMade(), 0);
  // The loop's run() stops at once when aborted and never polls while off.
  const ac = new AbortController();
  const off = loopWith({ enabled: false, pending: { calls: [msgCall] }, mac, transport: fakeTransport(msgStart), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
  const running = off.loop.run({ signal: ac.signal });
  await new Promise((r) => setTimeout(r, 5)); ac.abort(); await running;
  assert.equal(off.apiMade(), 0);
});

test('one call at a time, and one dial per request id per session', async () => {
  const { mac, log } = fakeMac({ heard: [{ text: 'fine' }, { text: 'fine' }] });
  let release;
  const gate = new Promise((r) => { release = r; });
  const t = fakeTransport(async (b) => { await gate; return msgStart; });
  const { loop } = loopWith({ pending: { calls: [msgCall, { ...msgCall, id: 'req-msg-2' }] }, mac, transport: t });
  const first = loop.tick();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(await loop.tick(), { busy: true }, 'a second tick while a call runs does nothing');
  release();
  assert.equal((await first).outcome, 'reply');
  assert.equal(t.calls.filter(([r]) => r === 'pending').length, 1);
  // The next tick takes the NEXT request; the first id is never dialled again in this session.
  const t2 = fakeTransport({ ...msgStart, id: 'req-msg-2' });
  Object.assign(t, { start: t2.start });
  await loop.tick();
  assert.equal(log.dialled.length, 2);
  assert.ok(loop.attempted.has('req-msg-1') && loop.attempted.has('req-msg-2'));
  const before = log.dialled.length;
  assert.deepEqual(await loop.tick(), { idle: true });
  assert.equal(log.dialled.length, before, 'no re-dial of an attempted id');
});

test('a 409 batch_busy start is a definite refusal: nothing dialled, and the request is tried again on a later tick', async () => {
  const { mac, log } = fakeMac();
  const t = fakeTransport(() => { throw new OwnerCallHttpError(409, 'batch_busy'); });
  const { loop } = loopWith({ pending: { calls: [msgCall] }, mac, transport: t });
  const first = await loop.tick();
  assert.equal(first.outcome, 'skipped');
  assert.equal(first.reason, 'batch_busy');
  await loop.tick();
  assert.equal(t.calls.filter(([r]) => r === 'start').length, 2, 'retried on the next tick');
  assert.equal(log.dialled.length, 0, 'never dialled');
});

test('a request whose start failed is not retried in this session (its outcome is uncertain)', async () => {
  const { mac, log } = fakeMac();
  const t = fakeTransport(() => { throw new Error('timeout'); });
  const { loop } = loopWith({ pending: { calls: [msgCall] }, mac, transport: t });
  assert.equal((await loop.tick()).outcome, 'start_failed');
  assert.deepEqual(await loop.tick(), { idle: true });
  assert.equal(t.calls.filter(([r]) => r === 'start').length, 1);
  assert.equal(log.dialled.length, 0);
});

// ── the Worker routes ───────────────────────────────────────────────────────────────────────────────────────────

test('routes: the Ronin base only, bearer token in a header, contract shapes', async () => {
  const sent = [];
  const fetchImpl = async (url, opts) => { sent.push({ url, opts }); return { ok: true, status: 200, json: async () => ({ ok: true, calls: [] }) }; };
  const api = createOwnerCallApi({ token: 'tok_fixture_0123456789', fetchImpl });
  await api.pending();
  await api.start({ id: 'r1', session_id: 's1' });
  await api.answered({ id: 'r1', session_id: 's1', connected_at: 5 });
  await api.missed({ id: 'r1', session_id: 's1' });
  await api.result({ id: 'r1', session_id: 's1', outcome: 'deny', transport_event_id: 'e1' });
  assert.equal(OWNER_CALL_BASE, 'https://www.ronininc.org');
  assert.deepEqual(sent.map((s) => `${s.opts.method} ${s.url}`), [
    'GET https://www.ronininc.org/api/owner-call/pending', 'POST https://www.ronininc.org/api/owner-call/start', 'POST https://www.ronininc.org/api/owner-call/answered',
    'POST https://www.ronininc.org/api/owner-call/missed', 'POST https://www.ronininc.org/api/owner-call/result',
  ]);
  assert.ok(sent.every((s) => s.opts.headers.authorization === 'Bearer tok_fixture_0123456789'));
  assert.ok(sent.every((s) => !s.url.includes('tok_fixture')));
  assert.deepEqual(JSON.parse(sent[2].opts.body), { id: 'r1', session_id: 's1', connected_at: 5 });
  assert.throws(() => createOwnerCallApi({ token: 'x', base: 'https://crm.orosolu.org' }), /only to https:\/\/www\.ronininc\.org/);
  const nothing = createOwnerCallApi({ token: 'x', fetchImpl: async () => ({ ok: false, status: 409, json: async () => ({ ok: false, error: 'nothing_to_send' }) }) });
  assert.deepEqual(await nothing.start({ id: 'r', session_id: 's' }), { ok: false, error: 'nothing_to_send' });
  const denied = createOwnerCallApi({ token: 'x', fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ ok: false, error: 'unauthorized' }) }) });
  await assert.rejects(denied.pending(), (e) => e.status === 401);
});

test('Keychain: handle and token saved under ronin-crm-prod through stdin, never argv', () => {
  const store = {}; const calls = [];
  const run = (args, input) => {
    calls.push({ args, input });
    if (args[0] === '-i') { const m = input.match(/-a "([^"]+)" .* -w "([^"]+)"\n$/); store[m[1]] = m[2]; return { status: 0, stdout: '' }; }
    if (args[0] === 'find-generic-password') { const a = args[args.indexOf('-a') + 1]; return store[a] ? { status: 0, stdout: `${store[a]}\n` } : { status: 44, stdout: '' }; }
    return { status: 0, stdout: '' };
  };
  const token = 'owner_call_tok_ABCDEFGHIJKLMNOP';
  saveOwnerCallSecrets({ handle: '(602) 555-0100', token }, { run });
  assert.ok(calls.every((c) => !c.args.join(' ').includes(token)), 'the token never rides on argv');
  assert.ok(calls.filter((c) => c.args[0] === '-i').every((c) => c.input.includes('-s "ronin-crm-prod"')));
  assert.deepEqual(readOwnerCallSecrets({ run }), { handle: '+16025550100', token });
  assert.throws(() => saveOwnerCallSecrets({ handle: 'ana', token }, { run }), /not a FaceTime handle/);
  assert.throws(() => saveOwnerCallSecrets({ handle: HANDLE, token: 'bad token "' }, { run }), /does not look like/);
});

// ── the Mac pieces (stubbed processes) ──────────────────────────────────────────────────────────────────────────

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stdin = { end() { child.stdinEnded = true; } };
  child.kill = () => { child.killed = true; };
  return child;
}

test('call detection: FaceTime duplex audio = connected; unsupported or exited = unknown', () => {
  const child = fakeChild();
  const w = createFaceTimeWatch({ executable: '/helper', exists: () => true, spawnImpl: () => child });
  assert.deepEqual(w.start(), { ok: true });
  assert.equal(w.connected(), null);
  child.stdout.emit('data', '{"event":"audio_activity","processes":[{"pid":1,"bundle":"com.apple.FaceTime","input":false,"output":true}]}\n');
  assert.equal(w.connected(), false, 'ringing (output only) is not connected');
  child.stdout.emit('data', '{"event":"audio_activity","processes":[{"pid":1,"bundle":"com.apple.FaceTime","input":true,"output":true},');
  child.stdout.emit('data', '{"pid":2,"bundle":"us.zoom.xos","input":true,"output":true}]}\n');
  assert.equal(w.connected(), true);
  child.stdout.emit('data', '{"event":"audio_activity","processes":[{"pid":2,"bundle":"us.zoom.xos","input":true,"output":true}]}\n');
  assert.equal(w.connected(), false, 'another app on a call is not our FaceTime call');
  child.emit('exit', 0);
  assert.equal(w.connected(), null);
  const none = createFaceTimeWatch({ executable: '/missing', exists: () => false });
  assert.deepEqual(none.start(), { ok: false, reason: 'helper_not_installed' });
});

test('recording: sox from the hear device as 16 kHz mono; stops at the end of an utterance or when the call drops', async () => {
  assert.deepEqual(recordArgs({ device: 'BlackHole 16ch', remix: '1,2' }), ['-q', '--buffer', '65536', '-t', 'coreaudio', 'BlackHole 16ch', '-t', 'raw', '-r', '16000', '-e', 'signed', '-b', '16', '-c', '1', '-', 'remix', '1,2']);
  const pcm = (ms, amp) => { const n = 16 * ms; const b = Buffer.alloc(n * 2); for (let i = 0; i < n; i += 1) b.writeInt16LE(i % 2 ? amp : -amp, i * 2); return b; };
  let spawned;
  const child = fakeChild();
  const got = listenOnce({ sox: '/opt/homebrew/bin/sox', device: 'BlackHole 16ch', maxMs: 8000, pollMs: 5, spawnImpl: (cmd, args) => { spawned = [cmd, args]; return child; } });
  child.stdout.emit('data', pcm(300, 0));
  child.stdout.emit('data', pcm(600, 6000));
  child.stdout.emit('data', pcm(1500, 0));
  const r = await got;
  assert.equal(spawned[0], '/opt/homebrew/bin/sox');
  assert.equal(r.hangup, false);
  assert.ok(r.samples.length > 16 * 500);
  assert.equal(child.killed, true, 'sox is stopped once the utterance ends');
  let up = true;
  const child2 = fakeChild();
  const dropped = listenOnce({ sox: 'sox', device: 'd', maxMs: 8000, pollMs: 5, connected: () => up, spawnImpl: () => child2 });
  child2.stdout.emit('data', pcm(100, 0));
  up = false;
  assert.deepEqual(await dropped, { samples: null, hangup: true });
  const child3 = fakeChild();
  const broken = listenOnce({ sox: 'sox', device: 'Nope', maxMs: 8000, pollMs: 5, spawnImpl: () => child3 });
  child3.stderr.emit('data', 'sox FAIL formats: can\'t open input  `Nope\'');
  child3.emit('exit', 2);
  await assert.rejects(broken, /could not record from "Nope"/);
});

test('speaking goes into the speak device (say -a fallback when Kokoro is unavailable), never the default output', async () => {
  const spawned = [];
  const spawnImpl = (cmd, args) => { spawned.push([cmd, args]); const c = fakeChild(); setImmediate(() => c.emit('exit', 0)); return c; };
  const runners = createMacRunners({
    paths: { state: '/x', resources: '/r', voice: {} }, config: readOwnerCallConfig({ state: '/nonexistent' }), spawnImpl,
    exists: (p) => p === '/opt/homebrew/bin/sox', synth: async () => null,
  });
  await runners.speak('This is Grok, for Ronin.', voiceForCaller('grok')).done;
  assert.deepEqual(spawned.at(-1), ['/usr/bin/say', ['-a', 'BlackHole 2ch', '-v', 'Fred', 'This is Grok, for Ronin.']]);
  const withKokoro = createMacRunners({
    paths: { state: '/x', resources: '/r', voice: {} }, config: readOwnerCallConfig({ state: '/nonexistent' }), spawnImpl,
    exists: (p) => p === '/opt/homebrew/bin/sox', synth: async (line, { voice }) => { assert.equal(voice, 'af_heart'); return { out: '/tmp/none/reply.wav', dir: '/tmp/none-owner-call-test' }; },
  });
  await withKokoro.speak('Hello.', voiceForCaller('claude')).done;
  assert.deepEqual(spawned.at(-1), ['/opt/homebrew/bin/sox', ['-q', '/tmp/none/reply.wav', '-t', 'coreaudio', 'BlackHole 2ch']]);
  assert.ok(spawned.every(([cmd]) => cmd !== '/usr/bin/afplay'), 'nothing plays to the Mac\'s own speakers');
});

test('confirm and end the call through osascript (System Events), injectable', async () => {
  const runs = [];
  const runners = createMacRunners({ paths: { state: '/x', resources: '/r', voice: {} }, config: readOwnerCallConfig({ state: '/nonexistent' }), run: async (cmd, args) => { runs.push([cmd, args]); return { code: 0, out: 'ok' }; } });
  await runners.confirmPrompt();
  await runners.endCall();
  assert.equal(runs[0][0], '/usr/bin/osascript');
  assert.ok(runs[0][1].some((l) => l.includes('tell application "System Events"')));
  assert.deepEqual(runs[0][1].slice(-2), ['Call', '12']);
  assert.ok(runs[1][1].includes('    tell application "FaceTime" to quit'));
  assert.deepEqual(runs[1][1].slice(-1), ['End']);
});

// ── doctor and CLI ──────────────────────────────────────────────────────────────────────────────────────────────

const PROFILER = JSON.stringify({ SPAudioDataType: [{ _name: 'coreaudio_device', _items: [
  { _name: 'MacBook Pro Speakers', coreaudio_device_output: 2 },
  { _name: 'BlackHole 2ch', coreaudio_device_input: 2, coreaudio_device_output: 2 },
  { _name: 'Multi-Output Device', coreaudio_device_output: 2 },
] }] });

function doctorRun({ profiler = PROFILER, ax = { code: 0, out: 'true\n', err: '' } } = {}) {
  return async (cmd) => {
    if (cmd === '/usr/bin/sw_vers') return { code: 0, out: '14.5\n', err: '' };
    if (cmd.endsWith('/sox')) return { code: 0, out: 'AUDIO DEVICE DRIVERS: coreaudio\n', err: '' };
    if (cmd === '/usr/sbin/system_profiler') return { code: 0, out: profiler, err: '' };
    if (cmd === '/usr/bin/osascript') return ax;
    return { code: 1, out: '', err: '' };
  };
}

test('doctor names exactly what is missing (here: BlackHole 16ch and Accessibility)', async () => {
  assert.deepEqual(audioDevicesFrom(JSON.parse(PROFILER)).map((d) => d.name), ['MacBook Pro Speakers', 'BlackHole 2ch', 'Multi-Output Device']);
  const paths = { state: '/nonexistent', resources: '/R', voice: { whisper: '/R/w', sttModel: '/R/m', kokoro: '/R/k' } };
  const report = await ownerCallDoctor({
    paths, config: readOwnerCallConfig(paths), secrets: { handle: HANDLE, token: 'tok' }, roninLocked: () => true,
    exists: () => true, run: doctorRun({ ax: { code: 1, out: '', err: 'execution error: System Events got an error: osascript is not allowed assistive access. (-1719)' } }),
  });
  assert.equal(report.ok, false);
  assert.deepEqual(report.failures, ['"BlackHole 16ch" (Kingmaker hears the call through it)', 'Accessibility: Kingmaker may press FaceTime\'s Call and End buttons']);
  const fix = report.rows.find((r) => r.label.startsWith('"BlackHole 16ch"')).fix;
  assert.match(fix, /brew install blackhole-16ch/);
  const good = await ownerCallDoctor({
    paths, config: readOwnerCallConfig(paths), secrets: { handle: HANDLE, token: 'tok' }, roninLocked: () => true, exists: () => true,
    run: doctorRun({ profiler: JSON.stringify({ SPAudioDataType: [{ _items: [...JSON.parse(PROFILER).SPAudioDataType[0]._items, { _name: 'BlackHole 16ch', coreaudio_device_input: 16, coreaudio_device_output: 16 }] }] }) }),
  });
  assert.deepEqual(good.failures, []);
  const noRonin = await ownerCallDoctor({ paths, config: readOwnerCallConfig(paths), secrets: { handle: '', token: '' }, roninLocked: () => false, exists: () => false, run: async () => ({ code: 1, out: '', err: '' }) });
  assert.ok(noRonin.failures.includes('Ronin install (owner calls are Ronin only)'));
  assert.ok(noRonin.failures.includes('owner handle saved'));
});

test('CLI: Ronin only; `on` refuses until doctor passes; `test` dials only after a typed "call me"', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'km-owner-call-cli-'));
  const paths = { state: join(dir, 'state') };
  const out = []; const err = [];
  const base = { paths, out: (l) => out.push(l), err: (l) => err.push(l), secrets: { handle: HANDLE, token: 't'.repeat(32) } };
  assert.equal(await ownerCallCommand(['setup'], { ...base, roninLocked: () => false, readAnswer: async () => { throw new Error('must not ask'); } }), 2);
  assert.match(err.at(-1), /Ronin only/);
  assert.equal(await ownerCallCommand(['on'], { ...base, roninLocked: () => true, doctor: async () => ({ ok: false, rows: [{ ok: false, required: true, label: 'x', fix: 'y' }], failures: ['x'] }) }), 1);
  assert.equal(readOwnerCallConfig(paths).enabled, false);
  assert.equal(await ownerCallCommand(['on'], { ...base, roninLocked: () => true, doctor: async () => ({ ok: true, rows: [], failures: [] }) }), 0);
  assert.equal(readOwnerCallConfig(paths).enabled, true);
  assert.equal(await ownerCallCommand(['off'], { ...base }), 0);
  assert.equal(readOwnerCallConfig(paths).enabled, false);
  let placed = 0;
  const place = async (call, opts) => { placed += 1; assert.equal(call.kind, 'message'); assert.equal(opts.handle, HANDLE); return { outcome: 'reply' }; };
  for (const typed of ['', 'yes', 'call', 'CALL ME']) {
    assert.equal(await ownerCallCommand(['test'], { ...base, roninLocked: () => true, doctor: async () => ({ ok: true, rows: [], failures: [] }), readAnswer: async () => typed, place, macFor: () => ({}) }), 1);
  }
  assert.equal(placed, 0, 'no call without the exact typed confirmation');
  assert.equal(await ownerCallCommand(['test'], { ...base, roninLocked: () => true, doctor: async () => ({ ok: true, rows: [], failures: [] }), readAnswer: async () => 'call me', place, macFor: () => ({}) }), 0);
  assert.equal(placed, 1);
  // setup refuses a bad handle before asking for the token
  let askedToken = false;
  assert.equal(await ownerCallCommand(['setup'], { ...base, roninLocked: () => true, readAnswer: async () => 'ana', readHidden: async () => { askedToken = true; return Buffer.from('x'); } }), 1);
  assert.equal(askedToken, false);
  // status never prints the token or the full handle
  out.length = 0;
  await ownerCallCommand(['status'], { ...base, roninLocked: () => true });
  assert.ok(!out.join('\n').includes('t'.repeat(32)));
  assert.ok(!out.join('\n').includes(HANDLE));
});

test('daemon wiring: the loop starts only when owner calls are on; no system-audio capture entitlement is added', () => {
  const office = readFileSync(new URL('../office.mjs', import.meta.url), 'utf8');
  // Started once, when the Ronin office comes up (at start, or after the Mac pairs on the site).
  assert.match(office, /if \(!ownerCallsStarted && readOwnerCallConfig\(paths\)\.enabled\) \{\s*ownerCallsStarted = true;\s*void runOwnerCallLoop\(\{ paths, signal, log, phone: ringer \}\)/);
  const cli = readFileSync(new URL('../cli.mjs', import.meta.url), 'utf8');
  assert.match(cli, /if \(cmd === 'owner-call'\) return ownerCallCommand\(/);
  const src = readFileSync(new URL('../owner-call.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /from '\.\/phone\.mjs'|api\.twilio\.com/, 'never the Twilio path');
  const plist = readFileSync(new URL('../../../app/Info.plist', import.meta.url), 'utf8');
  assert.doesNotMatch(plist, /NSAudioCaptureUsageDescription/, 'BlackHole recording needs no process-tap entitlement');
});
