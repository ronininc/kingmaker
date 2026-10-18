import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { createInteractionArbiter, frontmostInteractionOwner, INTERACTION_EVENT_MAX, normalizeInteractionOwner } from '../lib/interaction-owner.mjs';
import { createOwnerSession } from '../lib/session.mjs';
import { runVoiceCommandUnderInteractionLease, startVoiceLoop } from '../lib/voice.mjs';

const paths = () => ({ state: mkdtempSync(join(tmpdir(), 'kingmaker-owner-')) });

test('only ChatGPT and Codex can own the external governed interaction', () => {
  assert.equal(normalizeInteractionOwner('ChatGPT'), 'chatgpt');
  assert.equal(normalizeInteractionOwner('Codex'), 'codex');
  assert.equal(normalizeInteractionOwner('Kingmaker'), null);
  assert.equal(frontmostInteractionOwner({ exec: () => 'ChatGPT\n' }), 'chatgpt');
  assert.equal(frontmostInteractionOwner({ exec: () => 'Safari\n' }), null);
});

test('suppressed intent is private, bounded and isolated to this local profile', () => {
  const p = paths();
  const arbiter = createInteractionArbiter({ paths: p, initialOwner: 'codex', now: () => '2026-10-10T00:00:00.000Z' });
  for (let i = 0; i < INTERACTION_EVENT_MAX + 8; i += 1) arbiter.route('wake_suppressed', `event ${i}`);
  const lines = readFileSync(arbiter.file, 'utf8').trim().split('\n');
  assert.equal(lines.length, INTERACTION_EVENT_MAX);
  assert.equal(JSON.parse(lines.at(-1)).text, `event ${INTERACTION_EVENT_MAX + 7}`);
  assert.equal(statSync(arbiter.file).mode & 0o777, 0o600);
  assert.ok(arbiter.file.startsWith(p.state));
  assert.ok(!arbiter.file.toLowerCase().includes('acme'));
});

test('session narration is silent and routed while Codex owns the interaction', async () => {
  const arbiter = createInteractionArbiter({ paths: paths(), initialOwner: 'codex' });
  const spoken = [];
  const session = createOwnerSession({
    port: 1, secrets: { nonce: 'n'.repeat(64) }, runtimeHome: null, out: () => {},
    turnImpl: async () => ({ ok: true, spoken: 'The app scan is complete.', confirmationRequired: false, raw: { data: {} } }),
    speakImpl: (line) => { spoken.push(line); return { done: Promise.resolve(), stop: () => {} }; },
    narrationGate: () => arbiter.gate('narration'),
    onNarrationSuppressed: ({ text }) => arbiter.route('narration_suppressed', text),
  });
  const result = await session.runTurn('scan apps', { owner: true });
  assert.deepEqual(spoken, []);
  assert.equal(result.spoke, false);
  assert.match(readFileSync(arbiter.file, 'utf8'), /The app scan is complete/);
});

test('a leased voice command never reaches Kingmaker brain context', async () => {
  let called = 0;
  const routed = [];
  const result = await runVoiceCommandUnderInteractionLease('explain the app scan', {}, {
    interactionOwner: () => 'chatgpt',
    onSuppressed: (event) => routed.push(event),
    onCommand: async () => { called += 1; return { ok: true }; },
  });
  assert.equal(called, 0, 'no competing Kingmaker turn/context');
  assert.equal(result.suppressed, 'chatgpt');
  assert.equal(routed[0].text, 'explain the app scan');
});

test('wake and microphone are suppressed during the lease, then restored after release', async () => {
  let owner = 'chatgpt';
  const opened = [];
  const said = [];
  const suppressed = [];
  const fakeMic = () => { const mic = new EventEmitter(); mic.stdout = new EventEmitter(); mic.stderr = new EventEmitter(); mic.kill = () => { mic.killed = true; }; opened.push(mic); return mic; };
  const loop = startVoiceLoop({
    paths: { voice: { whisper: '/w', sttModel: '/m', wakeKeywords: [] } }, exists: () => true,
    onCommand: async () => ({ ok: true }), say: async (line) => { said.push(line); }, isSpeaking: () => false,
    openMic: ({ probe }) => (probe ? true : fakeMic()), interactionOwner: () => owner, onSuppressed: (event) => suppressed.push(event),
  });
  const blocked = await loop.wakeNow();
  assert.equal(blocked.suppressed, 'chatgpt');
  assert.equal(loop.isListening(), false);
  assert.deepEqual(said, []);
  owner = null;
  loop.ownerChanged();
  const awake = await loop.wakeNow();
  assert.equal(awake.awake, true);
  assert.equal(loop.isListening(), true);
  assert.deepEqual(said, ["I'm here."]);
  assert.ok(suppressed.some((event) => event.type === 'wake_suppressed'));
  loop.stop();
});

test('the app reports foreground ownership and never releases it on its own menu activation', () => {
  const swift = readFileSync(new URL('../app/Kingmaker.swift', import.meta.url), 'utf8');
  assert.match(swift, /didActivateApplicationNotification/);
  assert.ok(swift.includes('interaction-owner \\(owner)\\n'));
  assert.match(swift, /active == "kingmaker" \{ return \}/);
  assert.match(swift, /active == "chatgpt"/);
  assert.match(swift, /active == "codex"/);
});
