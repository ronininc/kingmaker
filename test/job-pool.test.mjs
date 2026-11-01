import assert from 'node:assert/strict';
import test from 'node:test';
import { createJobPool } from '../lib/job-pool.mjs';

test('idempotency and a lease prevent two fake workers from claiming one job', () => {
  let t = 1_000;
  const pool = createJobPool({ now: () => t, id: () => 'pool_one' });
  const first = pool.submit({ text: 'local synthetic job', idempotencyKey: 'fixture:job:0001' });
  const duplicate = pool.submit({ text: 'local synthetic job', idempotencyKey: 'fixture:job:0001' });
  assert.equal(duplicate.id, first.id);
  assert.equal(duplicate.duplicate, true);
  const kingmaker = pool.claim('kingmaker-local');
  assert.equal(kingmaker.id, first.id);
  assert.equal(pool.claim('cloud-fake'), null);
  pool.acknowledge(first.id, 'kingmaker-local');
  assert.throws(() => pool.complete(first.id, 'cloud-fake', { output: 'stolen' }), /LEASE_NOT_OWNED/);
  const done = pool.complete(first.id, 'kingmaker-local', { kind: 'bar-log', from: 10, to: 42, sha256: 'a'.repeat(64) });
  assert.equal(done.state, 'done');
  assert.equal(done.evidence.kind, 'bar-log');
  assert.deepEqual(pool.events().map((x) => x.event), ['submitted', 'claimed', 'acknowledged', 'completed']);
});

test('same idempotency key rejects different job content', () => {
  const pool = createJobPool({ id: () => 'pool_conflict' });
  pool.submit({ text: 'first instruction', idempotencyKey: 'fixture:job:conflict' });
  assert.throws(() => pool.submit({ text: 'different instruction', idempotencyKey: 'fixture:job:conflict' }), /IDEMPOTENCY_CONFLICT/);
});

test('bounded retry backs off, changes owner, and ends with terminal evidence', () => {
  let t = 10_000;
  const pool = createJobPool({ now: () => t, id: () => 'pool_retry', baseBackoffMs: 100, maxAttempts: 2 });
  const job = pool.submit({ text: 'retry fixture', idempotencyKey: 'fixture:job:0002' });
  assert.equal(pool.claim('cloud-fake').id, job.id);
  const retry = pool.fail(job.id, 'cloud-fake', 'temporary');
  assert.equal(retry.state, 'retry');
  assert.equal(pool.claim('kingmaker-local'), null);
  t = retry.availableAt;
  assert.equal(pool.claim('kingmaker-local').id, job.id);
  const failed = pool.fail(job.id, 'kingmaker-local', 'still broken');
  assert.equal(failed.state, 'failed');
  assert.deepEqual(failed.evidence, { kind: 'failure', reason: 'still broken' });
  assert.equal(pool.claim('cloud-fake'), null);
});

test('cancellation is terminal and releases a running lease', () => {
  const pool = createJobPool({ id: () => 'pool_cancel' });
  const job = pool.submit({ text: 'cancel fixture', idempotencyKey: 'fixture:job:0003' });
  pool.claim('cloud-fake');
  pool.acknowledge(job.id, 'cloud-fake');
  const cancelled = pool.cancel(job.id, 'owner stopped the synthetic run');
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.leaseOwner, null);
  assert.equal(cancelled.evidence.kind, 'cancellation');
  assert.throws(() => pool.complete(job.id, 'cloud-fake', { output: 'late' }), /LEASE_NOT_OWNED/);
});

test('an expired lease is recovered without duplicate ownership', () => {
  let t = 0;
  const pool = createJobPool({ now: () => t, id: () => 'pool_expire', leaseMs: 50, baseBackoffMs: 10 });
  const job = pool.submit({ text: 'lease fixture', idempotencyKey: 'fixture:job:0004' });
  pool.claim('cloud-fake');
  t = 51; pool.sweep();
  assert.equal(pool.get(job.id).state, 'retry');
  t = 61;
  assert.equal(pool.claim('kingmaker-local').id, job.id);
});
