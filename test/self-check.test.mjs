import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { buildHealthSnapshot, createHealthReporter, createMicProbe, ghostPermissions, parseGhostStatus, readFoundation, SNAPSHOT_STALE_MS } from '../lib/health.mjs';
import { resolvePaths } from '../lib/paths.mjs';
import { ghostBackendEnv } from '../lib/profile.mjs';
import { createUtteranceHandler, createWakeState, startVoiceLoop } from '../lib/voice.mjs';
import { createVoiceTurnLedger, tallyVoiceTurns, voiceTurnRecord, voiceTurnsPath } from '../lib/voice-ledger.mjs';

const secrets = { nonce: 'a'.repeat(64), voiceKey: 'b'.repeat(64) };
const tick = () => new Promise((r) => setImmediate(r));

test('the core reads Kingmaker\'s own voice-turn ledger (SOLOMON_VOICE_TURNS_PATH in its userData)', () => {
  const paths = resolvePaths({ SOL_GHOST_HOME: '/tmp/sg-state' }, '/Users/owner', { exists: () => false });
  const env = ghostBackendEnv({ env: { PATH: '/usr/bin' }, paths, port: 3001, secrets, ghostBin: null });
  assert.equal(env.SOLOMON_VOICE_TURNS_PATH, '/tmp/sg-state/voice-turns.jsonl');
  assert.equal(voiceTurnsPath(paths), env.SOLOMON_VOICE_TURNS_PATH, 'the loop writes the file the core reads');
});

test('ledger records are the window app\'s shape, lengths only, and the server\'s tally counts them', () => {
  const rec = voiceTurnRecord({ seq: 3, startedAtMs: 1_000, endedAtMs: 4_500, outcome: 'completed', route: 'research', transcriptChars: 21, answerChars: 140, spoke: true }, { version: '0.1.0', pid: 42 });
  for (const key of ['turn', 'startedAtMs', 'durationMs', 'outcome', 'reachedState', 'endedAt', 'stalledAt', 'reason', 'route', 'internetUsed', 'transcriptChars', 'answerChars', 'disposition', 'speechRuntimes', 'audiblePlaybackConfirmed', 'events', 'processId', 'appVersion', 'startedAt']) {
    assert.ok(key in rec, key);
  }
  assert.equal(rec.durationMs, 3_500);
  assert.equal(rec.reachedState, 'SPEAKING');
  assert.equal(rec.stalledAt, null);
  assert.equal(rec.startedAt, new Date(1_000).toISOString());
  const failed = voiceTurnRecord({ outcome: 'failed', reason: 'http_500', startedAtMs: 1 });
  assert.equal(failed.stalledAt, 'SUBMITTING_GOVERNED_TURN');
  const text = [rec, failed, voiceTurnRecord({ outcome: 'aborted', startedAtMs: 2 }), rec].map((r) => JSON.stringify(r)).join('\n') + '\n{"torn":';
  assert.deepEqual(tallyVoiceTurns(text), { total: 3, completed: 2, failed: 1, aborted: 1 });

  const lines = [];
  const ledger = createVoiceTurnLedger({ path: '/x/voice-turns.jsonl', append: (p, line) => lines.push({ p, line }), mkdir: () => {}, now: () => 9_000 });
  ledger.record({ startedAtMs: 8_000, outcome: 'completed', transcriptChars: 5 });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].p, '/x/voice-turns.jsonl');
  assert.equal(JSON.parse(lines[0].line).durationMs, 1_000);
  assert.equal(createVoiceTurnLedger({ path: '/x', append: () => { throw new Error('disk full'); }, mkdir: () => {} }).record({ outcome: 'completed' }), null, 'a write failure never throws into a turn');
});

test('the voice loop records each command it sends (completed or failed), never the words', async () => {
  const turns = [];
  const wake = createWakeState({ wakePhrases: ['ghost'] });
  let next = { ok: true, route: 'chat', answerChars: 12, spoke: true };
  const handle = createUtteranceHandler({
    wake, say: async () => {}, transcribe: async () => 'ghost what is the weather like',
    onCommand: async () => { if (next instanceof Error) throw next; return next; },
    onTurn: (t) => turns.push(t), now: () => 5_000,
  });
  await handle({ samples: new Int16Array(4), speechMs: 900 });
  next = { ok: false, reason: 'http_502' };
  await handle({ samples: new Int16Array(4), speechMs: 900 });
  next = new Error('core down');
  await assert.rejects(handle({ samples: new Int16Array(4), speechMs: 900 }));
  assert.deepEqual(turns.map((t) => t.outcome), ['completed', 'failed', 'failed']);
  assert.equal(turns[0].transcriptChars, 'what is the weather like'.length);
  assert.equal(turns[0].answerChars, 12);
  assert.equal(turns[1].reason, 'http_502');
  assert.equal(turns[2].reason, 'turn_error');
  assert.ok(turns.every((t) => !JSON.stringify(t).includes('weather')), 'lengths only');
});

test('the microphone\'s real state: audio → granted; only digital silence → denied; no capture → unavailable', () => {
  const seen = [];
  const probe = createMicProbe({ onChange: (s) => seen.push(s) });
  for (let i = 0; i < 9; i += 1) probe.push(0, 300);
  assert.equal(probe.state, 'unknown', 'under 3 s of silence proves nothing');
  probe.push(0, 300);
  assert.equal(probe.state, 'denied');
  probe.push(0, 300);
  probe.push(412, 300);
  assert.equal(probe.state, 'granted');
  probe.push(0, 60_000);
  assert.equal(probe.state, 'granted', 'a quiet room after real audio is still a granted mic');
  assert.deepEqual(seen, ['denied', 'granted']);
  const none = createMicProbe();
  none.exited();
  assert.equal(none.state, 'unavailable');
});

test('Accessibility and Screen Recording come from ghost-os\'s own status', async () => {
  const out = 'Ghost OS v2.2.1\n\nAccessibility: granted\nScreen Recording: granted\nRecipes: 4 installed\n\nStatus: Ready\n';
  assert.deepEqual(parseGhostStatus(out), { accessibility: 'granted', screen: 'granted' });
  assert.deepEqual(parseGhostStatus('Accessibility: NOT granted\nScreen Recording: not granted'), { accessibility: 'not_granted', screen: 'denied' });
  assert.deepEqual(parseGhostStatus('garbage'), { accessibility: 'unknown', screen: 'unknown' });
  assert.deepEqual(await ghostPermissions(null), { accessibility: 'unavailable', screen: 'unknown' }, 'no ghost-os: nothing can drive apps');
  const calls = [];
  const got = await ghostPermissions('/opt/homebrew/bin/ghost', { exec: (bin, args, _o, cb) => { calls.push([bin, ...args]); cb(null, out); } });
  assert.deepEqual(calls, [['/opt/homebrew/bin/ghost', 'status']]);
  assert.deepEqual(got, { accessibility: 'granted', screen: 'granted' });
});

test('the snapshot is the window app\'s DesktopHealthSnapshot shape, from what Kingmaker observed', () => {
  const up = buildHealthSnapshot({ voice: 'listening', mic: 'granted', accessibility: 'granted', screen: 'granted', tally: { completed: 4, failed: 1 } });
  assert.deepEqual(up.voice, { runtimePipeline: 'READY', armed: true, physicalConversation: 'PROVEN', liveCompleted: 4, liveFailed: 1, flags: ['sol-ghost-snapshot'] });
  assert.deepEqual(up.permissions, { microphone: 'granted', accessibility: 'granted', screen: 'granted' });
  assert.equal('foundation' in up, false, 'no manifest, no foundation layer (it stays UNREPORTED, never invented)');
  assert.equal(buildHealthSnapshot({ voice: 'listening', mic: 'denied' }).voice.runtimePipeline, 'DEGRADED');
  assert.ok(buildHealthSnapshot({ voice: 'listening', mic: 'denied' }).voice.flags.includes('mic-silent-capture'));
  assert.equal(buildHealthSnapshot({ voice: 'off' }).voice.runtimePipeline, 'UNWIRED');
  assert.equal(buildHealthSnapshot({ voice: 'failed' }).voice.runtimePipeline, 'DEGRADED');
  assert.equal(buildHealthSnapshot({ voice: 'starting' }).voice.physicalConversation, 'NOT_TESTED');
  const foundation = readFoundation('/x', () => JSON.stringify({ capabilities: [{ id: 'voice', label: 'Voice', wired: 1, packaged: true, present: false }] }));
  assert.deepEqual(foundation, [{ id: 'voice', label: 'Voice', proof: 'MANIFEST', wired: true, packaged: true, present: false }]);
  assert.equal(readFoundation('/missing', () => { throw new Error('ENOENT'); }), null);
});

test('posted at start and on change only; one follow-up absorbs a burst; refreshed before a turn only when stale', async () => {
  let clock = 0;
  const posts = [];
  let release;
  let hold = false;
  const reporter = createHealthReporter({
    now: () => clock,
    post: async (desktop, opts) => { posts.push({ desktop, opts }); if (hold) await new Promise((r) => { release = r; }); return true; },
  });
  await reporter.update({ voice: 'off' });
  assert.equal(posts.length, 1, 'the first observation is the start snapshot');
  await reporter.update({ voice: 'off' });
  assert.equal(posts.length, 1, 'nothing changed, nothing posted');
  hold = true;
  const first = reporter.update({ voice: 'listening' });
  await tick();
  void reporter.update({ mic: 'granted' });
  void reporter.update({ accessibility: 'granted' });
  hold = false;
  release();
  await first;
  for (let i = 0; i < 5; i += 1) await tick();
  assert.equal(posts.length, 3, 'two changes while one post was in flight became one follow-up');
  assert.deepEqual(posts.at(-1).desktop.permissions, { microphone: 'granted', accessibility: 'granted', screen: 'unknown' });
  clock += SNAPSHOT_STALE_MS - 1;
  await reporter.refresh();
  assert.equal(posts.length, 3, 'still fresh on the server');
  clock += 1;
  await reporter.refresh();
  assert.equal(posts.length, 4, 'about to lapse: posted before the turn');
  assert.equal(posts.at(-1).opts.timeoutMs, 2_000, 'and quickly');
  await reporter.repost();
  assert.equal(posts.length, 5, 'a restarted core gets it again');
});

test('the live loop reports the mic from its actual capture (a fake capture, no real microphone)', async () => {
  const states = [];
  const mic = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => {} });
  const loop = startVoiceLoop({ listenWhileAsleep: true,
    paths: { voice: { whisper: '/w', sttModel: '/m', wakeKeywords: [] } },
    exists: () => true, onCommand: async () => ({}), say: async () => {}, isSpeaking: () => false,
    onMic: (s) => states.push(s), openMic: () => mic,
  });
  assert.equal(loop.ok, true);
  const silence = Buffer.alloc(32_000); // 1 s of 16 kHz s16le zeros
  for (let i = 0; i < 3; i += 1) mic.stdout.emit('data', silence);
  assert.deepEqual(states, ['denied']);
  const voiced = Buffer.alloc(3_200);
  for (let i = 0; i < voiced.length; i += 2) voiced.writeInt16LE(i % 4 ? 900 : -900, i);
  mic.stdout.emit('data', voiced);
  assert.deepEqual(states, ['denied', 'granted']);
  loop.stop();

  const none = [];
  const off = startVoiceLoop({ listenWhileAsleep: true, paths: { voice: { whisper: '/w', sttModel: '/m', wakeKeywords: [] } }, exists: () => true, onCommand: async () => ({}), say: async () => {}, isSpeaking: () => false, onMic: (s) => none.push(s), openMic: () => null });
  assert.equal(off.ok, false);
  assert.deepEqual(none, ['unavailable']);
});
