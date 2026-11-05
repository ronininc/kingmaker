// B1 — Retention layer: the findings ledger (SPEC §3.1).
// Append-only, hash-chained JSONL at <identityDir>/shield-corpus/records.jsonl.
// Chain pattern follows the proven LB audit log (seq, ts, prevHash, hash;
// genesis prevHash = 64 zeroes; hash = sha256 over the entry JSON with the
// hash field undefined). Writes are tmp+rename+fsync, mode 0600 — the write
// discipline the attempts feed specifies [INV §3d]. Each entry is an envelope
// around an EXISTING record shape; no new finding schema is invented.
//
// Principle (SPEC §3.1, from A3/A4): collection happens BEFORE the sandbox
// cycle destroys, as records, emitted by the lane that produced them.
// Contents never survive; testimony always survives.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const LEDGER_SCHEMA = 'scripture-armor.shield-corpus/1';
const GENESIS = '0'.repeat(64);

function sha256(data) { return crypto.createHash('sha256').update(data, 'utf8').digest('hex'); }
function entryHash(entry) { return sha256(JSON.stringify({ ...entry, hash: undefined })); }

export function ledgerPath(identityDir) {
  return path.join(identityDir, 'shield-corpus', 'records.jsonl');
}

function writeFileDurable(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
  try { const dfd = fs.openSync(path.dirname(file), 'r'); fs.fsyncSync(dfd); fs.closeSync(dfd); } catch {}
}

// Read + parse the ledger file. Returns { entries, corrupt } where corrupt
// lists line numbers that fail to parse (a truncated/forged tail shows here).
export function readLedger(identityDir) {
  const file = ledgerPath(identityDir);
  if (!fs.existsSync(file)) return { entries: [], corrupt: [] };
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0);
  const entries = [], corrupt = [];
  lines.forEach((line, i) => {
    try { entries.push(JSON.parse(line)); } catch { corrupt.push(i); }
  });
  return { entries, corrupt };
}

// Verify the hash chain over parsed entries. Same contract as the house
// audit chain: { ok: true } or { ok: false, atSeq, reason }.
export function verifyChain(entries) {
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.seq !== i) return { ok: false, atSeq: i, reason: `sequence break: expected ${i}, got ${e.seq}` };
    if (entryHash(e) !== e.hash) return { ok: false, atSeq: i, reason: 'entry hash mismatch — entry was modified' };
    if (i === 0) {
      if (e.prevHash !== GENESIS) return { ok: false, atSeq: 0, reason: 'genesis prevHash corrupted' };
    } else if (e.prevHash !== entries[i - 1].hash) {
      return { ok: false, atSeq: i, reason: 'chain link broken — entry deleted or reordered' };
    }
  }
  return { ok: true, count: entries.length };
}

// Append one envelope. The ledger is rewritten through the durable path
// (full-file tmp+rename) so a crash cannot leave a half-written line that
// would masquerade as testimony. Refuses to append onto a broken chain:
// poisoned or damaged testimony is quarantined, never extended.
export function appendRecord(identityDir, { lane, source_id, rules_version, record }) {
  const file = ledgerPath(identityDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const { entries, corrupt } = readLedger(identityDir);
  if (corrupt.length) throw new Error(`ledger has ${corrupt.length} unparseable line(s); refusing to append`);
  const v = verifyChain(entries);
  if (!v.ok) throw new Error(`ledger chain broken at seq ${v.atSeq}: ${v.reason}; refusing to append`);
  const seq = entries.length;
  const entry = {
    seq, ts: new Date().toISOString(), lane, source_id,
    rules_version: rules_version ?? null, record,
    prevHash: seq === 0 ? GENESIS : entries[seq - 1].hash,
  };
  entry.hash = entryHash(entry);
  const body = entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '') + JSON.stringify(entry) + '\n';
  writeFileDurable(file, body);
  return entry;
}

// Lane emitters (SPEC §3.1 per-lane collection). Each takes an existing
// record shape and wraps it — collection only, no schema invention.
export function emitScanRecord(identityDir, rec, source_id) {
  return appendRecord(identityDir, { lane: laneOfScan(rec), source_id, rules_version: rec?.engine?.rules ?? 'scan-rules/1', record: rec });
}
function laneOfScan(rec) { return rec && rec.format === 'scripture-armor-scan/1' ? 'repository' : 'upload'; }
export function emitFileReview(identityDir, rec, source_id) {
  return appendRecord(identityDir, { lane: 'upload', source_id, rules_version: 'scan-rules/1', record: rec });
}
export function emitBeacon(identityDir, ev) {
  return appendRecord(identityDir, { lane: 'beacon', source_id: ev.canary ?? null, rules_version: null, record: ev });
}
export function emitAttempts(identityDir, entry) {
  return appendRecord(identityDir, { lane: 'activation', source_id: entry.canaryId ?? null, rules_version: 'scripture-armor.attempts/1', record: entry });
}
export function emitActivation(identityDir, rec, source_id) {
  return appendRecord(identityDir, { lane: 'activation', source_id, rules_version: null, record: rec });
}
export function emitDeviceFindings(identityDir, rec, source_id) {
  return appendRecord(identityDir, { lane: 'device', source_id, rules_version: 'scan-rules/1', record: rec });
}
export function emitGateReceipt(identityDir, receipt, cycle_id) {
  return appendRecord(identityDir, { lane: 'shield-loop', source_id: cycle_id, rules_version: receipt.rules_version ?? null, record: receipt });
}
export function emitCycle(identityDir, cycle) {
  return appendRecord(identityDir, { lane: 'shield-loop', source_id: cycle.cycle_id, rules_version: cycle.rules_version ?? null, record: cycle });
}
