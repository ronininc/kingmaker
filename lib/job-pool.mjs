import { createHash, randomBytes } from 'node:crypto';

const TERMINAL = new Set(['done', 'failed', 'cancelled']);
const safeWorker = (value) => /^[A-Za-z0-9._-]{1,80}$/.test(String(value ?? ''));
const safeKey = (value) => /^[A-Za-z0-9._:-]{8,160}$/.test(String(value ?? ''));

/**
 * A local, authority-neutral claim queue. It grants no permission to execute a
 * job: adapters still submit through Kingmaker's governed job inbox. This module
 * only ensures one worker owns a lease and that retries/cancellation are explicit.
 */
export function createJobPool({
  now = () => Date.now(),
  id = () => `pool_${randomBytes(9).toString('base64url')}`,
  leaseMs = 30_000,
  maxAttempts = 3,
  baseBackoffMs = 1_000,
} = {}) {
  const jobs = new Map();
  const keys = new Map();
  const events = [];
  const record = (event, job, extra = {}) => events.push({ at: now(), event, id: job.id, ...extra });
  const publicView = (job) => ({
    id: job.id,
    state: job.state,
    textSha256: job.textSha256,
    idempotencyKey: job.idempotencyKey,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    availableAt: job.availableAt,
    leaseOwner: job.leaseOwner,
    leaseUntil: job.leaseUntil,
    acknowledgedAt: job.acknowledgedAt,
    evidence: job.evidence,
    error: job.error,
  });
  const owned = (job, workerId) => job && job.leaseOwner === workerId && job.leaseUntil > now();
  const retryOrFail = (job, reason) => {
    job.leaseOwner = null;
    job.leaseUntil = null;
    job.acknowledgedAt = null;
    job.error = String(reason || 'worker failed').slice(0, 300);
    if (job.attempts >= job.maxAttempts) {
      job.state = 'failed';
      job.evidence = { kind: 'failure', reason: job.error };
      record('failed', job, { reason: job.error });
    } else {
      job.state = 'retry';
      job.availableAt = now() + baseBackoffMs * (2 ** Math.max(0, job.attempts - 1));
      record('retry_scheduled', job, { availableAt: job.availableAt, reason: job.error });
    }
    return publicView(job);
  };
  const sweep = () => {
    for (const job of jobs.values()) {
      if ((job.state === 'leased' || job.state === 'running') && job.leaseUntil <= now()) retryOrFail(job, 'lease expired');
    }
  };
  return {
    submit({ text, idempotencyKey, attempts = maxAttempts } = {}) {
      const clean = String(text ?? '').trim();
      if (!clean) throw new Error('EMPTY_TEXT');
      if (!safeKey(idempotencyKey)) throw new Error('BAD_IDEMPOTENCY_KEY');
      const existing = keys.get(idempotencyKey);
      if (existing) return { ...publicView(jobs.get(existing)), duplicate: true };
      const job = {
        id: id(), text: clean,
        textSha256: createHash('sha256').update(clean).digest('hex'),
        idempotencyKey, state: 'queued', attempts: 0,
        maxAttempts: Math.max(1, Math.min(10, Number(attempts) || maxAttempts)),
        availableAt: now(), leaseOwner: null, leaseUntil: null,
        acknowledgedAt: null, evidence: null, error: null,
      };
      jobs.set(job.id, job); keys.set(idempotencyKey, job.id); record('submitted', job);
      return { ...publicView(job), duplicate: false };
    },
    claim(workerId) {
      if (!safeWorker(workerId)) throw new Error('BAD_WORKER_ID');
      sweep();
      const job = [...jobs.values()].find((x) => (x.state === 'queued' || x.state === 'retry') && x.availableAt <= now());
      if (!job) return null;
      job.state = 'leased'; job.leaseOwner = workerId; job.leaseUntil = now() + leaseMs; job.attempts += 1; job.error = null;
      record('claimed', job, { workerId, attempt: job.attempts });
      return { ...publicView(job), text: job.text };
    },
    acknowledge(jobId, workerId) {
      const job = jobs.get(jobId); if (!owned(job, workerId) || job.state !== 'leased') throw new Error('LEASE_NOT_OWNED');
      job.state = 'running'; job.acknowledgedAt = now(); record('acknowledged', job, { workerId }); return publicView(job);
    },
    complete(jobId, workerId, evidence) {
      const job = jobs.get(jobId); if (!owned(job, workerId) || !['leased', 'running'].includes(job.state)) throw new Error('LEASE_NOT_OWNED');
      if (!evidence || typeof evidence !== 'object') throw new Error('EVIDENCE_REQUIRED');
      job.state = 'done'; job.evidence = structuredClone(evidence); job.leaseOwner = null; job.leaseUntil = null;
      record('completed', job, { workerId }); return publicView(job);
    },
    fail(jobId, workerId, reason) {
      const job = jobs.get(jobId); if (!owned(job, workerId)) throw new Error('LEASE_NOT_OWNED'); return retryOrFail(job, reason);
    },
    cancel(jobId, reason = 'cancelled by owner') {
      const job = jobs.get(jobId); if (!job) throw new Error('NO_SUCH_JOB');
      if (TERMINAL.has(job.state)) return publicView(job);
      job.state = 'cancelled'; job.leaseOwner = null; job.leaseUntil = null; job.evidence = { kind: 'cancellation', reason: String(reason).slice(0, 300) };
      record('cancelled', job); return publicView(job);
    },
    get(jobId) { const job = jobs.get(jobId); return job ? publicView(job) : null; },
    events() { return structuredClone(events); },
    sweep,
  };
}
