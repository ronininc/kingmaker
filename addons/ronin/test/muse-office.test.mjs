import './_bind.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertMuseWorkspacePath, ensureMuseOffice, localMuseResponder, MUSE_IDENTITY, MUSE_PERMISSIONS,
  museMemoryDigest, museOfficePath, newMuseMessage, readMuseWorkspace, releaseOfficeLock, retryMuseMessage, routeMuseMessage, takeOfficeLock, validateDeskAnswer, validateDeskMessage,
} from '../muse-office.mjs';

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'kingmaker-muse-'));
  return { root, paths: { state: join(root, 'state') }, home: join(root, 'home') };
};

test('creates exactly one private Muse office with the required identity and authority boundary', () => {
  const f = fixture(); const p = ensureMuseOffice(f.paths);
  assert.equal(p.root, museOfficePath(f.paths));
  assert.deepEqual(readdirSync(join(f.paths.state, 'offices')), ['ronininc']);
  assert.deepEqual(readdirSync(join(f.paths.state, 'offices', 'ronininc')), ['muse']);
  assert.match(readFileSync(p.identity, 'utf8'), /Muse is the owner's personal Ronin Inc agent/);
  for (const required of ['coordinator, verifier, and reporter', 'never move money', 'send outreach', 'publish toggle', 'TCPA\\/consent box', 'Ronin Inc only', '\\$0 new spend', 'nothing leaves the owner']) assert.match(MUSE_IDENTITY, new RegExp(required, 'i'));
  assert.deepEqual(JSON.parse(readFileSync(p.permissions, 'utf8')), MUSE_PERMISSIONS);
  assert.equal(MUSE_PERMISSIONS.memory.cross_office_read, false);
  assert.equal(MUSE_PERMISSIONS.memory.namespace, 'ronininc/muse');
  assert.equal(MUSE_PERMISSIONS.lifecycle.idle_workers, 0);
  assert.deepEqual(JSON.parse(readFileSync(p.lifecycle, 'utf8')).state, 'idle');
});

test('uses the exact Ronin desk inbox and outbox message shapes', () => {
  const message = { id: 'ask-1', asker_name: 'Kingmaker', question: 'status', context: null, created_at: 1, type: 'question' };
  assert.deepEqual(validateDeskMessage(message), message);
  assert.deepEqual(validateDeskAnswer({ ask_id: 'ask-1', answer: 'ready' }), { ask_id: 'ask-1', answer: 'ready' });
  assert.throws(() => validateDeskMessage({ ...message, extra: true }), /exactly/);
  assert.throws(() => validateDeskAnswer({ ask_id: 'ask-1', answer: 'ready', extra: true }), /exactly/);
});

test('Kingmaker routes inbox → working brain → outbox → idle and only Ronin Muse memory persists', async () => {
  const f = fixture(); const message = newMuseMessage('Verify the office boundary.', { now: () => 1_800_000_000_000 });
  const result = await routeMuseMessage(f.paths, message, { responder: async (ask, context) => {
    const lifecycle = JSON.parse(readFileSync(join(f.paths.state, 'offices', 'ronininc', 'muse', 'lifecycle.json'), 'utf8'));
    assert.equal(lifecycle.state, 'working'); assert.equal(lifecycle.workers, 1);
    assert.match(context.identity, /Mr\. Social/); assert.equal(context.memory, '');
    return `Verified for ${ask.asker_name}: coordinator, verifier, reporter.`;
  } });
  assert.deepEqual(JSON.parse(readFileSync(result.inboxPath, 'utf8')), message);
  assert.deepEqual(JSON.parse(readFileSync(result.outboxPath, 'utf8')), result.answer);
  assert.equal(result.answer.ask_id, message.id);
  assert.match(readFileSync(join(f.paths.state, 'offices', 'ronininc', 'muse', 'memory', 'history.jsonl'), 'utf8'), /Verify the office boundary/);
  assert.match(museMemoryDigest(f.paths), /^[0-9a-f]{64}$/);
  assert.deepEqual(JSON.parse(readFileSync(join(f.paths.state, 'offices', 'ronininc', 'muse', 'lifecycle.json'), 'utf8')).state, 'idle');
  assert.equal(readdirSync(join(f.paths.state, 'offices')).join(','), 'ronininc');
});

test('an Orosolu Muse sentinel is never read, changed, or shared', async () => {
  const f = fixture();
  const sentinel = join(f.paths.state, 'offices', 'orosolu', 'muse', 'memory', 'sentinel.txt');
  mkdirSync(join(sentinel, '..'), { recursive: true }); writeFileSync(sentinel, 'OROSOLU-PRIVATE');
  const before = readFileSync(sentinel, 'utf8');
  const result = await routeMuseMessage(f.paths, newMuseMessage('Report Ronin scope.', { now: () => 1_800_000_000_100 }), { responder: async (_ask, context) => {
    assert.ok(!context.identity.includes('OROSOLU-PRIVATE')); assert.ok(!context.memory.includes('OROSOLU-PRIVATE'));
    return 'Ronin Inc only.';
  } });
  assert.equal(result.answer.answer, 'Ronin Inc only.');
  assert.equal(readFileSync(sentinel, 'utf8'), before);
});

test('workspace tool is read-only and path-confined; other office memory is unreachable', () => {
  const f = fixture(); const workspace = join(f.home, 'workspace'); mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'brief.txt'), 'local brief');
  assert.equal(readMuseWorkspace('brief.txt', { home: f.home }), 'local brief');
  assert.equal(assertMuseWorkspacePath('brief.txt', f.home), realpathSync(join(workspace, 'brief.txt')));
  writeFileSync(join(f.home, 'secret.txt'), 'no'); symlinkSync(join(f.home, 'secret.txt'), join(workspace, 'escape.txt'));
  assert.throws(() => readMuseWorkspace('../secret.txt', { home: f.home }), /outside/);
  assert.throws(() => readMuseWorkspace('escape.txt', { home: f.home }), /outside/);
  assert.throws(() => readMuseWorkspace('/etc/hosts', { home: f.home }), /relative/);
  chmodSync(workspace, 0o755);
});

test('local responder is loopback-only, refuses mutations before inference, and unloads after a turn', async () => {
  const base = { id: 'ask-2', asker_name: 'Kingmaker', context: null, created_at: 2, type: 'question' };
  let calls = 0;
  const blocked = await localMuseResponder({ ...base, question: 'Send outreach and check the TCPA box' }, { identity: MUSE_IDENTITY, memory: '', fetchImpl: async () => { calls++; } });
  assert.match(blocked, /Blocked by Muse authority/); assert.equal(calls, 0);
  const seen = [];
  const answer = await localMuseResponder({ ...base, question: 'Report your role' }, { identity: MUSE_IDENTITY, memory: '', fetchImpl: async (url, init) => {
    if (url.endsWith('/api/tags')) { seen.push({ url }); return new Response(JSON.stringify({ models: [{ name: 'huihui_ai/qwen3-abliterated:0.6b' }] })); }
    seen.push({ url, body: JSON.parse(init.body) }); return new Response(JSON.stringify({ response: 'I coordinate, verify, and report.' }));
  } });
  assert.equal(answer, 'I coordinate, verify, and report.');
  assert.equal(seen[0].url, 'http://127.0.0.1:11434/api/tags');
  assert.equal(seen[1].url, 'http://127.0.0.1:11434/api/generate'); assert.equal(seen[1].body.keep_alive, 0);
  await assert.rejects(() => localMuseResponder({ ...base, question: 'Report' }, { identity: MUSE_IDENTITY, memory: '', fetchImpl: async () => new Response(JSON.stringify({ models: [] })) }), /not installed locally/);
  await assert.rejects(() => localMuseResponder({ ...base, question: 'Report' }, { identity: MUSE_IDENTITY, memory: '', env: { KINGMAKER_MUSE_OLLAMA_URL: 'https://example.com' } }), /loopback/);
});

test('retries an existing Muse inbox item with the same id and records a bounded attempt history', async () => {
  const f = fixture(); const p = ensureMuseOffice(f.paths);
  const message = newMuseMessage('Retry this exact message.', { now: () => 1_800_000_001_000 });
  writeFileSync(join(p.inbox, `${message.id}.json`), `${JSON.stringify(message, null, 2)}\n`);
  let calls = 0;
  const result = await retryMuseMessage(f.paths, message.id, { responder: async (ask) => { calls++; return `same ${ask.id}`; } });
  assert.equal(calls, 1); assert.equal(result.answer.ask_id, message.id); assert.equal(result.reused, false);
  assert.deepEqual(JSON.parse(readFileSync(result.inboxPath, 'utf8')), message);
  const events = readFileSync(p.retryHistory, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map((event) => event.status), ['started', 'completed']);
  assert.ok(events.every((event) => event.ask_id === message.id && event.office === 'ronininc/muse' && /^[0-9a-f]{64}$/.test(event.profile_hash)));
});

test('concurrent same-id retry runs the responder once and refuses the competing attempt', async () => {
  const f = fixture(); const p = ensureMuseOffice(f.paths);
  const message = newMuseMessage('Only once.', { now: () => 1_800_000_002_000 });
  writeFileSync(join(p.inbox, `${message.id}.json`), `${JSON.stringify(message, null, 2)}\n`);
  let calls = 0; let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = retryMuseMessage(f.paths, message.id, { responder: async () => { calls++; await gate; return 'done once'; } });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(() => retryMuseMessage(f.paths, message.id, { responder: async () => { calls++; return 'duplicate'; } }), /already working|requires idle ronininc\/muse lifecycle/);
  release(); const result = await first;
  assert.equal(calls, 1); assert.equal(result.answer.answer, 'done once');
});

test('retry fails closed for the wrong office or profile before responder execution', async () => {
  const correct = fixture(); const wrong = fixture(); const p = ensureMuseOffice(correct.paths); ensureMuseOffice(wrong.paths);
  const message = newMuseMessage('Bound to one profile.', { now: () => 1_800_000_003_000 });
  writeFileSync(join(p.inbox, `${message.id}.json`), `${JSON.stringify(message, null, 2)}\n`);
  let calls = 0;
  await assert.rejects(() => retryMuseMessage(correct.paths, message.id, { office: 'orosolu/muse', responder: async () => { calls++; } }), /requires office ronininc\/muse/);
  await assert.rejects(() => retryMuseMessage(wrong.paths, message.id, { responder: async () => { calls++; } }), /does not exist in this profile/);
  await assert.rejects(() => retryMuseMessage(correct.paths, message.id, { profileRoot: ensureMuseOffice(wrong.paths).root, responder: async () => { calls++; } }), /profile does not match/);
  writeFileSync(p.lifecycle, `${JSON.stringify({ office: 'ronininc/muse', state: 'working', workers: 1 })}\n`);
  await assert.rejects(() => retryMuseMessage(correct.paths, message.id, { responder: async () => { calls++; } }), /requires idle ronininc\/muse lifecycle/);
  assert.equal(calls, 0);
});

test('completed-item retry replays the exact answer without responder or memory duplication', async () => {
  const f = fixture(); const message = newMuseMessage('Complete once.', { now: () => 1_800_000_004_000 });
  const first = await routeMuseMessage(f.paths, message, { responder: async () => 'original answer' });
  const digestBefore = museMemoryDigest(f.paths); let calls = 0;
  const replay = await retryMuseMessage(f.paths, message.id, { responder: async () => { calls++; return 'wrong'; } });
  assert.equal(replay.reused, true); assert.deepEqual(replay.answer, first.answer); assert.equal(calls, 0);
  assert.equal(museMemoryDigest(f.paths), digestBefore);
});

test('retry never initializes or repairs a missing or wrong profile', async () => {
  const missing = fixture();
  await assert.rejects(() => retryMuseMessage(missing.paths, 'ask-missing'), /requires an existing profile/);
  assert.equal(existsSync(museOfficePath(missing.paths)), false);

  const wrong = fixture(); const p = ensureMuseOffice(wrong.paths);
  writeFileSync(p.permissions, `${JSON.stringify({ ...MUSE_PERMISSIONS, crm: 'orosolu' })}\n`);
  const beforeIdentity = readFileSync(p.identity, 'utf8');
  const beforePermissions = readFileSync(p.permissions, 'utf8');
  await assert.rejects(() => retryMuseMessage(wrong.paths, 'ask-wrong'), /exact ronininc\/muse profile/);
  assert.equal(readFileSync(p.identity, 'utf8'), beforeIdentity);
  assert.equal(readFileSync(p.permissions, 'utf8'), beforePermissions);
  assert.equal(existsSync(p.retryHistory), true);
  assert.equal(readFileSync(p.retryHistory, 'utf8'), '');
});

test('an uncertain timed-out provider blocks retry even if provider work continues', async () => {
  const f = fixture(); const p = ensureMuseOffice(f.paths);
  const message = newMuseMessage('Timeout once.', { now: () => 1_800_000_005_000 });
  writeFileSync(join(p.inbox, `${message.id}.json`), `${JSON.stringify(message, null, 2)}\n`);
  let continued = false;
  const timeout = new Error('The operation was aborted due to timeout'); timeout.name = 'TimeoutError';
  await assert.rejects(() => retryMuseMessage(f.paths, message.id, { responder: async () => {
    setImmediate(() => { continued = true; });
    throw timeout;
  } }), /aborted due to timeout/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(continued, true);
  assert.equal(JSON.parse(readFileSync(p.lifecycle, 'utf8')).state, 'uncertain');
  let calls = 0;
  await assert.rejects(() => retryMuseMessage(f.paths, message.id, { responder: async () => { calls++; return 'unsafe overlap'; } }), /requires idle ronininc\/muse lifecycle/);
  await assert.rejects(() => routeMuseMessage(f.paths, newMuseMessage('Alternate entrypoint.', { now: () => 1_800_000_005_100 }), { responder: async () => { calls++; return 'unsafe route'; } }), /requires idle ronininc\/muse lifecycle/);
  assert.equal(calls, 0);
});

test('a generic connection failure after dispatch also leaves lifecycle uncertain', async () => {
  const f = fixture(); const p = ensureMuseOffice(f.paths);
  const message = newMuseMessage('Connection may fail after dispatch.', { now: () => 1_800_000_005_200 });
  writeFileSync(join(p.inbox, `${message.id}.json`), `${JSON.stringify(message, null, 2)}\n`);
  await assert.rejects(() => retryMuseMessage(f.paths, message.id, { responder: async () => { throw new Error('fetch failed: connection reset'); } }), /connection reset/);
  const lifecycle = JSON.parse(readFileSync(p.lifecycle, 'utf8'));
  assert.equal(lifecycle.state, 'uncertain'); assert.equal(lifecycle.ask_id, message.id);
});

test('a separate process cannot remove or replace a live office lock', async () => {
  const f = fixture(); const p = ensureMuseOffice(f.paths);
  const moduleUrl = new URL('../muse-office.mjs', import.meta.url).href;
  const script = `
    import { takeOfficeLock, releaseOfficeLock } from ${JSON.stringify(moduleUrl)};
    const p = { lock: ${JSON.stringify(p.lock)} };
    takeOfficeLock(p, 'Muse');
    process.stdout.write('ready\\n');
    setTimeout(() => { releaseOfficeLock(p); }, 250);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.once('data', (chunk) => chunk.toString().includes('ready') ? resolve() : reject(new Error('child did not acquire lock')));
  });
  assert.throws(() => takeOfficeLock(p, 'Muse'), /already working/);
  assert.equal(existsSync(p.lock), true);
  await new Promise((resolve, reject) => { child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`child exited ${code}`))); });
  takeOfficeLock(p, 'Muse');
  releaseOfficeLock(p);
  assert.equal(existsSync(p.lock), false);
});

test('stale-lock contenders fail closed without removing or replacing the lock', async () => {
  const f = fixture(); const p = ensureMuseOffice(f.paths);
  mkdirSync(p.lock, { mode: 0o700 });
  const owner = { pid: 2_147_483_647, token: 'stale-owner', created_at: 1 };
  writeFileSync(join(p.lock, 'owner.json'), `${JSON.stringify(owner)}\n`);
  const moduleUrl = new URL('../muse-office.mjs', import.meta.url).href;
  const script = `
    import { takeOfficeLock } from ${JSON.stringify(moduleUrl)};
    try { takeOfficeLock({ lock: ${JSON.stringify(p.lock)} }, 'Muse'); process.exit(2); }
    catch (error) { if (!/stale lock/.test(error.message)) process.exit(3); }
  `;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], { stdio: 'ignore' });
    child.once('error', reject); child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`contender exited ${code}`)));
  });
  await Promise.all([run(), run()]);
  assert.equal(existsSync(p.lock), true);
  assert.deepEqual(JSON.parse(readFileSync(join(p.lock, 'owner.json'), 'utf8')), owner);
});
