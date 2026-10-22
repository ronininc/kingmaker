// Ronin / Solomon — Audit Chain Runtime v1
// Hash-chained append-only audit log. Every record links to the previous
// record's chain hash. Verification walks the chain and recomputes every
// link. Any tampering — modification, deletion, reordering, insertion —
// breaks the chain and is detectable.

import { createHash } from 'node:crypto';
import {
  createEmptyAuditChain,
  type AuditChainV1,
  type AuditEventType,
  type AuditRecordV1,
} from '../contracts/audit-chain';

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Canonical JSON: sorted keys, no whitespace. Deterministic for hashing. */
function canonicalJson(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  return (
    '{' +
    keys.map((k) => JSON.stringify(k) + ':' + canonicalJson((obj as Record<string, unknown>)[k])).join(',') +
    '}'
  );
}

export interface AppendAuditInput {
  eventType: AuditEventType;
  source: string;
  authority: AuditRecordV1['authority'];
  /** Arbitrary payload. Only its hash is stored — never the raw payload. */
  payload: unknown;
  /** Human-readable summary. Must not contain secrets or raw untrusted content. */
  summaryPlain: string;
}

export function appendAuditRecord(
  chain: AuditChainV1,
  input: AppendAuditInput,
): { chain: AuditChainV1; record: AuditRecordV1 } {
  const timestamp = new Date().toISOString();
  const seq = chain.nextSeq;
  const payloadHash = sha256Hex(canonicalJson(input.payload));
  const prevChainHash = chain.headChainHash;

  // Chain hash covers everything except itself: prev hash + all other fields.
  const preImage = canonicalJson({
    seq,
    timestamp,
    eventType: input.eventType,
    source: input.source,
    authority: input.authority,
    payloadHash,
    summaryPlain: input.summaryPlain,
    prevChainHash,
  });
  const chainHash = sha256Hex(prevChainHash + preImage);

  const record: AuditRecordV1 = {
    seq,
    timestamp,
    eventType: input.eventType,
    source: input.source,
    authority: input.authority,
    payloadHash,
    summaryPlain: input.summaryPlain,
    chainHash,
    prevChainHash,
  };

  return {
    chain: {
      records: [...chain.records, record],
      headChainHash: chainHash,
      nextSeq: seq + 1,
    },
    record,
  };
}

/** Verify the full chain. Returns the seq of the first broken link, or -1 if intact. */
export function verifyAuditChain(chain: AuditChainV1): { ok: boolean; brokenAtSeq: number; reasonPlain: string } {
  let expectedPrev = '';
  for (const record of chain.records) {
    // Check sequence continuity
    if (record.seq !== chain.records.indexOf(record)) {
      return { ok: false, brokenAtSeq: record.seq, reasonPlain: `Sequence gap at seq ${record.seq}` };
    }
    // Check prev hash linkage
    if (record.prevChainHash !== expectedPrev) {
      return { ok: false, brokenAtSeq: record.seq, reasonPlain: `Chain link broken at seq ${record.seq}: prevChainHash mismatch` };
    }
    // Recompute chain hash
    const preImage = canonicalJson({
      seq: record.seq,
      timestamp: record.timestamp,
      eventType: record.eventType,
      source: record.source,
      authority: record.authority,
      payloadHash: record.payloadHash,
      summaryPlain: record.summaryPlain,
      prevChainHash: record.prevChainHash,
    });
    const recomputed = sha256Hex(record.prevChainHash + preImage);
    if (recomputed !== record.chainHash) {
      return { ok: false, brokenAtSeq: record.seq, reasonPlain: `Chain hash mismatch at seq ${record.seq}: record was modified` };
    }
    expectedPrev = record.chainHash;
  }
  // Check head matches
  if (chain.records.length > 0 && chain.headChainHash !== expectedPrev) {
    return { ok: false, brokenAtSeq: chain.records.length, reasonPlain: 'Head chain hash does not match last record' };
  }
  return { ok: true, brokenAtSeq: -1, reasonPlain: `Chain intact: ${chain.records.length} records verified` };
}

export { createEmptyAuditChain };
export type { AuditChainV1 };
