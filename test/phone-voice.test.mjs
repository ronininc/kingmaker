// The phone's call and walkie-talkie (lib/phone-voice.mjs, lib/phone-companion.mjs /voice/*): an utterance in, its words
// as an ordinary turn, Kingmaker's line spoken back in its own language; only a paired phone; nothing written to disk.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPhoneVoice, MAX_UTTERANCE_BYTES, pcmSamples } from '../lib/phone-voice.mjs';
import { createCompanion, PREVIEW_PAGES } from '../lib/phone-companion.mjs';

const pcm = (n, v = 1000) => { const b = Buffer.alloc(n * 2); for (let i = 0; i < n; i++) b.writeInt16LE(i % 2 ? v : -v, i * 2); return b; };

test('hear: raw 16 kHz PCM to words; silence, nothing and too much are ignored', async () => {
  const seen = [];
  const v = createPhoneVoice({ transcribe: async (s) => { seen.push(s); return '  hola,   ¿qué tal? '; } });
  assert.equal(await v.hear(pcm(16000)), 'hola, ¿qué tal?');
  assert.ok(seen[0] instanceof Int16Array && seen[0].length === 16000);
  assert.equal(seen[0][0], 0, 'the samples are wiped after use');
  assert.equal(await v.hear(Buffer.alloc(0)), '');
  assert.equal(await v.hear(Buffer.alloc(MAX_UTTERANCE_BYTES + 2)), '');
  assert.deepEqual([...pcmSamples(pcm(2, 7))], [-7, 7]);
});

test('speak: English with Kokoro, another language with the Mac voice for it', async () => {
  const calls = [];
  const v = createPhoneVoice({ kokoro: async (t) => (calls.push(['kokoro', t]), { bytes: Buffer.from('K'), type: 'audio/wav' }), say: async (t, voice) => (calls.push(['say', t, voice]), { bytes: Buffer.from('S'), type: 'audio/wav' }) });
  assert.equal(String((await v.speak('There are 11 files on your desktop.')).bytes), 'K');
  assert.equal(String((await v.speak('Hay 11 archivos en tu escritorio.')).bytes), 'S');
  assert.equal(calls[1][0], 'say');
  assert.equal(await v.speak('   '), null);
});

/** One HTTPS call with a raw body. */
function call(ca, port, { method = 'GET', path, cookie = null, body = null, type = 'application/json' }) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, ca, agent: false, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': type } : {}) } }, (res) => {
      const parts = []; res.on('data', (d) => parts.push(d)); res.on('end', () => { const buf = Buffer.concat(parts); let json = null; try { json = JSON.parse(buf); } catch { /* not JSON */ } resolve({ status: res.statusCode, headers: res.headers, buf, json }); });
    });
    req.on('error', reject); req.end(body ?? undefined);
  });
}

test('the call routes: only a paired phone; its words become a turn; the answer comes back as audio', { timeout: 60_000 }, async (t) => {
  const state = mkdtempSync(join(tmpdir(), 'km-phone-voice-'));
  const turns = [];
  const voice = { hear: async (buf) => (buf.length ? 'what is on my calendar' : ''), speak: async (text) => ({ bytes: Buffer.from(`WAV:${text}`), type: 'audio/wav' }) };
  const companion = createCompanion({ state, port: 0, setupPort: 0, host: 'localhost', icon: null, onTurn: async (text) => { turns.push(text); }, voice });
  t.after(async () => { await companion.stop(); rmSync(state, { recursive: true, force: true }); });
  const up = await companion.start(), port = Number(new URL(up.app).port), ca = readFileSync(join(state, 'phone-tls', 'ca.pem'));
  assert.equal((await call(ca, port, { method: 'POST', path: '/voice/turn', body: pcm(8000), type: 'application/octet-stream' })).status, 401, 'not paired: refused');
  const link = (await call(ca, port, { method: 'POST', path: '/admin/pair-link' })).json.link;
  const paired = await call(ca, port, { path: `/?pair=${/#pair=([a-f0-9]{32})$/.exec(link)[1]}` });
  const cookie = /km=[a-f0-9]{48}/.exec(String(paired.headers['set-cookie']))[0];
  const r = await call(ca, port, { method: 'POST', path: '/voice/turn', cookie, body: pcm(8000), type: 'application/octet-stream' });
  assert.equal(r.status, 200); assert.deepEqual(r.json, { ok: true, heard: 'what is on my calendar' });
  assert.deepEqual(turns, ['what is on my calendar'], 'the words went in as a turn (every gate applies)');
  const silent = await call(ca, port, { method: 'POST', path: '/voice/turn', cookie, body: Buffer.alloc(0), type: 'application/octet-stream' });
  assert.deepEqual(silent.json, { ok: true, heard: '' }); assert.equal(turns.length, 1, 'silence is no turn');
  const said = await call(ca, port, { method: 'POST', path: '/voice/say', cookie, body: JSON.stringify({ text: 'Two things this afternoon.' }) });
  assert.equal(said.status, 200); assert.equal(said.headers['content-type'], 'audio/wav'); assert.equal(String(said.buf), 'WAV:Two things this afternoon.');
});

test('the call screen: the pulsing crest, mute, voice, end, hold-to-talk, the fallback, and no forbidden name', () => {
  const html = PREVIEW_PAGES.app();
  for (const id of ['call', 'orb', 'muteB', 'endB', 'sndB', 'ptt', 'mode', 'callB']) assert.ok(html.includes(`id="${id}"`), id);
  assert.match(html, /echoCancellation:true/); assert.match(html, /wakeLock/); assert.match(html, /toWalkie\(/);
  assert.match(html, /visibilitychange[\s\S]{0,120}toWalkie/, 'backgrounded: the call becomes hold-to-talk');
  assert.match(html, /function fit\(\)/, 'the device profile applies itself');
  assert.doesNotMatch(html + readFileSync(new URL('../lib/phone-voice.mjs', import.meta.url), 'utf8'), /jarvis/i);
});
