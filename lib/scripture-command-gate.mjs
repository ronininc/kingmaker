// Pre-dispatch boundary. Message text and self-asserted identities never grant authority.
// The signer pin, recipient identity and audience come only from local operator configuration.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, lstatSync, chmodSync, existsSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { openInbound, signFpOfBlock, armor, identityDir } from './armor-native.mjs';

const gates = new WeakSet(), admissions = new WeakMap();
const MAX_BYTES = 256 * 1024, MAX_AGE = 60_000;
const canonical = (v) => v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
const hash = (v) => createHash('sha256').update(canonical(v)).digest('hex');
const fail = (why) => { throw new Error(`SCRIPTURE_COMMAND_${why}`); };
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === keys.sort().join(',');
// The dispatch receipt has its own mandatory independent signature gate downstream.
export function commandJob(job) {
  if (!job || typeof job !== 'object' || Array.isArray(job)) fail('JOB_REQUIRED');
  const { dispatchReceipt, ...body } = job;
  return body;
}

export function createScriptureCommandGate({ state, senderBlock, audience, now = Date.now } = {}) {
  if (!isAbsolute(String(state ?? '')) || !/^[A-Za-z0-9._:-]{1,128}$/.test(String(audience ?? '')) || typeof now !== 'function') fail('LOCAL_CONFIG_REQUIRED');
  const sender = signFpOfBlock(senderBlock); // Never learn a signer from an arriving message.
  const owner = armor.parsePublicBlock(senderBlock);
  if (!owner.mldsa_pub || !owner.kem_pub) fail('POST_QUANTUM_OWNER_REQUIRED');
  const pqSender = armor.fingerprintOfRaw(Buffer.from(owner.mldsa_pub, 'base64'));
  const recipient = armor.loadIdentity(identityDir(state));
  if (!recipient || recipient.signFp === sender || recipient.mldsaFp === pqSender) fail('DISTINCT_OWNER_SIGNER_REQUIRED');
  const dir = join(state, 'armor');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const safe = (path, directory = false) => {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || (directory ? !st.isDirectory() : !st.isFile() || st.nlink !== 1) || (st.mode & 0o077) || typeof process.getuid === 'function' && st.uid !== process.getuid()) fail('STATE_UNSAFE');
    return st;
  };
  safe(dir, true);
  const file = join(dir, 'command-admissions.sqlite'), witness = `${file}.initialized`;
  const initialized = existsSync(witness);
  if (initialized !== existsSync(file)) fail('REPLAY_STATE_MISSING');
  if (!existsSync(file)) closeSync(openSync(file, 'wx', 0o600));
  safe(file);
  if (existsSync(witness)) safe(witness);
  const db = new DatabaseSync(file);
  let ledgerIdentity, witnessIdentity;
  try {
    chmodSync(file, 0o600);
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000');
    if (initialized) {
      const columns = db.prepare('PRAGMA table_info(consumed)').all();
      if (columns.length !== 3 || columns.some((c, i) => c.name !== ['canary','digest','expires'][i] || c.type !== ['TEXT','TEXT','INTEGER'][i] || c.notnull !== 1) || columns[0].pk !== 1) fail('REPLAY_SCHEMA');
      if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') fail('REPLAY_STORAGE');
    } else db.exec('CREATE TABLE consumed (canary TEXT PRIMARY KEY, digest TEXT NOT NULL, expires INTEGER NOT NULL) STRICT');
    if (!existsSync(witness)) writeFileSync(witness, 'Replay state must not be reset automatically.\n', { mode: 0o600, flag: 'wx' });
    ledgerIdentity = safe(file); witnessIdentity = safe(witness);
  } catch (e) { db.close(); throw e; }
  let closed = false;
  const gate = Object.freeze({
    admit(packet, { attemptId, job } = {}) {
      if (closed) fail('GATE_CLOSED');
      if (typeof packet !== 'string' || !packet || Buffer.byteLength(packet) > MAX_BYTES) fail('ARMOR_REQUIRED');
      const opened = openInbound(state, packet, { expectSenderSignFp: sender, expectSenderMldsaFp: pqSender });
      if (opened.frame.v !== 4) fail('PROTOCOL_REQUIRED');
      if (opened.plaintext.length > MAX_BYTES) fail('TOO_LARGE');
      let body; try { body = JSON.parse(opened.plaintext.toString('utf8')); } catch { fail('SCHEMA'); }
      if (!exact(body, ['schema','audience','action','attemptId','issuedAt','expiresAt','job']) || body.schema !== 'ronin.scripture-command/v1' || body.action !== 'external-static-inventory' || body.audience !== audience || body.attemptId !== attemptId || !/^[0-9a-f-]{36}$/i.test(String(attemptId))) fail('BINDING');
      const t = now(), expiry = Date.parse(opened.frame.expiry);
      if (!Number.isSafeInteger(t) || !Number.isSafeInteger(body.issuedAt) || !Number.isSafeInteger(body.expiresAt) || body.issuedAt > t || body.issuedAt < t - MAX_AGE || body.expiresAt <= t || body.expiresAt <= body.issuedAt || body.expiresAt - body.issuedAt > MAX_AGE || !Number.isFinite(expiry) || expiry !== body.expiresAt) fail('STALE');
      const digest = hash(commandJob(job));
      if (hash(body.job) !== digest) fail('JOB_MISMATCH');
      // One atomic durable insertion arbitrates concurrent processes before any callback.
      if (!existsSync(file) || !existsSync(witness)) fail('REPLAY_STATE_MISSING');
      const ledgerNow = safe(file), witnessNow = safe(witness);
      if (ledgerNow.dev !== ledgerIdentity.dev || ledgerNow.ino !== ledgerIdentity.ino ||
          witnessNow.dev !== witnessIdentity.dev || witnessNow.ino !== witnessIdentity.ino) fail('REPLAY_STATE_REPLACED');
      try { db.prepare('INSERT INTO consumed VALUES (?, ?, ?)').run(opened.frame.canary, digest, body.expiresAt); }
      catch { fail('REPLAY_OR_STORAGE'); }
      const proof = Object.freeze({});
      admissions.set(proof, { attemptId, digest, expiresAt: body.expiresAt, now, isOpen: () => !closed, used: false });
      return proof;
    },
    close() { if (!closed) { closed = true; db.close(); } },
  });
  gates.add(gate);
  return gate;
}
export function isScriptureCommandGate(gate) { return gates.has(gate); }
export function consumeScriptureCommand(proof, { attemptId, job } = {}) {
  const admitted = admissions.get(proof);
  if (!admitted || !admitted.isOpen() || admitted.used || admitted.expiresAt <= admitted.now() || admitted.attemptId !== attemptId || admitted.digest !== hash(commandJob(job))) fail('ADMISSION_REQUIRED');
  admitted.used = true;
}

// Recheck after asynchronous authority/status lookups, immediately before work.
export function recheckScriptureCommand(proof, { attemptId, job } = {}) {
  const admitted = admissions.get(proof);
  if (!admitted || !admitted.isOpen() || !admitted.used || admitted.expiresAt <= admitted.now() || admitted.attemptId !== attemptId || admitted.digest !== hash(commandJob(job))) fail('ADMISSION_REQUIRED');
}

export function commandJobDigest(job) { return hash(commandJob(job)); }
