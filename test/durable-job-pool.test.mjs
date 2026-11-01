import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
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

test('governed intake may preserve a safe external job id but cannot reuse it', () => {
  const pool = createDurableJobPool({ path: join(temp(), 'jobs.sqlite') });
  const job = pool.submit({ jobId: 'external-job:0001', text: 'scoped manifest', idempotencyKey: 'fixture:external:0001' });
  assert.equal(job.id, 'external-job:0001');
  assert.throws(() => pool.submit({ jobId: 'external-job:0001', text: 'different manifest', idempotencyKey: 'fixture:external:0002' }), /JOB_ID_CONFLICT/);
  assert.throws(() => pool.submit({ jobId: '../unsafe', text: 'x', idempotencyKey: 'fixture:external:0003' }), /BAD_JOB_ID/);
  pool.close();
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
  assert.deepEqual(pool.events(job.id).map((x) => x.event), ['submitted', 'claimed', 'acknowledged', 'started', 'evidence_recorded', 'completed']);
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

test('database, WAL, and SHM remain owner-only under a permissive umask', () => {
  const dir = temp(); const queueDir = join(dir, 'private-queue');
  mkdirSync(queueDir, { mode: 0o700 });
  const old = process.umask(0o000);
  try {
    const db = join(queueDir, 'jobs.sqlite');
    const pool = createDurableJobPool({ path: db, id: () => 'durable_modes' });
    pool.submit({ text: 'private job text', idempotencyKey: 'fixture:durable:modes' });
    for (const path of [db, `${db}-wal`, `${db}-shm`]) assert.equal(lstatSync(path).mode & 0o077, 0, path);
    pool.close();
  } finally { process.umask(old); }
});

test('unsafe existing directories and database symlinks are rejected', () => {
  const dir = temp(); const publicDir = join(dir, 'public-queue');
  mkdirSync(publicDir, { mode: 0o700 }); chmodSync(publicDir, 0o755);
  assert.throws(() => createDurableJobPool({ path: join(publicDir, 'jobs.sqlite') }), /JOB_DIRECTORY_NOT_PRIVATE/);
  const privateDir = join(dir, 'private-queue'); mkdirSync(privateDir, { mode: 0o700 });
  const target = join(privateDir, 'target'); writeFileSync(target, 'not a database', { mode: 0o600 });
  symlinkSync(target, join(privateDir, 'jobs.sqlite'));
  assert.throws(() => createDurableJobPool({ path: join(privateDir, 'jobs.sqlite') }), /UNSAFE_JOB_DATABASE/);
});
