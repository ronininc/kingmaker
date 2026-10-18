// Voice authority: what Kingmaker hears while awake is the owner's word (no voiceprint gate), proven on the
// wire against a fake engine that records each /api/conversation/turn request.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createOwnerSession, resolveVoiceAuthority, turnWire } from '../lib/session.mjs';
import { DESKTOP_NONCE_HEADER } from '../lib/profile.mjs';
import { createWakeState } from '../lib/voice.mjs';

test('turnWire: spoken turns never go as mode voice; owner authority carries the nonce, propose does not', () => {
  assert.deepEqual(turnWire({ owner: false, mode: 'voice' }), { mode: 'text', owner: true, spoken: true });
  assert.deepEqual(turnWire({ owner: false, mode: 'voice', voiceAuthority: 'propose' }), { mode: 'text', owner: false, spoken: true });
  assert.deepEqual(turnWire({ owner: true }), { mode: 'text', owner: true, spoken: false });
  assert.deepEqual(turnWire({ owner: false }), { mode: 'text', owner: false, spoken: false }, 'a non-console text turn stays a local program');
  assert.equal(resolveVoiceAuthority({}), 'owner');
  assert.equal(resolveVoiceAuthority({ SOL_GHOST_VOICE_AUTHORITY: 'propose' }), 'propose');
  assert.equal(resolveVoiceAuthority({ SOL_GHOST_VOICE_AUTHORITY: 'anything-else' }), 'owner');
});

test('"wake up" while awake is answered locally, never sent as a command; asleep it does nothing', () => {
  const w = createWakeState();
  assert.equal(w.handle('wake up', 0).action, 'ignore', 'asleep: a bare "wake up" (anyone, the TV) does not wake it');
  assert.equal(w.handle('Ghost, wake up.', 1).action, 'wake');
  assert.equal(w.handle('Wake up.', 2).action, 'wake', 'awake: "wake up" is a check, not a command');
  assert.equal(w.handle('Are you there?', 3).action, 'wake');
  assert.deepEqual(w.handle('open up YouTube on my Chrome.', 4), { action: 'command', text: 'open up YouTube on my Chrome.' });
  assert.deepEqual(w.handle('Ghost open my Chrome.', 5), { action: 'command', text: 'open my Chrome.', woke: true }, 'a leading "Ghost" is an address, stripped');
});

async function fakeEngine() {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ path: req.url, nonce: req.headers[DESKTOP_NONCE_HEADER] ?? null, body: body ? JSON.parse(body) : null });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(req.url.startsWith('/api/conversation/turn') ? { data: { spokenResponse: 'ok', conversationId: 'c1' } } : { data: { proposals: [] } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { seen, port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

test('on the wire: a spoken turn carries the launch nonce as text (owner); under propose it carries none', async () => {
  const fake = await fakeEngine();
  try {
    const secrets = { nonce: 'n'.repeat(64), voiceKey: 'k'.repeat(64) };
    const owner = createOwnerSession({ port: fake.port, secrets, runtimeHome: null, voiceOut: false, out: () => {} });
    await owner.runTurn('press Seven in Calculator', { owner: false, mode: 'voice' });
    await owner.runTurn('yes', { owner: false, mode: 'voice' });
    const propose = createOwnerSession({ port: fake.port, secrets, runtimeHome: null, voiceOut: false, out: () => {}, voiceAuthority: 'propose' });
    await propose.runTurn('press Seven in Calculator', { owner: false, mode: 'voice' });
    const turns = fake.seen.filter((s) => s.path.startsWith('/api/conversation/turn'));
    assert.equal(turns.length, 3);
    assert.deepEqual(turns.map((t) => [t.body.mode, t.nonce === secrets.nonce, t.body.userText]), [
      ['text', true, 'press Seven in Calculator'],
      ['text', true, 'yes'],
      ['text', false, 'press Seven in Calculator'],
    ]);
    assert.ok(turns.every((t) => t.body.mode !== 'voice'), 'never mode voice: the engine would demote it to unverified_voice');
  } finally { await fake.close(); }
});
