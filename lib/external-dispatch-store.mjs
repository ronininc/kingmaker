import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function createExternalDispatchAdmissionStore({ path, now = () => Date.now() } = {}) {
  if (!path || path === ':memory:') throw new Error('EXTERNAL_ADMISSION_PRIVATE_PATH_REQUIRED');
  const dir = dirname(path), privatePath = (target, type) => { const st = lstatSync(target); if (st.isSymbolicLink() || (type === 'dir' ? !st.isDirectory() : !st.isFile()) || typeof process.getuid === 'function' && st.uid !== process.getuid() || (st.mode & 0o077) !== 0) throw new Error('EXTERNAL_ADMISSION_UNSAFE_PATH'); };
  mkdirSync(dir, { recursive: true, mode: 0o700 }); privatePath(dir, 'dir'); if (existsSync(path)) privatePath(path, 'file');
  const old = process.umask(0o077); let db;
  try { db = new DatabaseSync(path); db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS admissions(key_id TEXT NOT NULL,nonce TEXT NOT NULL,attempt_id TEXT NOT NULL,job_id TEXT NOT NULL,receipt_sha256 TEXT NOT NULL,status TEXT NOT NULL,evidence_json TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(key_id,nonce));`); }
  finally { process.umask(old); }
  const secure = () => { for (const f of [path,`${path}-wal`,`${path}-shm`]) if (existsSync(f)) { chmodSync(f,0o600); privatePath(f,'file'); } }; secure();
  const tx = (fn) => { db.exec('BEGIN IMMEDIATE'); try { const v=fn();db.exec('COMMIT');secure();return v; } catch(e){db.exec('ROLLBACK');throw e;} };
  return {
    admit({ keyId, nonce, attemptId, jobId, receiptSha256 }) { return tx(() => { const prior=db.prepare('SELECT * FROM admissions WHERE key_id=? AND nonce=?').get(keyId,nonce);if(prior){if(prior.attempt_id!==attemptId||prior.job_id!==jobId||prior.receipt_sha256!==receiptSha256)throw new Error('EXTERNAL_DISPATCH_REPLAY_CONFLICT');return{duplicate:true,status:prior.status,evidence:prior.evidence_json?JSON.parse(prior.evidence_json):null};}const t=now();db.prepare("INSERT INTO admissions VALUES(?,?,?,?,?,'admitted',NULL,?,?)").run(keyId,nonce,attemptId,jobId,receiptSha256,t,t);return{duplicate:false,status:'admitted',evidence:null}; }); },
    complete({ keyId, nonce, attemptId, jobId, receiptSha256, evidence }) { return tx(() => { const row=db.prepare('SELECT * FROM admissions WHERE key_id=? AND nonce=?').get(keyId,nonce);if(!row||row.attempt_id!==attemptId||row.job_id!==jobId||row.receipt_sha256!==receiptSha256)throw new Error('EXTERNAL_ADMISSION_NOT_OWNED');const encoded=JSON.stringify(evidence);if(encoded.length>262144)throw new Error('EXTERNAL_ADMISSION_EVIDENCE_TOO_LARGE');if(row.status==='completed'){if(row.evidence_json!==encoded)throw new Error('EXTERNAL_ADMISSION_COMPLETION_CONFLICT');return JSON.parse(row.evidence_json);}db.prepare("UPDATE admissions SET status='completed',evidence_json=?,updated_at=? WHERE key_id=? AND nonce=? AND status='admitted'").run(encoded,now(),keyId,nonce);return evidence; }); },
    close(){secure();db.close();secure();},
  };
}
