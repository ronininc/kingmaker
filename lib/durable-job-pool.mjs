import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const TERMINAL = new Set(['done', 'failed', 'cancelled']);
const safeWorker = (value) => /^[A-Za-z0-9._-]{1,80}$/.test(String(value ?? ''));
const safeKey = (value) => /^[A-Za-z0-9._:-]{8,160}$/.test(String(value ?? ''));
const hashText = (text) => createHash('sha256').update(text).digest('hex');
const parse = (value) => value == null ? null : JSON.parse(value);

/**
 * Restart-safe local coordination for Kingmaker and explicitly configured
 * adapters. This grants no execution authority: a dispatcher must still map a
 * named adapter to a governed handler. SQLite transactions serialize claims.
 */
export function createDurableJobPool({
  path,
  now = () => Date.now(),
  id = () => `pool_${randomBytes(9).toString('base64url')}`,
  token = () => randomBytes(18).toString('base64url'),
  leaseMs = 30_000,
  maxAttempts = 3,
  baseBackoffMs = 1_000,
} = {}) {
  if (!path) throw new Error('JOB_DB_PATH_REQUIRED');
  const disk = path !== ':memory:';
  const queueDir = disk ? dirname(path) : null;
  const assertPrivate = (target, kind) => {
    const st = lstatSync(target);
    if (st.isSymbolicLink() || (kind === 'directory' ? !st.isDirectory() : !st.isFile())) throw new Error(`UNSAFE_JOB_${kind.toUpperCase()}`);
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error(`JOB_${kind.toUpperCase()}_NOT_OWNED`);
    if ((st.mode & 0o077) !== 0) throw new Error(`JOB_${kind.toUpperCase()}_NOT_PRIVATE`);
  };
  if (disk) {
    mkdirSync(queueDir, { recursive: true, mode: 0o700 });
    assertPrivate(queueDir, 'directory');
    if (existsSync(path)) assertPrivate(path, 'database');
  }
  // The private directory is the primary no-observation boundary. A temporary
  // restrictive umask also prevents a database/WAL/SHM exposure window.
  const oldUmask = disk ? process.umask(0o077) : null;
  let db;
  try {
    db = new DatabaseSync(path);
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, text TEXT NOT NULL, text_sha256 TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE, adapter TEXT NOT NULL,
      state TEXT NOT NULL, attempts INTEGER NOT NULL, max_attempts INTEGER NOT NULL,
      available_at INTEGER NOT NULL, lease_owner TEXT, lease_token TEXT,
      lease_until INTEGER, acknowledged_at INTEGER, evidence_json TEXT, error TEXT
    );
    CREATE TABLE IF NOT EXISTS job_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
      event TEXT NOT NULL, job_id TEXT NOT NULL, detail_json TEXT NOT NULL
    );`);
  } finally {
    if (disk) process.umask(oldUmask);
  }
  const secureFiles = () => {
    if (!disk) return;
    for (const target of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(target)) {
      const st = lstatSync(target);
      if (st.isSymbolicLink() || !st.isFile()) throw new Error('UNSAFE_JOB_DATABASE');
      chmodSync(target, 0o600); assertPrivate(target, 'database');
    }
  };
  secureFiles();

  const one = db.prepare('SELECT * FROM jobs WHERE id = ?');
  const byKey = db.prepare('SELECT * FROM jobs WHERE idempotency_key = ?');
  const view = (row, extra = {}) => row && ({
    id: row.id, state: row.state, textSha256: row.text_sha256,
    idempotencyKey: row.idempotency_key, adapter: row.adapter,
    attempts: row.attempts, maxAttempts: row.max_attempts,
    availableAt: row.available_at, leaseOwner: row.lease_owner,
    leaseToken: row.lease_token, leaseUntil: row.lease_until,
    acknowledgedAt: row.acknowledged_at, evidence: parse(row.evidence_json),
    error: row.error, ...extra,
  });
  const event = (name, jobId, detail = {}) => db.prepare(
    'INSERT INTO job_events(at,event,job_id,detail_json) VALUES(?,?,?,?)',
  ).run(now(), name, jobId, JSON.stringify(detail));
  const transaction = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); secureFiles(); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const retryOrFail = (row, reason) => {
    const message = String(reason || 'worker failed').slice(0, 300);
    const failed = row.attempts >= row.max_attempts;
    const availableAt = failed ? row.available_at : now() + baseBackoffMs * (2 ** Math.max(0, row.attempts - 1));
    const evidence = failed ? JSON.stringify({ kind: 'failure', reason: message }) : null;
    db.prepare(`UPDATE jobs SET state=?,available_at=?,lease_owner=NULL,lease_token=NULL,
      lease_until=NULL,acknowledged_at=NULL,evidence_json=?,error=? WHERE id=?`)
      .run(failed ? 'failed' : 'retry', availableAt, evidence, message, row.id);
    event(failed ? 'failed' : 'retry_scheduled', row.id, { reason: message, availableAt });
    return view(one.get(row.id));
  };
  const sweepInside = () => {
    const expired = db.prepare("SELECT * FROM jobs WHERE state IN ('leased','running') AND lease_until <= ?").all(now());
    for (const row of expired) retryOrFail(row, 'lease expired');
    return expired.length;
  };
  const owned = (row, workerId, leaseToken) => row && row.lease_owner === workerId
    && row.lease_token === leaseToken && row.lease_until > now();

  return {
    submit({ text, idempotencyKey, adapter = 'kingmaker-local', attempts = maxAttempts, jobId: suppliedJobId = null } = {}) {
      const clean = String(text ?? '').trim();
      if (!clean) throw new Error('EMPTY_TEXT');
      if (!safeKey(idempotencyKey)) throw new Error('BAD_IDEMPOTENCY_KEY');
      if (!safeWorker(adapter)) throw new Error('BAD_ADAPTER');
      if (suppliedJobId != null && !safeKey(suppliedJobId)) throw new Error('BAD_JOB_ID');
      return transaction(() => {
        const prior = byKey.get(idempotencyKey); const digest = hashText(clean);
        if (prior) {
          if (prior.text_sha256 !== digest || prior.adapter !== adapter) throw new Error('IDEMPOTENCY_CONFLICT');
          return view(prior, { duplicate: true });
        }
        const jobId = suppliedJobId == null ? id() : suppliedJobId;
        if (one.get(jobId)) throw new Error('JOB_ID_CONFLICT');
        db.prepare(`INSERT INTO jobs(id,text,text_sha256,idempotency_key,adapter,state,attempts,
          max_attempts,available_at) VALUES(?,?,?,?,?,'queued',0,?,?)`)
          .run(jobId, clean, digest, idempotencyKey, adapter, Math.max(1, Math.min(10, Number(attempts) || maxAttempts)), now());
        event('submitted', jobId, { adapter });
        return view(one.get(jobId), { duplicate: false });
      });
    },
    claim(workerId, adapters = ['kingmaker-local']) {
      if (!safeWorker(workerId)) throw new Error('BAD_WORKER_ID');
      const allowed = [...new Set(adapters)].filter(safeWorker);
      if (!allowed.length) return null;
      return transaction(() => {
        sweepInside();
        const marks = allowed.map(() => '?').join(',');
        const row = db.prepare(`SELECT * FROM jobs WHERE state IN ('queued','retry')
          AND available_at <= ? AND adapter IN (${marks}) ORDER BY available_at,id LIMIT 1`).get(now(), ...allowed);
        if (!row) return null;
        const fence = token(); const until = now() + leaseMs;
        db.prepare(`UPDATE jobs SET state='leased',attempts=attempts+1,lease_owner=?,lease_token=?,
          lease_until=?,error=NULL WHERE id=?`).run(workerId, fence, until, row.id);
        event('claimed', row.id, { workerId, attempt: row.attempts + 1 });
        return view(one.get(row.id), { text: row.text });
      });
    },
    acknowledge(jobId, workerId, leaseToken) { return transaction(() => {
      const row = one.get(jobId); if (!owned(row, workerId, leaseToken) || row.state !== 'leased') throw new Error('LEASE_NOT_OWNED');
      db.prepare("UPDATE jobs SET state='running',acknowledged_at=? WHERE id=?").run(now(), jobId);
      event('acknowledged', jobId, { workerId }); event('started', jobId, { workerId }); return view(one.get(jobId));
    }); },
    renewLease(jobId, workerId, leaseToken) { return transaction(() => {
      const row = one.get(jobId); if (!owned(row, workerId, leaseToken) || row.state !== 'running') throw new Error('LEASE_NOT_OWNED');
      const until = now() + leaseMs;
      db.prepare('UPDATE jobs SET lease_until=? WHERE id=?').run(until, jobId);
      event('lease_renewed', jobId, { workerId, leaseUntil: until }); return view(one.get(jobId));
    }); },
    complete(jobId, workerId, leaseToken, evidence) { return transaction(() => {
      const row = one.get(jobId); if (!owned(row, workerId, leaseToken) || !['leased', 'running'].includes(row.state)) throw new Error('LEASE_NOT_OWNED');
      if (!evidence || typeof evidence !== 'object') throw new Error('EVIDENCE_REQUIRED');
      db.prepare(`UPDATE jobs SET state='done',evidence_json=?,lease_owner=NULL,lease_token=NULL,
        lease_until=NULL WHERE id=?`).run(JSON.stringify(evidence), jobId);
      event('evidence_recorded', jobId, { workerId, kind: String(evidence.kind ?? 'unknown').slice(0, 80) });
      if (evidence.reviewRequired === true) event('review_required', jobId, { workerId });
      event('completed', jobId, { workerId }); return view(one.get(jobId));
    }); },
    fail(jobId, workerId, leaseToken, reason) { return transaction(() => {
      const row = one.get(jobId); if (!owned(row, workerId, leaseToken)) throw new Error('LEASE_NOT_OWNED');
      return retryOrFail(row, reason);
    }); },
    cancel(jobId, reason = 'cancelled by owner') { return transaction(() => {
      const row = one.get(jobId); if (!row) throw new Error('NO_SUCH_JOB');
      if (TERMINAL.has(row.state)) return view(row);
      const evidence = { kind: 'cancellation', reason: String(reason).slice(0, 300) };
      db.prepare(`UPDATE jobs SET state='cancelled',evidence_json=?,lease_owner=NULL,
        lease_token=NULL,lease_until=NULL WHERE id=?`).run(JSON.stringify(evidence), jobId);
      event('cancelled', jobId); return view(one.get(jobId));
    }); },
    get(jobId) { return view(one.get(jobId)); },
    events(jobId = null) {
      const rows = jobId ? db.prepare('SELECT * FROM job_events WHERE job_id=? ORDER BY sequence').all(jobId)
        : db.prepare('SELECT * FROM job_events ORDER BY sequence').all();
      return rows.map((row) => ({ sequence: row.sequence, at: row.at, event: row.event, id: row.job_id, ...parse(row.detail_json) }));
    },
    sweep() { return transaction(sweepInside); },
    close() { secureFiles(); db.close(); secureFiles(); },
  };
}
