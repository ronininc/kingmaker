import './_bind.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { askRoninDesk, maintainRoninDeskDock, parseMcpEnvelope, readRoninDeskConfig, roninDeskConfigPath, roninDeskIdentity, roninDeskReplies, runRoninDeskDock, setRoninDeskEnabled, storedRoninDeskToken } from '../ronin-desk-dock.mjs';
import { BRAIN_DESKS, clearDeskSession, createBrainDeskHost, DESK_ACCOUNTS, deskPrompt } from '../brain-desks.mjs';
import { grokEnv } from '../../../lib/grok-brain.mjs';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';

test('parses JSON and SSE MCP tool envelopes', () => {
  const result = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{"ok":true}' }] } };
  assert.deepEqual(parseMcpEnvelope(JSON.stringify(result)), { ok: true });
  assert.deepEqual(parseMcpEnvelope(`event: message\ndata: ${JSON.stringify(result)}\n\n`), { ok: true });
});

test('Ronin identity is deterministic and refuses every other CRM', () => {
  const a = roninDeskIdentity({ env: { RONIN_CRM_URL: 'https://www.ronininc.org' }, token: 'ronin_desk_fixture', host: 'mac-a' });
  assert.match(a.pairingId, /^ronin-[0-9a-f]{20}$/);
  assert.match(a.deviceId, /^[0-9a-f]{24}$/);
  assert.throws(() => roninDeskIdentity({ env: { RONIN_CRM_URL: 'https://other.invalid' }, token: 'ronin_desk_fixture', host: 'mac-a' }), /Ronin desk profile/);
});

test('credential comes from the environment or Keychain without argv', () => {
  assert.equal(storedRoninDeskToken({ RONIN_DESK_TOKEN: 'fixture' }), 'fixture');
  const calls = [];
  const token = storedRoninDeskToken({}, (...args) => { calls.push(args); return 'sealed\n'; });
  assert.equal(token, 'sealed');
  assert.deepEqual(calls[0][1], ['find-generic-password', '-s', 'ronin-crm-prod', '-a', 'KINGMAKER_DESK_TOKEN', '-w']);
});

test('Ronin auto-dock is an explicit private setting of one local profile', () => {
  const paths = { state: join(mkdtempSync(join(tmpdir(), 'kingmaker-ronin-desk-')), 'profile') };
  assert.deepEqual(readRoninDeskConfig(paths), { enabled: false, crm: 'https://www.ronininc.org', profile: 'ronininc' });
  assert.deepEqual(setRoninDeskEnabled(paths, true), { enabled: true, crm: 'https://www.ronininc.org', profile: 'ronininc' });
  assert.equal(statSync(roninDeskConfigPath(paths)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(roninDeskConfigPath(paths), 'utf8')), { schema: 1, crm: 'ronininc', enabled: true });
  assert.throws(() => roninDeskIdentity({ env: { RONIN_CRM_URL: 'https://crm.orosolu.org' }, token: 'fixture', host: 'mac-a' }), /Ronin desk profile/);
});

test('installed Ronin host re-docks after transient heartbeat failure', async () => {
  const calls = []; const lines = [];
  const result = await maintainRoninDeskDock({
    retryDelays: [1],
    log: (line) => lines.push(line),
    dock: async () => {
      calls.push(Date.now());
      if (calls.length < 3) throw new Error('temporary network outage');
      return { ok: true, leaseExpiresAt: 1234 };
    },
  });
  assert.equal(calls.length, 3);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /retrying in 1s/);
  assert.deepEqual(result, { ok: true, leaseExpiresAt: 1234 });
});

// A fake CRM /mcp/desk: records calls, serves one question, accepts heartbeats and answers.
function fakeDesk({ asks = [] } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('/api/health')) return new Response('{}', { status: 200 });
    const { params } = JSON.parse(init.body);
    calls.push({ name: params.name, input: params.arguments, auth: init.headers.authorization });
    const reply = {
      desk_heartbeat: { ok: true, lease_expires_at: 99 },
      desk_commands: { commands: [] },
      desk_inbox: { asks },
      desk_answer: { ok: true },
      desk_ask: { ok: true, question_id: 'q-new', desk: params.arguments.desk },
      desk_replies: { replies: [{ question_id: 'q1', desk: 'grok-bot', question: 'Status?', answer: 'Idle.', asked_at: 1, answered_at: 2 }] },
    }[params.name];
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(reply) }] } }), { status: 200 });
  };
  return { calls, fetchImpl };
}

test('a hosted brain desk answers Seeker’s question once and leaves recaps alone', async () => {
  const realFetch = globalThis.fetch;
  const desk = fakeDesk({ asks: [{ id: 'q1', type: 'question', asker_name: 'Seeker', question: 'What are you on?' }, { id: 'r1', type: 'recap', question: 'Meeting' }] });
  globalThis.fetch = desk.fetchImpl;
  try {
    const seen = [];
    await runRoninDeskDock(['--check'], {
      token: 'ronin_desk_grok_fixture', fetchImpl: desk.fetchImpl, hostname: 'mac-a', run: () => '', log: () => {},
      env: { SOLOMON_URL: 'http://127.0.0.1:3001' },
      ready: async () => ({ ok: true }),
      answer: async (ask) => { seen.push(ask.id); return { ok: true, text: 'Drafting the week.' }; },
    });
    assert.deepEqual(seen, ['q1']);
    const answered = desk.calls.filter((c) => c.name === 'desk_answer');
    assert.deepEqual(answered.map((c) => c.input), [{ ask_id: 'q1', answer: 'Drafting the week.' }]);
    assert.ok(desk.calls.every((c) => c.auth === 'Bearer ronin_desk_grok_fixture'));
  } finally { globalThis.fetch = realFetch; }
});

test('a brain that is not installed reports an error heartbeat and answers nothing', async () => {
  const realFetch = globalThis.fetch;
  const desk = fakeDesk({ asks: [{ id: 'q1', type: 'question', question: 'Hello?' }] });
  globalThis.fetch = desk.fetchImpl;
  try {
    let answered = 0;
    await runRoninDeskDock(['--check'], {
      token: 'ronin_desk_grok_fixture', fetchImpl: desk.fetchImpl, hostname: 'mac-a', run: () => '', log: () => {}, env: {},
      ready: async () => ({ ok: false, error: 'Grok Build is not installed on this Mac.' }),
      answer: async () => { answered++; return { ok: true, text: 'x' }; },
    });
    const beat = desk.calls.find((c) => c.name === 'desk_heartbeat').input;
    assert.equal(beat.state, 'error');
    assert.match(beat.error, /not installed/);
    assert.equal(answered, 0);
    assert.ok(!desk.calls.some((c) => c.name === 'desk_inbox'));
  } finally { globalThis.fetch = realFetch; }
});

test('Seeker asks a desk and reads replies with the Kingmaker desk key from Keychain', async () => {
  const desk = fakeDesk();
  const keychain = () => 'ronin_desk_king_fixture\n';
  const asked = await askRoninDesk({ desk: 'grok-bot', question: ' Status? ', env: {}, run: keychain, fetchImpl: desk.fetchImpl });
  assert.deepEqual(asked, { ok: true, question_id: 'q-new', desk: 'grok-bot' });
  assert.deepEqual(desk.calls[0], { name: 'desk_ask', input: { desk: 'grok-bot', question: 'Status?' }, auth: 'Bearer ronin_desk_king_fixture' });
  const { replies } = await roninDeskReplies({ env: {}, run: keychain, fetchImpl: desk.fetchImpl });
  assert.equal(replies[0].answer, 'Idle.');
  await assert.rejects(askRoninDesk({ desk: 'muse', question: 'x', env: {}, run: () => { throw new Error('no item'); } }), /KINGMAKER_DESK_TOKEN/);
});

test('the Build Room brains: each desk its own Keychain account, its own session, and the house rules', async () => {
  assert.deepEqual(BRAIN_DESKS, ['muse', 'claude', 'codex', 'grok-bot']);
  assert.equal(DESK_ACCOUNTS['grok-bot'], 'GROK_DESK_TOKEN');
  assert.equal(new Set(Object.values(DESK_ACCOUNTS)).size, Object.keys(DESK_ACCOUNTS).length);
  const calls = [];
  storedRoninDeskToken({ RONIN_DESK_KEYCHAIN_ACCOUNT: DESK_ACCOUNTS.codex }, (...args) => { calls.push(args[1]); return 't'; });
  assert.deepEqual(calls[0], ['find-generic-password', '-s', 'ronin-crm-prod', '-a', 'CODEX_DESK_TOKEN', '-w']);
  const prompt = deskPrompt('grok-bot', { asker_name: 'Seeker', question: 'Pull the week’s leads.' });
  assert.match(prompt, /Seeker asked you this on your desk \(grok-bot\)/);
  assert.match(prompt, /say what you propose; the owner decides/);
  assert.match(prompt, /^You are Grok, at the grok-bot desk/);
  assert.match(prompt, /you report back to Seeker, never to the owner directly/);
  for (const desk of ['claude', 'codex', 'grok-bot']) {
    let made = null;
    const host = createBrainDeskHost(desk, {
      paths: { state: '/tmp/km-state' }, port: 3001, probe: async () => ({ ok: true }),
      factories: { [desk]: (opts) => { made = opts; return { runTurn: async (text) => { await opts.say(`${desk}: ${text.includes(`(${desk})`) ? 'on it' : 'wrong desk'}`); return { ok: true }; } }; } },
    });
    assert.deepEqual(await host.answer({ question: 'Status?' }), { ok: true, text: `${desk}: on it` });
    assert.equal(made.paths.state, `/tmp/km-state/desks/${desk}`);
  }
  const routed = [];
  const muse = createBrainDeskHost('muse', { paths: { state: '/tmp/km' }, probe: async () => ({ ok: true }),
    factories: { muse: async (paths, message) => { routed.push(message); return { answer: { ask_id: message.id, answer: 'Muse: three posts drafted.' } }; } } });
  assert.deepEqual(await muse.answer({ asker_name: 'Seeker', question: 'Content status?' }), { ok: true, text: 'Muse: three posts drafted.' });
  assert.equal(routed[0].asker_name, 'Seeker');
  const noOllama = createBrainDeskHost('muse', { paths: { state: '/tmp/km' }, fetchImpl: async () => { throw new Error('refused'); } });
  assert.match((await noOllama.ready()).error, /Ollama is not answering/);
  assert.throws(() => createBrainDeskHost('accountant', { paths: { state: '/tmp/x' } }), /does not host/);
});

test('a key filed under the wrong desk is refused before anything is hosted', async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('/api/health')) return new Response('{}', { status: 200 });
    const { params } = JSON.parse(init.body);
    calls.push(params.name);
    const reply = params.name === 'desk_status' ? { slug: 'accountant', nameplate: 'accountant' } : { ok: true, lease_expires_at: 9 };
    return new Response(JSON.stringify({ result: { content: [{ type: 'text', text: JSON.stringify(reply) }] } }), { status: 200 });
  };
  globalThis.fetch = fetchImpl;
  try {
    const lines = [];
    const r = await maintainRoninDeskDock({ token: 'ronin_desk_x', fetchImpl, hostname: 'mac-a', run: () => '', env: {}, expectDesk: 'grok-bot', retryDelays: [1], log: (l) => lines.push(l), answer: async () => ({ ok: true, text: 'x' }) });
    assert.deepEqual(r, { ok: false, mismatch: true });
    assert.deepEqual(calls, ['desk_status']);
    assert.match(lines[0], /belongs to the accountant desk; not hosting it/);
  } finally { globalThis.fetch = realFetch; }
});

test('every order is a fresh session with its context; Grok loads only its own store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'km-desk-'));
  for (const [desk, rel] of [['claude', 'claude-brain/session.json'], ['codex', 'chatgpt-brain/.started'], ['grok-bot', 'grok-brain/session.json']]) {
    mkdirSync(join(dir, desk, rel.split('/')[0]), { recursive: true });
    writeFileSync(join(dir, desk, rel), '{"sessionId":"old"}');
    clearDeskSession(desk, join(dir, desk));
    assert.equal(existsSync(join(dir, desk, rel)), false, `${desk} would resume an old conversation`);
  }
  const desk = fakeDesk();
  await askRoninDesk({ desk: 'codex', question: 'Fix the invoice page.', context: 'Repo ronininc-crm; bug: totals off by tax.', env: {}, run: () => 'k', fetchImpl: desk.fetchImpl });
  assert.deepEqual(desk.calls[0].input, { desk: 'codex', question: 'Fix the invoice page.', context: 'Repo ronininc-crm; bug: totals off by tax.' });
  assert.match(deskPrompt('codex', { question: 'Fix it.', context: 'Repo ronininc-crm' }), /Context: Repo ronininc-crm/);
  const g = grokEnv({ XAI_API_KEY: 'x', GROK_CODE_XAI_API_KEY: 'y', HOME: '/h', PATH: '/bin' });
  assert.equal(g.XAI_API_KEY, undefined); assert.equal(g.GROK_CODE_XAI_API_KEY, undefined);
  assert.equal(g.GROK_CLAUDE_SKILLS_ENABLED, 'false'); assert.equal(g.GROK_CURSOR_MCPS_ENABLED, 'false');
});

// A seconds-long Solomon stall must not become an error heartbeat (each one is an owner call); a real outage must.
function flakySolomon(failures) {
  const desk = fakeDesk(); let probes = 0;
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('/api/health')) { probes++; if (probes <= failures) throw new TypeError('connect ECONNREFUSED'); return new Response('{}', { status: 200 }); }
    return desk.fetchImpl(url, init);
  };
  return { desk, fetchImpl, probes: () => probes };
}
for (const [failures, state] of [[2, 'idle'], [3, 'error']]) {
  test(`Solomon failing ${failures} consecutive health probes heartbeats ${state}`, async () => {
    const realFetch = globalThis.fetch; const flaky = flakySolomon(failures);
    globalThis.fetch = flaky.fetchImpl;
    try {
      await runRoninDeskDock(['--check'], { token: 'ronin_desk_codex_fixture', fetchImpl: flaky.fetchImpl, hostname: 'mac-a', run: () => '', log: () => {}, probeGapMs: 0, env: { SOLOMON_URL: 'http://127.0.0.1:3301' } });
      const beat = flaky.desk.calls.find((c) => c.name === 'desk_heartbeat').input;
      assert.equal(beat.state, state);
      assert.equal(flaky.probes(), 3);
      if (state === 'error') assert.equal(beat.error, 'Solomon is not answering at http://127.0.0.1:3301');
      else assert.equal(beat.error, '');
    } finally { globalThis.fetch = realFetch; }
  });
}
