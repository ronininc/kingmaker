// Ronin / Solomon — Audit Chain Schema v1
// Tamper-evident append-only audit log. Every record hash-chains to the
// previous one. Any gap, reorder, or modification is detectable by verifying
// the chain. This is the foundation Phase 2 (dark web search) builds on.

export interface AuditRecordV1 {
  /** Monotonic sequence number. Gaps indicate missing records. */
  seq: number;
  /** ISO timestamp of the record */
  timestamp: string;
  /** What kind of event this is */
  eventType: AuditEventType;
  /** Which Kingmaker method or subsystem produced this record */
  source: string;
  /** Authority level under which the action ran */
  authority: 'NONE' | 'USER' | 'OPERATOR' | 'MANAGER' | 'ADMIN' | 'FOUNDER';
  /** SHA256 of the canonical JSON of the payload (not the payload itself) */
  payloadHash: string;
  /** Human-readable summary. Never contains secrets or raw untrusted content. */
  summaryPlain: string;
  /** SHA256 chain hash: hash(prevChainHash + canonical(record without chainHash)) */
  chainHash: string;
  /** Chain hash of the previous record. Empty string for seq 0 (genesis). */
  prevChainHash: string;
}

export type AuditEventType =
  | 'INGESTION' // untrusted content entered the system
  | 'INJECTION_DETECTED' // prompt injection pattern found in ingested content
  | 'DECISION' // Kingmaker made a routing/authorization decision
  | 'TAP_GRANTED' // founder tap recorded
  | 'TAP_DENIED' // founder tap refused or missing
  | 'METHOD_INVOKED' // a Kingmaker method was called
  | 'METHOD_COMPLETED' // method finished (success or failure)
  | 'METHOD_BLOCKED' // method refused by a guard
  | 'EGRESS_BLOCKED' // network connection to non-allowlisted host refused
  | 'SANDBOX_EVENT' // sandboxed execution event (including escape attempts)
  | 'SPINE_CHANGED' // governance spine selection changed
  | 'MODEL_PINNED' // model version pinned
  | 'MODEL_REVOKED' // model pin revoked
  | 'DARKWEB_SESSION_START' // dark web search session opened
  | 'DARKWEB_QUERY' // dark web search query issued (summary only)
  | 'DARKWEB_ABORT' // session aborted (e.g. CSAM indicators)
  | 'DARKWEB_SESSION_END' // session closed or killed
  | 'DARKWEB_DEVICES_SEALED' // mic + camera sealed at device level for a dive (2026-10-21 sandbox tightening)
  | 'DARKWEB_SELFSCAN_CLEAN' // post-dive self-scan clean — devices unsealed (2026-10-21)
  | 'DARKWEB_SELFSCAN_FINDINGS' // post-dive self-scan findings — devices STAY SEALED, session quarantined (2026-10-21)
  | 'DARKWEB_FINDINGS_ACKNOWLEDGED' // founder acknowledged findings on a fresh tap — unsealed, closed flagged (2026-10-21)
  | 'KILL_SWITCH' // kill switch activated
  | 'CHAIN_VERIFY_FAIL'; // chain verification detected tampering

export interface AuditChainV1 {
  records: AuditRecordV1[];
  /** Chain hash of the most recent record. Empty string when no records. */
  headChainHash: string;
  /** Next sequence number to assign */
  nextSeq: number;
}

export function createEmptyAuditChain(): AuditChainV1 {
  return { records: [], headChainHash: '', nextSeq: 0 };
}
