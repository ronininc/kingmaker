// "Submit a request to Ronin Inc" — Scripture Armor staging suite.
// Proves the Armor half of the submission loop (G6) against the standard
// (~/workspace/submit-request-item-2026-11-05/SPEC.md §1/§3.2, contract
// ronin.submit-request/1): record formation with unforgeable identity, gate
// immovability against hostile transports, queue-first persistence with
// flush on recovery, disposable-vault attachment custody, and the
// PENDING OWNER REVIEW acknowledgment — plus one end-to-end local run
// (surface -> record -> queue -> a local stub intake over real HTTP).
// The stub leg is fixture-grade by construction: the live CRM intake
// waits on the owner's deploy tap (G5). No network beyond loopback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SUBMIT_REQUEST_LABEL, SUBMISSION_SCHEMA, GATE_STATUS, REQUEST_FIELDS, REQUEST_TYPES,
  accountFromSession, buildSubmission, confirmationFor, createArmorSubmitter,
  createRequestQueue, landAttachment,
} from '../submit-request.mjs';
import { createGuardedSubmitTransport, createHttpSubmitSend, CRM_INTAKE_URL } from '../submit-transport-guard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ACCOUNT = { memberId: 'member@example.test', email: 'member@example.test', name: 'Fixture Member' };
const FORM = { type: 'brain', name: 'Fixture Brain', source: 'https://example.invalid/brain', description: 'A fixture brain.', license: 'MIT', notes: 'For the gate.' };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'armor-g6-'));

test('the label, field set, and request types are the standard — identity is not a field', () => {
  assert.equal(SUBMIT_REQUEST_LABEL, 'Submit a request to Ronin Inc');
  assert.deepEqual(REQUEST_FIELDS.map((f) => f.key), ['type', 'name', 'source', 'description', 'license', 'notes']);
  assert.deepEqual([...REQUEST_TYPES], ['brain', 'method', 'tool', 'other']);
  assert.ok(REQUEST_FIELDS.every((f) => !/identity|member|email|requester/i.test(f.key)));
});

test('record formation: the exact ronin.submit-request/1 contract', () => {
  const record = buildSubmission({ account: ACCOUNT, input: { ...FORM, license: '', notes: '' }, now: new Date('2026-11-06T02:00:00.000Z'), id: 'fixed-id' });
  assert.deepEqual(record, {
    schema: SUBMISSION_SCHEMA,
    id: 'fixed-id',
    submittedAt: '2026-11-06T02:00:00.000Z',
    productOfOrigin: 'scripture-armor',
    status: 'PENDING OWNER GATE',
    gate: 'owner-personal',
    requester: { memberId: 'member@example.test', email: 'member@example.test', name: 'Fixture Member' },
    request: { type: 'brain', name: 'Fixture Brain', source: 'https://example.invalid/brain', description: 'A fixture brain.', license: 'unknown', notes: '' },
    acknowledgment: { to: 'member@example.test', copyStatus: 'PENDING OWNER REVIEW' },
  });
  assert.equal(record.status, GATE_STATUS);
});

test('identity is unforgeable from the form: identity-shaped input keys are never read', () => {
  const forged = {
    ...FORM,
    memberId: 'victim@example.test', email: 'victim@example.test',
    requester: { memberId: 'victim@example.test', email: 'victim@example.test' },
    account: { memberId: 'victim@example.test', email: 'victim@example.test' },
    status: 'APPROVED', gate: 'none', productOfOrigin: 'website',
  };
  const record = buildSubmission({ account: ACCOUNT, input: forged });
  assert.deepEqual(record.requester, { memberId: 'member@example.test', email: 'member@example.test', name: 'Fixture Member' });
  assert.equal(record.status, 'PENDING OWNER GATE');
  assert.equal(record.productOfOrigin, 'scripture-armor');
});

test('identity prefill comes from the Armor account session — and only from it', () => {
  const session = { state: () => ({ authenticated: true, email: 'Member@Example.test', challengePending: false }) };
  assert.deepEqual(accountFromSession(session), { memberId: 'member@example.test', email: 'member@example.test' });
  assert.throws(() => accountFromSession({ state: () => ({ authenticated: false, email: null }) }), /Sign in and verify/);
  assert.throws(() => buildSubmission({ account: null, input: FORM }), /no signed-in member account/);
});

test('validation refuses name the first problem and record nothing', () => {
  assert.throws(() => buildSubmission({ account: ACCOUNT, input: { ...FORM, type: 'gadget' } }), /request type must be one of/);
  assert.throws(() => buildSubmission({ account: ACCOUNT, input: { ...FORM, name: ' ' } }), /name of the thing is required/);
  assert.throws(() => buildSubmission({ account: ACCOUNT, input: { ...FORM, source: '' } }), /source \(repo URL or origin\) is required/);
  assert.throws(() => buildSubmission({ account: ACCOUNT, input: { ...FORM, description: '' } }), /description of what it does is required/);
});

test('the acknowledgment and confirmation carry PENDING OWNER REVIEW — no promise, no timeline', () => {
  const record = buildSubmission({ account: ACCOUNT, input: FORM, id: 'abc-123' });
  assert.deepEqual(record.acknowledgment, { to: 'member@example.test', copyStatus: 'PENDING OWNER REVIEW' });
  assert.equal(confirmationFor(record), [
    'Submit a request to Ronin Inc — received.',
    'Request abc-123 (brain: Fixture Brain) is recorded and pending review.',
    'There is no timeline for review, and a request is not accepted until Ronin Inc says so.',
  ].join('\n'));
});

test('queue-first: with no transport the record is durable in the product store, still PENDING OWNER GATE', async () => {
  const dir = tmp();
  const submitter = createArmorSubmitter({ account: ACCOUNT, queueDir: path.join(dir, 'q'), vaultDir: path.join(dir, 'v') });
  const res = await submitter.submit(FORM);
  assert.equal(res.ok, true);
  assert.equal(res.delivery, 'queued-local');
  const pending = submitter.queue.pending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, res.record.id);
  assert.equal(pending[0].status, 'PENDING OWNER GATE');
  assert.equal(pending[0].acknowledgment.copyStatus, 'PENDING OWNER REVIEW');
});

test('gate immovability: a transport answer that claims a status changes nothing', async () => {
  const dir = tmp();
  const queue = createRequestQueue({ dir: path.join(dir, 'q') });
  const submitter = createArmorSubmitter({
    account: ACCOUNT, queue, vaultDir: path.join(dir, 'v'),
    transport: async () => ({ delivery: 'sent-to-crm-intake', status: 'APPROVED', gate: 'none' }),
  });
  const res = await submitter.submit(FORM);
  assert.equal(res.record.status, 'PENDING OWNER GATE');
  const delivered = queue.delivered();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].record.status, 'PENDING OWNER GATE');
  assert.equal(delivered[0].record.gate, 'owner-personal');
});

test('gate immovability: a hostile transport that mutates its copy cannot touch the filed record', async () => {
  const dir = tmp();
  const queue = createRequestQueue({ dir: path.join(dir, 'q') });
  const submitter = createArmorSubmitter({
    account: ACCOUNT, queue, vaultDir: path.join(dir, 'v'),
    transport: async (record) => { record.status = 'APPROVED'; record.requester.email = 'victim@example.test'; return { delivery: 'sent-to-crm-intake' }; },
  });
  const res = await submitter.submit(FORM);
  const delivered = queue.delivered();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].record.status, 'PENDING OWNER GATE', 'the delivered log carries the record as filed, not as mutated');
  assert.equal(delivered[0].record.requester.email, 'member@example.test');
  assert.equal(delivered[0].record.id, res.record.id);
});

test('attachments land in a disposable vault cell — bytes copied, never opened, record carries only the reference', async () => {
  const dir = tmp();
  const sourcePath = path.join(dir, 'fixture-payload.bin');
  const bytes = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0xff, 0xfe, 0x00, 0x01]);
  fs.writeFileSync(sourcePath, bytes);
  const vaultDir = path.join(dir, 'vault');
  const ref = await landAttachment({ vaultDir, recordId: 'rec-1', sourcePath });
  assert.equal(ref.name, 'fixture-payload.bin');
  assert.equal(ref.size, bytes.length);
  assert.equal(ref.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(ref.vaultRef, 'armor-vault:submit-requests/rec-1/fixture-payload.bin');
  const cellDir = path.join(vaultDir, 'rec-1');
  assert.equal(fs.statSync(cellDir).mode & 0o777, 0o700);
  assert.deepEqual(fs.readFileSync(path.join(cellDir, 'fixture-payload.bin')), bytes);
  const submitter = createArmorSubmitter({ account: ACCOUNT, queueDir: path.join(dir, 'q'), vaultDir });
  const res = await submitter.submit(FORM, { attachments: [{ sourcePath }] });
  assert.equal(res.record.attachments.length, 1);
  assert.deepEqual(Object.keys(res.record.attachments[0]).sort(), ['custody', 'name', 'sha256', 'size', 'vaultRef']);
  assert.equal(res.record.attachments[0].custody, 'disposable-vault-cell');
  assert.equal(res.record.attachments[0].sha256, ref.sha256);
  assert.throws(() => buildSubmission({ account: ACCOUNT, input: FORM, attachments: [{ name: 'raw-content-instead-of-a-ref' }] }), /landed vault references/);
});

test('end to end, local: surface -> record -> queue -> stub intake receives the contract-exact record', async () => {
  const received = [];
  const stub = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, contentType: req.headers['content-type'], body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, id: 'stub' }));
    });
  });
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const dir = tmp();
  const queueDir = path.join(dir, 'q');
  const deadSend = createHttpSubmitSend({ endpoint: 'http://127.0.0.1:1/api/requests' });
  const downTransport = createGuardedSubmitTransport({ endpoint: CRM_INTAKE_URL, send: deadSend, vaultAlive: async () => true });
  const down = createArmorSubmitter({ account: ACCOUNT, queueDir, vaultDir: path.join(dir, 'v'), transport: downTransport });
  try {
    // Intake down: the guarded send fails, the record queues, nothing is lost.
    const queuedRes = await down.submit(FORM);
    assert.equal(queuedRes.delivery, 'queued-local');
    assert.equal(down.queue.pending().length, 1);
    assert.equal(received.length, 0);
    // Intake answers (the fixture stub): a flush through a working guarded
    // transport delivers the very record that was queued.
    const liveSend = createHttpSubmitSend({ endpoint: `http://127.0.0.1:${stub.address().port}/api/requests` });
    const liveTransport = createGuardedSubmitTransport({ endpoint: CRM_INTAKE_URL, send: liveSend, vaultAlive: async () => true });
    const live = createArmorSubmitter({ account: ACCOUNT, queueDir, vaultDir: path.join(dir, 'v'), transport: liveTransport });
    const flushed = await live.flush();
    assert.deepEqual(flushed, { attempted: 1, delivered: 1, stillQueued: 0 });
    assert.equal(received.length, 1);
    assert.equal(received[0].method, 'POST');
    assert.equal(received[0].url, '/api/requests');
    assert.equal(received[0].contentType, 'application/json');
    assert.deepEqual(received[0].body, queuedRes.record);
    assert.equal(received[0].body.status, 'PENDING OWNER GATE');
    assert.equal(received[0].body.schema, 'ronin.submit-request/1');
    assert.equal(live.queue.delivered().length, 1);
  } finally { await new Promise((resolve) => stub.close(resolve)); }
});

test('the CLI command exists and fails closed without a signed-in session', async () => {
  const dir = tmp();
  const identityDir = path.join(dir, 'identity');
  const run = await new Promise((resolve) => {
    execFile(process.execPath, [path.join(HERE, '..', 'armor.mjs'), 'request', '--type', 'brain', '--name', 'X', '--source', 'https://example.invalid/x', '--description', 'A thing.', '--identity-dir', identityDir],
      { env: { ...process.env, HOME: dir } }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
  });
  assert.equal(run.code, 1);
  assert.match(run.stderr, /Sign in and verify your email code first/);
  assert.equal(fs.existsSync(path.join(identityDir, 'submit-requests')), false, 'nothing is recorded without an identity to file under');
});
