import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDurableJobPool } from '../lib/durable-job-pool.mjs';
import { createJobDispatcher } from '../lib/job-dispatcher.mjs';

const temp = () => mkdtempSync(join(tmpdir(), 'kingmaker-jobs-'));

test('job, event journal, and idempotency survive a database restart', () => {
  const db = join(temp(), 'jobs.sqlite');
  let pool = createDurableJobPool({ path: db, id: () => 'durable_one' });
  const first = pool.submit({ text: 'persist me', idempotencyKey: 'fixture:durable:0001' });
  pool.close();
  pool = createDurableJobPool({ path: db });
  assert.equal(pool.get(first.id).state, 'queued');
  assert.equal(pool.submit({ text: 'persist me', idempotencyKey: 'fixture:durable:0001' }).duplicate, true);
  assert.deepEqual(pool.events(first.id).map((x) => x.event), ['submitted']);
  pool.close();
});

test('lease tokens fence a stale worker after expiry and restart', () => {
  const db = join(temp(), 'jobs.sqlite'); let clock = 100;
  let pool = createDurableJobPool({ path: db, now: () => clock, id: () => 'durable_fence', token: () => 'old-token', leaseMs: 10, baseBackoffMs: 1 });
  const submitted = pool.submit({ text: 'fence me', idempotencyKey: 'fixture:durable:0002' });
  const old = pool.claim('worker-one'); pool.close(); clock = 111;
  pool = createDurableJobPool({ path: db, now: () => clock, token: () => 'new-token', leaseMs: 10, baseBackoffMs: 1 });
  pool.sweep(); clock = 112; const fresh = pool.claim('worker-one');
  assert.equal(fresh.id, submitted.id); assert.notEqual(fresh.leaseToken, old.leaseToken);
  assert.throws(() => pool.complete(fresh.id, 'worker-one', old.leaseToken, { kind: 'stale' }), /LEASE_NOT_OWNED/);
  pool.acknowledge(fresh.id, 'worker-one', fresh.leaseToken);
  assert.equal(pool.complete(fresh.id, 'worker-one', fresh.leaseToken, { kind: 'fresh' }).state, 'done');
  pool.close();
});

test('idempotency covers adapter identity and cancellation remains terminal', () => {
  const pool = createDurableJobPool({ path: join(temp(), 'jobs.sqlite'), id: () => 'durable_cancel' });
  const job = pool.submit({ text: 'same text', idempotencyKey: 'fixture:durable:0003', adapter: 'kingmaker-local' });
  assert.throws(() => pool.submit({ text: 'same text', idempotencyKey: 'fixture:durable:0003', adapter: 'cloud-agent' }), /IDEMPOTENCY_CONFLICT/);
  assert.equal(pool.cancel(job.id).state, 'cancelled'); assert.equal(pool.claim('worker'), null); pool.close();
});

test('dispatcher executes a controlled job through the real local adapter and records evidence', async () => {
  const dir = temp(); const output = join(dir, 'backend-result.txt');
  const pool = createDurableJobPool({ path: join(dir, 'jobs.sqlite'), id: () => 'durable_backend' });
  const job = pool.submit({ text: 'local backend proof', idempotencyKey: 'fixture:durable:0004' });
  const dispatcher = createJobDispatcher({ pool, workerId: 'kingmaker-local', adapters: {
    'kingmaker-local': async ({ text }) => {
      writeFileSync(output, text, { mode: 0o600 });
      return { kind: 'local-backend', bytes: Buffer.byteLength(text), output };
    },
  } });
  const done = await dispatcher.runOne();
  assert.equal(done.id, job.id); assert.equal(done.state, 'done');
  assert.equal(readFileSync(output, 'utf8'), 'local backend proof');
  assert.deepEqual(pool.events(job.id).map((x) => x.event), ['submitted', 'claimed', 'acknowledged', 'completed']);
  pool.close();
});

test('failed local execution retries with bounded backoff and terminal evidence', async () => {
  let clock = 0;
  const pool = createDurableJobPool({ path: join(temp(), 'jobs.sqlite'), now: () => clock, id: () => 'durable_retry', maxAttempts: 2, baseBackoffMs: 5 });
  const job = pool.submit({ text: 'fail safely', idempotencyKey: 'fixture:durable:0005' });
  const dispatcher = createJobDispatcher({ pool, workerId: 'kingmaker-local', adapters: { 'kingmaker-local': async () => { throw new Error('controlled failure'); } } });
  assert.equal((await dispatcher.runOne()).state, 'retry'); clock = 5;
  const failed = await dispatcher.runOne(); assert.equal(failed.state, 'failed');
  assert.deepEqual(failed.evidence, { kind: 'failure', reason: 'controlled failure' });
  assert.equal(pool.get(job.id).state, 'failed'); pool.close();
});
