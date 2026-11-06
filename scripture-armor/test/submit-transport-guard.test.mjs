// "Submit a request to Ronin Inc" — Armor transport guard suite.
// Proves the safeguard on the item's one egress moment (submit-request.mjs
// POSTs toward the CRM intake through submit-transport-guard.mjs, or not at
// all): destination binding + egress-policy check + vaultd liveness, with
// the local queue as the fail-closed fallback in every refusal mode. The
// sender is a capturing fake or a local stub; no network beyond loopback.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  CRM_INTAKE_URL, isCrmIntakeHost, createSubmitEgressPolicy, checkSubmitEgress,
  submitVaultSocketPath, createVaultLiveness, createGuardedSubmitTransport, createHttpSubmitSend,
} from '../submit-transport-guard.mjs';
import { createArmorSubmitter } from '../submit-request.mjs';

const ACCOUNT = { memberId: 'member@example.test', email: 'member@example.test' };
const FORM = { type: 'tool', name: 'Fixture Scanner', source: 'https://example.invalid/x', description: 'Scans fixtures.' };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'armor-g6-guard-'));

const harness = ({ endpoint = CRM_INTAKE_URL, policy, alive = true, sendImpl } = {}) => {
  const sent = [];
  const send = sendImpl ?? (async (record) => { sent.push(record); return { delivery: 'sent-to-crm-intake' }; });
  const transport = createGuardedSubmitTransport({ endpoint, send, policy, vaultAlive: async () => alive });
  return { sent, transport };
};

test('happy path: both guards pass, the sender receives the record, delivery is the receipt', async () => {
  const { sent, transport } = harness();
  const r = await transport({ id: 'rec-1' });
  assert.equal(r.delivery, 'sent-to-crm-intake');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, 'rec-1');
});

test('destination binding: a guarded transport cannot even be constructed for a non-CRM host', () => {
  for (const endpoint of ['https://api.github.com/api/requests', 'https://evil.example/api/requests', 'https://ronininc.org.evil.example/api/requests', 'http://127.0.0.1:8788/api/requests']) {
    assert.throws(() => harness({ endpoint }), /not the Ronin Inc CRM origin/, endpoint);
  }
  assert.equal(isCrmIntakeHost('www.ronininc.org'), true);
  assert.equal(isCrmIntakeHost('ronininc.org'), true);
  assert.equal(isCrmIntakeHost('notronininc.org'), false);
});

test('the constructor refuses a malformed endpoint or a missing sender', () => {
  assert.throws(() => createGuardedSubmitTransport({ endpoint: 'not a url', send: async () => {} }), /valid URL/);
  assert.throws(() => createGuardedSubmitTransport({ endpoint: CRM_INTAKE_URL }), /send function/);
});

test('egress: tor-only policy refuses the clearnet CRM endpoint', async () => {
  const { sent, transport } = harness({ policy: createSubmitEgressPolicy({ torOnly: true }) });
  const r = await transport({ id: 'rec-3' });
  assert.equal(r.delivery, 'queued-local');
  assert.equal(r.guard, 'egress-refused');
  assert.equal(sent.length, 0);
});

test('egress: an explicit policy that never allowlisted the CRM host refuses', async () => {
  const { sent, transport } = harness({ policy: createSubmitEgressPolicy() });
  const r = await transport({ id: 'rec-3b' });
  assert.equal(r.delivery, 'queued-local');
  assert.equal(r.guard, 'egress-refused');
  assert.match(r.reason, /not allowlisted/);
  assert.equal(sent.length, 0);
  assert.deepEqual(checkSubmitEgress(createSubmitEgressPolicy(), 'http://www.ronininc.org/api/requests').ok, false);
});

test('vault down: the send never happens and delivery stays queued-local', async () => {
  const { sent, transport } = harness({ alive: false });
  const r = await transport({ id: 'rec-4' });
  assert.equal(r.delivery, 'queued-local');
  assert.equal(r.guard, 'vault-daemon-down');
  assert.equal(sent.length, 0);
});

test('a throwing sender queues the delivery instead of throwing', async () => {
  const { transport } = harness({ sendImpl: async () => { throw new Error('intake unreachable'); } });
  const r = await transport({ id: 'rec-5' });
  assert.equal(r.delivery, 'queued-local');
  assert.equal(r.guard, 'transport-error');
});

test('vault liveness probes the real Armor vaultd socket convention', async () => {
  const dir = tmp();
  const socketPath = path.join(dir, 'vaultd.sock');
  assert.equal(await createVaultLiveness({ socketPath })(), false, 'no socket file: down');
  fs.writeFileSync(socketPath, '');
  assert.equal(await createVaultLiveness({ socketPath })(), false, 'a stale socket file with no listener: down');
  fs.rmSync(socketPath);
  const server = net.createServer(() => {});
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try { assert.equal(await createVaultLiveness({ socketPath })(), true, 'a listening vaultd: up'); }
  finally { await new Promise((resolve) => server.close(resolve)); }
  assert.equal(submitVaultSocketPath({ identityDir: '/fixture/identity' }), '/fixture/identity/vaultd.sock');
  assert.equal(submitVaultSocketPath({ identityDir: '/fixture/identity', env: { ARMOR_VAULTD_SOCKET: '/elsewhere/v.sock' } }), '/elsewhere/v.sock');
});

test('the HTTP sender: 2xx delivers, refusals and redirects throw (the guard turns them into queueing)', async () => {
  const ok = createHttpSubmitSend({ endpoint: CRM_INTAKE_URL, fetchImpl: async () => new Response('{}', { status: 200 }) });
  assert.deepEqual(await ok({ id: 'x' }), { delivery: 'sent-to-crm-intake', status: 200 });
  const refused = createHttpSubmitSend({ endpoint: CRM_INTAKE_URL, fetchImpl: async () => new Response('no', { status: 503 }) });
  await assert.rejects(() => refused({ id: 'x' }), /CRM intake answered 503/);
  const { transport } = harness({ sendImpl: createHttpSubmitSend({ endpoint: CRM_INTAKE_URL, fetchImpl: async () => new Response('no', { status: 503 }) }) });
  const r = await transport({ id: 'rec-6' });
  assert.equal(r.delivery, 'queued-local');
  assert.equal(r.guard, 'transport-error');
});

test('end to end through the submitter: the record is in the queue in EVERY refusal mode', async () => {
  for (const mode of [{ alive: true }, { alive: false }, { policy: createSubmitEgressPolicy({ torOnly: true }) }]) {
    const dir = tmp();
    const { transport } = harness(mode);
    const submitter = createArmorSubmitter({ account: ACCOUNT, queueDir: path.join(dir, 'q'), vaultDir: path.join(dir, 'v'), transport });
    const res = await submitter.submit(FORM);
    assert.equal(res.ok, true);
    assert.equal(res.record.status, 'PENDING OWNER GATE');
    if (mode.alive === true && !mode.policy) {
      assert.equal(res.delivery, 'sent-to-crm-intake');
      assert.equal(submitter.queue.delivered().length, 1);
    } else {
      assert.equal(res.delivery, 'queued-local');
      assert.equal(submitter.queue.pending().length, 1);
      assert.equal(submitter.queue.pending()[0].id, res.record.id);
    }
  }
});
