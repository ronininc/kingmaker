// The bottom-centre transcript line (Kingmaker.app TranscriptPanel) only ever receives words the voice loop accepted
// while awake AND the owner-voice check attested: never speech heard asleep, non-speech, a bystander's words, or a turn
// with no voice check. The words travel in the "heard" field.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUtteranceHandler, createWakeState } from '../lib/voice.mjs';

function rig({ owner = true, attest = true } = {}) {
  const states = [];
  const wake = createWakeState({ wakePhrases: ['ghost wake up', 'ghost'], idleMs: 60_000 });
  const heard = new Map();
  const handle = createUtteranceHandler({
    wake, transcribe: async (samples) => heard.get(samples),
    onCommand: async () => ({ ok: true }), say: async () => {},
    ...(attest ? { attest: () => (owner ? { token: 'solvox2.owner.mac', decision: { reason: 'owner_match' } } : { token: null, decision: { reason: 'not_owner' } }) } : {}),
    onState: (state, extra) => states.push({ state, ...(extra ?? {}) }),
  });
  const say = async (text) => { const s = new Float32Array(4); heard.set(s, text); await handle({ samples: s, speechMs: 1200 }); };
  return { states, wake, say };
}

test('an accepted command sends its words to the transcript line with the thinking state', async () => {
  const r = rig();
  r.wake.wake?.(); // awake already, or woken by the phrase below
  await r.say('ghost open the pull request for the reminder fix');
  const thinking = r.states.find((s) => s.state === 'thinking' && 'heard' in s);
  assert.ok(thinking, JSON.stringify(r.states));
  assert.match(thinking.heard, /open the pull request for the reminder fix/i);
  assert.ok(!/ghost/i.test(thinking.heard), 'the wake phrase itself is not shown');
});

test('speech heard while asleep and non-speech never reach the transcript line', async () => {
  const r = rig();
  r.wake.sleep?.();
  await r.say('my bank password is hunter2 and the meeting is private');
  await r.say('[BLANK_AUDIO]');
  assert.ok(r.states.every((s) => !('heard' in s)), JSON.stringify(r.states));
});

test('the words are capped at 280 characters', async () => {
  const r = rig();
  await r.say('ghost ' + 'old preamble '.repeat(30) + 'approve nothing without asking');
  const thinking = r.states.find((s) => s.state === 'thinking' && 'heard' in s);
  assert.ok(Array.from(thinking.heard).length <= 280);
  assert.ok(thinking.heard.startsWith('…') && thinking.heard.endsWith('approve nothing without asking'), 'the newest words survive the cap');
});

test('the cap never splits an emoji (a lone surrogate would drop the whole status line)', async () => {
  const r = rig();
  await r.say('ghost ' + 'a'.repeat(279) + '🙂 and more words');
  const thinking = r.states.find((s) => s.state === 'thinking' && 'heard' in s);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(thinking)));
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(thinking.heard), 'no lone high surrogate');
  assert.ok(Array.from(thinking.heard).length <= 280);
});

test('a bystander\'s accepted words never reach the transcript line', async () => {
  const r = rig({ owner: false });
  await r.say('ghost send the contract to the client now');
  assert.ok(r.states.some((s) => s.state === 'thinking'), 'the logo still shows it is working');
  assert.ok(r.states.every((s) => !('heard' in s)), JSON.stringify(r.states));
});

test('with no voice check configured, nothing is shown (fail closed)', async () => {
  const r = rig({ attest: false });
  await r.say('ghost open the pull request');
  assert.ok(r.states.every((s) => !('heard' in s)), JSON.stringify(r.states));
});

test('the words appear only after the check, never before it', async () => {
  const r = rig();
  await r.say('ghost open the pull request');
  const first = r.states.findIndex((s) => s.state === 'thinking');
  const shown = r.states.findIndex((s) => 'heard' in s);
  assert.ok(first >= 0 && shown > first, JSON.stringify(r.states));
});
