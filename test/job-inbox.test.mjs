import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { answerLines, createJobInbox, findInbox, inboxFile, jobConversation, jobRefusal, sendByLink, submitJob, waitJob } from '../lib/job-inbox.mjs';

const KEY = 'a'.repeat(48);
function fixture() {
  const state = mkdtempSync(join(tmpdir(), 'km-jobs-'));
  mkdirSync(join(state, 'logs'), { recursive: true });
  writeFileSync(join(state, 'bar-link.key'), KEY, { mode: 0o600 });
  writeFileSync(join(state, 'logs', 'bar.log'), '2026-10-18T00:00:00Z You: earlier\n2026-10-18T00:00:01Z Kingmaker: an older answer\n');
  return state;
}
const barLog = (state, line) => appendFileSync(join(state, 'logs', 'bar.log'), `2026-10-18T00:00:09Z ${line}\n`);
function raw(port, { method = 'GET', path = '/health', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port, method, path, headers }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(d) })); });
    r.on('error', reject); if (body) r.write(body); r.end();
  });
}

test('a job may only propose: decisions and owner commands are refused', () => {
  for (const t of ['yes', 'Yes, send it', 'y', 'ok do it', 'go ahead', 'approve', 'approved.', 'confirm', 'no', 'cancel that', 'stop', 'never mind', 'send it to Brent'])
    assert.equal(jobRefusal(t), 'DECISION_NOT_ALLOWED', t);
  for (const t of ['/new', '/off', ':approvals on', ':duress arm x WIPE', ':key ronin-crm']) assert.equal(jobRefusal(t), 'COMMAND_NOT_ALLOWED', t);
  assert.equal(jobRefusal(''), 'EMPTY_TEXT');
  assert.equal(jobRefusal('x'.repeat(4001)), 'TEXT_TOO_LONG');
  for (const t of ['write one sentence about a taco truck in Phoenix', 'how many files are on my desktop', 'google the weather', 'notes from today', 'Draft a one-line message asking Kingmaker to allow screen recording'])
    assert.equal(jobRefusal(t), '', t);
});

test('conversation labels and answer lines are cleaned', () => {
  assert.equal(jobConversation('soak 1/../x'), 'job-soak-1-..-x');
  assert.equal(jobConversation(''), '');
  assert.deepEqual(answerLines('t You: hi\nt Kingmaker: hello\nt note: n\nt Sources: s\n'), ['Kingmaker: hello', 'note: n', 'Sources: s']);
});

test('the inbox queues a typed turn, tracks it to the end and returns only the new answer', async () => {
  const state = fixture();
  let t = 1000;
  const turns = [];
  const inbox = createJobInbox({ state, now: () => t, submit: (text, h) => turns.push({ text, ...h }) });
  const port = await inbox.start();
  try {
    assert.equal((statSync(inboxFile(state)).mode & 0o777), 0o600);
    assert.equal(findInbox(state).url, `http://127.0.0.1:${port}`);
    const job = await submitJob({ state, text: 'write one sentence about a taco truck', conversation: 'soak-1' });
    assert.equal(job.state, 'queued');
    assert.equal(turns.length, 1);
    assert.equal(turns[0].text, 'write one sentence about a taco truck');
    assert.equal(turns[0].conversationId, 'job-soak-1');
    turns[0].onStart(); t += 50;
    barLog(state, 'You: write one sentence about a taco truck');
    barLog(state, 'Kingmaker: The taco truck on Roosevelt sells out by noon.');
    turns[0].onDone(); t += 100;
    let v = await waitJob({ state, id: job.id, timeoutMs: 0 });
    assert.equal(v.state, 'settling');            // bar.log still gets its chance to catch up
    t += 5000;
    v = await waitJob({ state, id: job.id, timeoutMs: 0 });
    assert.equal(v.state, 'done'); assert.equal(v.timedOut, false);
    assert.deepEqual(v.answer, ['Kingmaker: The taco truck on Roosevelt sells out by noon.']);
    assert.equal(v.startedMs, 1000); assert.equal(v.endedMs, 1050);
    assert.match(v.textSha256, /^[0-9a-f]{64}$/);
    barLog(state, 'Kingmaker: a later turn');         // a settled job's answer is frozen
    assert.equal((await waitJob({ state, id: job.id, timeoutMs: 0 })).answer.length, 1);
  } finally { await inbox.stop(); }
  assert.equal(existsSync(inboxFile(state)), false);
  assert.equal(findInbox(state), null);
  rmSync(state, { recursive: true, force: true });
});

test('queued receipts exclude preceding answers and following turns even before the first status read', async () => {
  const state = fixture();
  let t = 1000;
  const turns = [];
  const inbox = createJobInbox({ state, now: () => t, submit: (text, h) => turns.push(h) });
  await inbox.start();
  try {
    const j = await submitJob({ state, text: 'Write café\nacceptance requirements' });
    barLog(state, 'Kingmaker: previous turn finished while this job waited');
    assert.deepEqual((await waitJob({ state, id: j.id, timeoutMs: 0 })).answer, []);
    turns[0].onStart();
    barLog(state, 'Kingmaker: delayed previous output');
    barLog(state, 'You (said): Write café acceptance requirements');
    barLog(state, 'Kingmaker: this job’s answer');
    turns[0].onDone();
    barLog(state, 'You: next request');
    barLog(state, 'Kingmaker: next answer');
    t += 5000;
    const v = await waitJob({ state, id: j.id, timeoutMs: 0 });
    assert.equal(v.state, 'done');
    assert.deepEqual(v.answer, ['Kingmaker: this job’s answer']);
    const evidence = readFileSync(join(state, 'logs', 'bar.log')).subarray(v.barLog.from, v.barLog.to).toString('utf8');
    assert.match(evidence, /You \(said\): Write café acceptance requirements/);
    assert.doesNotMatch(evidence, /previous|next/);
  } finally { await inbox.stop(); rmSync(state, { recursive: true, force: true }); }
});

test('the inbox refuses a wrong key, a web page, a decision and a command, and queues nothing', async () => {
  const state = fixture();
  const turns = [];
  const inbox = createJobInbox({ state, submit: (text) => turns.push(text) });
  const port = await inbox.start();
  const auth = { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };
  try {
    assert.equal((await raw(port, { headers: {} })).status, 401);
    assert.equal((await raw(port, { headers: { authorization: `Bearer ${'b'.repeat(48)}` } })).status, 401);
    assert.equal((await raw(port, { headers: { ...auth, origin: 'https://evil.example' } })).status, 403);
    assert.equal((await raw(port, { headers: { ...auth, host: 'evil.example' } })).status, 403);
    assert.equal((await raw(port, { headers: auth })).status, 200);
    for (const text of ['yes', 'approve it', ':approvals on', '/new']) {
      const r = await raw(port, { method: 'POST', path: '/jobs', headers: auth, body: JSON.stringify({ text }) });
      assert.equal(r.status, 403, text); assert.equal(r.json.ok, false);
    }
    assert.equal((await raw(port, { method: 'POST', path: '/jobs', headers: auth, body: 'not json' })).status, 400);
    assert.equal((await raw(port, { path: '/jobs/job_nope', headers: auth })).status, 404);
    await assert.rejects(submitJob({ state, text: 'yes' }), /DECISION_NOT_ALLOWED/);
    assert.deepEqual(turns, []);
  } finally { await inbox.stop(); rmSync(state, { recursive: true, force: true }); }
});

test('no running inbox: submitJob says so; the link fallback carries the key and reads the next answer', async () => {
  const state = fixture();
  await assert.rejects(submitJob({ state, text: 'hello' }), (e) => e.code === 'NO_INBOX');
  const opened = [];
  let ticks = 0;
  const r = await sendByLink({ state, text: 'write one sentence about a coffee cart', waitMs: 60_000, quietMs: 0,
    open: async (u) => { opened.push(u); }, sleep: async () => { if (++ticks === 1) barLog(state, 'Kingmaker: The coffee cart opens at six.'); } });
  assert.match(opened[0], new RegExp(`^kingmaker://bar\\?text=write%20one%20sentence%20about%20a%20coffee%20cart&key=${KEY}$`));
  assert.deepEqual(r.answer, ['Kingmaker: The coffee cart opens at six.']);
  await assert.rejects(sendByLink({ state, text: 'go ahead', open: async () => {} }), /DECISION_NOT_ALLOWED/);
  rmSync(state, { recursive: true, force: true });
});

test('the daemon wires the inbox to the same typed-turn path, and `kingmaker job` is a command', () => {
  const cli = readFileSync(new URL('../lib/cli.mjs', import.meta.url), 'utf8');
  assert.match(cli, /createJobInbox\(\{ state: paths\.state[\s\S]*?submit: \(text, \{ conversationId, onStart, onDone \}\) => \{ settled\(typedTurns, onStart\); phoneTurn\(text, \{ conversationId \}\); settled\(typedTurns, onDone\); \}/);
  assert.match(cli, /case 'job': return cmdJob\(args\);/);
  assert.match(cli, /await jobInboxStop\(\)/);
  assert.doesNotMatch(readFileSync(new URL('../lib/job-inbox.mjs', import.meta.url), 'utf8'), /approve_item|approveProposal|confirmProposal/);
});
