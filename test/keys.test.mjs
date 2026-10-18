// The owner console's owner-only calls and the terminal API-key flow (lib/client.mjs ownerCall, lib/keys.mjs).
// The engine, the vault, the browser opener, the hidden prompt and the voice are fakes; what is proven is what Sol
// Ghost itself does: who carries the nonce, which page opens, and that the key is nowhere but the one seal body.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ownerCall, turn } from '../lib/client.mjs';
import { callTool } from '../lib/mcp.mjs';
import { keyBytesUsable, matchProvider, openKeyPage, OWNER_NONCE_FILE, readHidden, readOwnerNonce, runKeyFlow, safePageUrl, sealBody, sealFromKeyField, trimBytes } from '../lib/keys.mjs';
import { DESKTOP_NONCE_HEADER } from '../lib/profile.mjs';
import { classifyLine, consoleKeyHandoff, createOwnerSession, keyArg } from '../lib/session.mjs';

const NONCE = 'c'.repeat(64);
const KEY = `ghp_TESTKEY${'Ab3'.repeat(10)}`;
const GITHUB = { id: 'github', label: 'GitHub', keyNoun: 'GitHub token', keyPageUrl: 'https://github.com/settings/personal-access-tokens/new', guidance: 'Name it, pick the repositories and read permissions you want me to have, then generate it and press copy.' };
const PROVIDERS = [GITHUB, { id: 'stripe', label: 'Stripe', keyNoun: 'Stripe key', keyPageUrl: 'https://dashboard.stripe.com/apikeys', guidance: 'A restricted key.' }, { id: 'acme-crm', label: 'Acme CRM', keyNoun: 'Acme CRM token', keyPageUrl: 'https://crm.acme.example/admin/#connections', guidance: 'Issue the token.' }];

/** Every form of the key a leak could take. */
function leaks(text, key = KEY) {
  const t = String(text);
  return [key, key.slice(8, 24), Buffer.from(key).toString('base64').replace(/=+$/, ''), Buffer.from(key).toString('hex'), encodeURIComponent(key)].some((n) => t.includes(n));
}

/** A fake engine: the key-handoff routes, recording every request. `seal` decides each /console/seal answer. */
function fakeEngine({ seal = () => ({ status: 200, body: { ok: true, data: { state: 'SEALED_AWAITING_CONFIRM', fingerprint: { last4: KEY.slice(-4) } } } }) } = {}) {
  const requests = [];
  const sealBodies = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const raw = init.body;
    const record = { path: u.pathname, method: init.method ?? 'GET', headers, bodyText: Buffer.isBuffer(raw) || raw instanceof Uint8Array ? null : raw ?? null };
    requests.push(record);
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (u.pathname === '/api/key-handoff/providers') return reply(200, { ok: true, data: { providers: PROVIDERS } });
    if (u.pathname === '/api/key-handoff/start') return reply(200, { ok: true, data: { id: 'keyhandoff_abc123', capture: 'console', state: 'AWAITING_COPY', providerInfo: GITHUB } });
    if (u.pathname === '/api/key-handoff/console/seal') {
      sealBodies.push({ ref: raw, copy: Buffer.from(raw).toString('utf8') });
      const r = seal(sealBodies.length);
      return reply(r.status, r.body);
    }
    if (/\/(cancel|decline)$/.test(u.pathname)) return reply(200, { ok: true, data: { state: u.pathname.endsWith('cancel') ? 'CANCELLED' : 'DECLINED', spoken: 'Okay. The GitHub token stays sealed and the connector stays off.' } });
    if (u.pathname.endsWith('/confirm')) return reply(200, { ok: true, data: { state: 'CONNECTED', spoken: 'GitHub is connected. The live test passed.' } });
    return reply(404, { ok: false });
  };
  return { fetchImpl, requests, sealBodies };
}

/** A recorder for everything the flow can say, print, log, or hand to a child process. */
function sinks() {
  const s = { out: [], spoken: [], logs: [], argv: [], keyBuffers: [] };
  s.out$ = (line) => s.out.push(line);
  s.speak$ = (line) => s.spoken.push(line);
  s.log$ = (event, detail) => s.logs.push(JSON.stringify({ event, ...detail }));
  s.launch$ = async (args) => { s.argv.push(args); return true; };
  s.paste = (...values) => async () => { const v = values.shift(); if (v === null || v === undefined) return null; const b = Buffer.from(v); s.keyBuffers.push(b); return b; };
  s.everything = () => [...s.out, ...s.spoken, ...s.logs, ...s.argv.flat()].join('\n');
  return s;
}

test('ownerCall: the nonce goes only on owner calls, and never without one', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push(init.headers); return new Response('{"ok":true}', { status: 200 }); };
  await assert.rejects(ownerCall(1, '/api/vault', { fetchImpl }), /OWNER_NONCE_REQUIRED/);
  await assert.rejects(ownerCall(1, '/api/vault', { nonce: 'short', fetchImpl }), /OWNER_NONCE_REQUIRED/);
  assert.equal(seen.length, 0, 'nothing anonymous was sent');
  const r = await ownerCall(1, '/api/vault', { nonce: NONCE, fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(seen[0][DESKTOP_NONCE_HEADER], NONCE);
});

test('`say` and the MCP surface never carry the nonce (they stay local_process: propose-only)', async () => {
  const seen = [];
  const fetchImpl = async (_url, init) => { seen.push(Object.keys(init.headers ?? {}).map((k) => k.toLowerCase())); return new Response('{"data":{"spokenResponse":"ok"}}', { status: 200 }); };
  await turn(1, { text: 'connect my GitHub key', fetchImpl });
  await callTool('kingmaker_turn', { text: 'connect my GitHub key' }, { port: 1, fetchImpl });
  await callTool('kingmaker_pending', {}, { port: 1, fetchImpl });
  assert.ok(seen.length >= 3 && seen.every((h) => !h.includes(DESKTOP_NONCE_HEADER)));
  const cli = readFileSync(new URL('../lib/cli.mjs', import.meta.url), 'utf8');
  const cmdSay = cli.slice(cli.indexOf('async function cmdSay'), cli.indexOf('\n}\n', cli.indexOf('async function cmdSay')));
  assert.ok(cmdSay.length > 100 && !/nonce|ownerCall|secrets|DESKTOP_NONCE_HEADER/.test(cmdSay), 'cmdSay sends a plain turn');
  const mcp = readFileSync(new URL('../lib/mcp.mjs', import.meta.url), 'utf8');
  assert.ok(!/ownerCall|DESKTOP_NONCE_HEADER|secrets\.nonce/.test(mcp), 'the MCP surface has no way to the nonce');
});

test('key flow: catalog page in Chrome, steps printed and spoken, hidden key sealed once, nowhere else', async () => {
  const engine = fakeEngine();
  const s = sinks();
  const r = await runKeyFlow({ port: 1, nonce: NONCE, provider: 'github', fetchImpl: engine.fetchImpl, launch: s.launch$, out: s.out$, speak: s.speak$, log: s.log$, readSecret: s.paste(`  ${KEY}  `), ask: async () => 'n' });
  assert.equal(r.ok, true);
  assert.equal(r.last4, KEY.slice(-4));
  assert.deepEqual(s.argv[0], ['-a', 'Google Chrome', GITHUB.keyPageUrl], 'the server catalog\'s own page, in Chrome');
  assert.ok(engine.requests.every((q) => q.headers[DESKTOP_NONCE_HEADER] === NONCE), 'every engine call is an owner call');
  const seals = engine.requests.filter((q) => q.path === '/api/key-handoff/console/seal');
  assert.equal(seals.length, 1);
  assert.deepEqual(JSON.parse(engine.sealBodies[0].copy), { handoffId: 'keyhandoff_abc123', secret: KEY }, 'the seal body is valid JSON with the trimmed key');
  assert.ok(engine.sealBodies[0].ref.every((b) => b === 0), 'the seal body bytes were zero-filled after the call');
  assert.ok(s.keyBuffers[0].every((b) => b === 0), 'the pasted key bytes were zero-filled');
  assert.ok(engine.requests.filter((q) => q.path !== '/api/key-handoff/console/seal').every((q) => !leaks(`${q.path} ${q.bodyText ?? ''} ${JSON.stringify(q.headers)}`)), 'no other request carries it, in a body, header or URL');
  assert.ok(!leaks(s.everything()), 'not printed, spoken, logged, or in any argv');
  assert.ok(s.out.some((l) => l.includes('Saved your GitHub key to the vault.')) && s.spoken.includes('Saved your GitHub key to the vault.'));
  assert.ok(s.out.some((l) => l.includes(GITHUB.guidance)) && s.spoken.some((l) => l.includes('opening the GitHub key page in Chrome')), 'steps printed and spoken');
  assert.ok(engine.requests.some((q) => q.path === '/api/key-handoff/keyhandoff_abc123/decline'), 'no: connect waits for the owner, the key stays sealed');
  assert.ok(!engine.requests.some((q) => q.path.endsWith('/confirm')));
});

test('key flow: "Saved" only after the engine confirms; a refusal says so and stores nothing here', async () => {
  const engine = fakeEngine({ seal: () => ({ status: 403, body: { ok: false, error: 'owner_console_required' } }) });
  const s = sinks();
  const r = await runKeyFlow({ port: 1, nonce: NONCE, provider: 'GitHub', fetchImpl: engine.fetchImpl, launch: s.launch$, out: s.out$, speak: s.speak$, readSecret: s.paste(KEY), ask: async () => 'y' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'owner_console_required');
  assert.ok(!s.out.some((l) => /Saved your/.test(l)) && !s.spoken.some((l) => /Saved your/.test(l)));
  assert.ok(!leaks(s.everything()));
});

test('key flow: a non-key is refused and asked again; yes connects and runs the live test', async () => {
  const engine = fakeEngine({ seal: (n) => (n === 1 ? { status: 400, body: { ok: false, error: 'NOT_A_KEY' } } : { status: 200, body: { ok: true, data: { state: 'SEALED_AWAITING_CONFIRM', fingerprint: { last4: KEY.slice(-4) } } } }) });
  const s = sinks();
  const r = await runKeyFlow({ port: 1, nonce: NONCE, provider: 'github', fetchImpl: engine.fetchImpl, launch: s.launch$, out: s.out$, speak: s.speak$, readSecret: s.paste('ghp_wrongbutshaped', 'has "quotes"', KEY), ask: async () => 'y' });
  assert.equal(r.ok, true);
  assert.equal(engine.sealBodies.length, 2, 'the quoted paste never left Kingmaker');
  assert.ok(s.out.filter((l) => /isn't a GitHub token/.test(l)).length === 2);
  assert.ok(engine.requests.some((q) => q.path.endsWith('/confirm') && JSON.parse(q.bodyText).operatorConfirmed === true));
  assert.ok(s.out.some((l) => /live test passed/.test(l)));
  assert.ok(s.keyBuffers.every((b) => b.every((x) => x === 0)));
});

test('key flow: Ctrl-C cancels the handoff; nothing stored', async () => {
  const engine = fakeEngine();
  const s = sinks();
  const r = await runKeyFlow({ port: 1, nonce: NONCE, provider: 'stripe', fetchImpl: engine.fetchImpl, launch: s.launch$, out: s.out$, speak: s.speak$, readSecret: s.paste(null), ask: async () => 'y' });
  assert.equal(r.reason, 'CANCELLED');
  assert.ok(engine.requests.some((q) => q.path === '/api/key-handoff/keyhandoff_abc123/cancel'));
  assert.equal(engine.sealBodies.length, 0);
  assert.ok(s.out.some((l) => /Nothing was stored/.test(l)));
});

test('key flow from a turn ("connect my GitHub key"): the event\'s handoff, no second start, steps not spoken twice', async () => {
  const engine = fakeEngine();
  const s = sinks();
  const handoff = consoleKeyHandoff({ handoffId: 'keyhandoff_fromturn', provider: 'github', label: 'GitHub', keyNoun: 'GitHub token', keyPageUrl: GITHUB.keyPageUrl, guidance: GITHUB.guidance });
  const r = await runKeyFlow({ port: 1, nonce: NONCE, handoff, spokenAlready: true, fetchImpl: engine.fetchImpl, launch: s.launch$, out: s.out$, speak: s.speak$, readSecret: s.paste(KEY), ask: async () => '' });
  assert.equal(r.ok, true);
  assert.ok(!engine.requests.some((q) => q.path === '/api/key-handoff/start' || q.path === '/api/key-handoff/providers'));
  assert.equal(JSON.parse(engine.sealBodies[0].copy).handoffId, 'keyhandoff_fromturn');
  assert.ok(!s.spoken.some((l) => /opening the GitHub key page/.test(l)), 'the turn already said the steps');
  assert.equal(consoleKeyHandoff({ redacted: true }), null, 'a redacted stub (not the operator) is never acted on');
});

test('key flow: an unknown provider lists what the engine can key; nothing starts', async () => {
  const engine = fakeEngine();
  const s = sinks();
  const r = await runKeyFlow({ port: 1, nonce: NONCE, provider: 'myspace', fetchImpl: engine.fetchImpl, launch: s.launch$, out: s.out$, readSecret: s.paste(KEY) });
  assert.equal(r.reason, 'UNKNOWN_PROVIDER');
  assert.ok(s.out[0].includes('GitHub (github)') && s.out[0].includes('Acme CRM (acme-crm)'));
  assert.ok(!engine.requests.some((q) => q.path === '/api/key-handoff/start') && s.argv.length === 0);
  assert.equal(matchProvider(PROVIDERS, 'crm')?.id, 'acme-crm');
  assert.equal(matchProvider(PROVIDERS, 'Acme CRM')?.id, 'acme-crm');
});

test('opener: Chrome first, the default browser if Chrome will not open; only https pages', async () => {
  const calls = [];
  assert.equal(await openKeyPage('https://x.test/k', { launch: async (a) => { calls.push(a); return a[0] !== '-a'; } }), 'browser');
  assert.deepEqual(calls, [['-a', 'Google Chrome', 'https://x.test/k'], ['https://x.test/k']]);
  assert.equal(safePageUrl('http://github.com/x'), null);
  assert.equal(safePageUrl('https://user:pw@github.com/x'), null);
  assert.equal(safePageUrl('javascript:alert(1)'), null);
  assert.equal(safePageUrl(GITHUB.keyPageUrl), GITHUB.keyPageUrl);
});

test('hidden prompt: no echo, paste markers and control bytes dropped, backspace works, Ctrl-C cancels', async () => {
  const fakeTty = () => { const s = new EventEmitter(); s.isTTY = true; s.isRaw = false; s.modes = []; s.setRawMode = (m) => { s.isRaw = m; s.modes.push(m); }; s.resume = () => {}; s.pause = () => {}; return s; };
  const output = { text: '', write(t) { this.text += t; } };
  const input = fakeTty();
  const pending = readHidden({ input, output, prompt: 'Paste: ' });
  input.emit('data', Buffer.from(`\x1b[200~${KEY}X\x7f\x1b[201~`));
  input.emit('data', Buffer.from('\r'));
  const value = await pending;
  assert.equal(value.toString(), KEY);
  assert.equal(output.text, 'Paste: \n', 'nothing echoed');
  assert.deepEqual(input.modes, [true, false], 'raw only while reading');
  const input2 = fakeTty();
  const cancelled = readHidden({ input: input2, output, prompt: '' });
  input2.emit('data', Buffer.from('ghp_partial\x03'));
  assert.equal(await cancelled, null);
  await assert.rejects(readHidden({ input: new EventEmitter(), output }), /NO_TTY/);
});

test('seal body: built from bytes, valid JSON, refuses anything that is not a key shape', () => {
  const body = sealBody('keyhandoff_1a2b3c', Buffer.from(KEY));
  assert.deepEqual(JSON.parse(body.toString()), { handoffId: 'keyhandoff_1a2b3c', secret: KEY });
  assert.throws(() => sealBody('keyhandoff_1', Buffer.from('a"b')), /NOT_A_KEY_SHAPE/);
  assert.throws(() => sealBody('keyhandoff_1', Buffer.from('a\\b')), /NOT_A_KEY_SHAPE/);
  assert.throws(() => sealBody('../x?y', Buffer.from(KEY)), /BAD_HANDOFF_ID/);
  assert.equal(keyBytesUsable(Buffer.from('two words')), false);
  assert.equal(trimBytes(Buffer.from(`\t ${KEY} `)).toString(), KEY);
});

test('owner secret file (a headless engine\'s, for its local owner): only a 0600 plain file of this user', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sg-owner-'));
  assert.equal(readOwnerNonce(dir).ok, false);
  writeFileSync(join(dir, OWNER_NONCE_FILE), `${NONCE}\n`, { mode: 0o600 });
  assert.deepEqual([readOwnerNonce(dir).ok, readOwnerNonce(dir).value], [true, NONCE]);
  chmodSync(join(dir, OWNER_NONCE_FILE), 0o644);
  assert.match(readOwnerNonce(dir).reason, /open to other users/);
  const other = mkdtempSync(join(tmpdir(), 'sg-owner-link-'));
  writeFileSync(join(other, 'real'), NONCE, { mode: 0o600 });
  symlinkSync(join(other, 'real'), join(other, OWNER_NONCE_FILE));
  assert.match(readOwnerNonce(other).reason, /not a plain file/);
  assert.match(readOwnerNonce(dir, { lstat: () => ({ isFile: () => true, mode: 0o100600, uid: 1 }), uid: 2 }).reason, /another user/);
});

test('console: `:key github` is a key command; a turn\'s key handoff event reaches the console handler', async () => {
  assert.equal(classifyLine(':key github'), 'key');
  assert.equal(classifyLine(':key'), 'key');
  assert.equal(classifyLine('key github'), 'text', 'plain words go to the engine (its own lane decides)');
  assert.equal(keyArg(':key  Ronin CRM '), 'Ronin CRM');
  const brief = { handoffId: 'keyhandoff_ev1', provider: 'github', label: 'GitHub', keyNoun: 'GitHub token', keyPageUrl: GITHUB.keyPageUrl, guidance: GITHUB.guidance };
  const frames = `event: key_handoff.console\ndata: ${JSON.stringify({ redacted: true })}\n\nevent: key_handoff.console\ndata: ${JSON.stringify(brief)}\n\n`;
  const realFetch = globalThis.fetch;
  const seenHeaders = [];
  globalThis.fetch = async (_url, init) => { seenHeaders.push(init.headers); return new Response(frames, { status: 200, headers: { 'content-type': 'text/event-stream' } }); };
  const got = [];
  const controller = new AbortController();
  try {
    const session = createOwnerSession({ port: 1, secrets: { nonce: NONCE }, voiceOut: false, out: () => {}, onKeyHandoff: (h) => { got.push(h); controller.abort(); } });
    session.watchControlEvents(controller.signal);
    for (let i = 0; i < 50 && !got.length; i += 1) await new Promise((r) => setTimeout(r, 10));
  } finally { controller.abort(); globalThis.fetch = realFetch; }
  assert.equal(got.length, 1, 'the redacted stub is ignored, the operator\'s event is handled');
  assert.equal(got[0].handoffId, 'keyhandoff_ev1');
  assert.equal(seenHeaders[0][DESKTOP_NONCE_HEADER], NONCE, 'the console watches as the owner');
});

// ── Kingmaker's key field (sealFromKeyField): the bar's pasted key → one owner call, CRM keys to /console/crm-seal ──
function fieldEngine(answer) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const raw = init.body;
    calls.push({ path: new URL(url).pathname, nonce: Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))[DESKTOP_NONCE_HEADER], body: Buffer.isBuffer(raw) || raw instanceof Uint8Array ? Buffer.from(raw).toString('utf8') : String(raw ?? '') });
    const [status, body] = answer(new URL(url).pathname);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}
const CRM_HANDOFF = { handoffId: 'keyhandoff_crm123', provider: 'crm', label: 'crm.acme.example', keyNoun: 'crm.acme.example API key', keyPageUrl: 'https://crm.acme.example/connections.html', crm: true };

test('key field: a CRM key goes to /console/crm-seal with the nonce, and the bytes are wiped', async () => {
  const { calls, fetchImpl } = fieldEngine(() => [200, { ok: true, data: { state: 'CONNECTED', spoken: 'crm.acme.example is connected.', fingerprint: { last4: KEY.slice(-4) } } }]);
  const keyBytes = Buffer.from(`${KEY}\n`);
  const r = await sealFromKeyField({ port: 3001, nonce: NONCE, handoff: CRM_HANDOFF, keyBytes, fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.spoken, 'crm.acme.example is connected.');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/key-handoff/console/crm-seal');
  assert.equal(calls[0].nonce, NONCE);
  assert.deepEqual(JSON.parse(calls[0].body), { handoffId: 'keyhandoff_crm123', secret: KEY });
  assert.ok(keyBytes.every((b) => b === 0), 'the pasted bytes are zero-filled');
  assert.ok(!leaks(r.spoken));
});

test('key field: a provider key goes to /console/seal; connecting stays the owner\'s yes', async () => {
  const { calls, fetchImpl } = fieldEngine(() => [200, { ok: true, data: { state: 'SEALED_AWAITING_CONFIRM', fingerprint: { last4: KEY.slice(-4) } } }]);
  const r = await sealFromKeyField({ port: 3001, nonce: NONCE, handoff: { handoffId: 'keyhandoff_gh1234', provider: 'github', label: 'GitHub', keyNoun: 'GitHub token', crm: false }, keyBytes: Buffer.from(KEY), fetchImpl });
  assert.equal(calls[0].path, '/api/key-handoff/console/seal');
  assert.equal(r.ok, true);
  assert.match(r.spoken, /Saved your GitHub key ending/);
});

test('key field: refusals never echo the key; a bad shape is never sent', async () => {
  const { calls, fetchImpl } = fieldEngine(() => [400, { ok: false, error: 'NOT_A_KEY' }]);
  const bad = await sealFromKeyField({ port: 3001, nonce: NONCE, handoff: CRM_HANDOFF, keyBytes: Buffer.from('two words'), fetchImpl });
  assert.equal(calls.length, 0);
  assert.equal(bad.retry, true);
  const refused = await sealFromKeyField({ port: 3001, nonce: NONCE, handoff: CRM_HANDOFF, keyBytes: Buffer.from(KEY), fetchImpl });
  assert.equal(refused.ok, false);
  assert.ok(!refused.retry, 'a CRM handoff is one-shot');
  assert.ok(!leaks(refused.spoken));
  const down = await sealFromKeyField({ port: 3001, nonce: NONCE, handoff: CRM_HANDOFF, keyBytes: Buffer.from(KEY), fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  assert.match(down.spoken, /Nothing was stored/);
});

test('consoleKeyHandoff reads the handoff inside the stream\'s event envelope', () => {
  const brief = { handoffId: 'keyhandoff_crm123', provider: 'crm', label: 'crm.acme.example', keyNoun: 'crm.acme.example API key', keyPageUrl: 'https://crm.acme.example/connections', crm: true };
  assert.deepEqual(consoleKeyHandoff({ type: 'key_handoff.console', tenantId: 'primary', at: '2026-10-15T04:13:54.034Z', data: brief }), brief);
  assert.deepEqual(consoleKeyHandoff(brief), brief);
  assert.equal(consoleKeyHandoff({ type: 'key_handoff.console', tenantId: 'primary', data: { redacted: true } }), null);
});
