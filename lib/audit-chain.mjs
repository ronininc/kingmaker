/**
 * lib/audit-chain.mjs
 *
 * PORTED from ronininc/kingmaker-os runtime/audit-chain.ts
 * Source of truth: kingmaker-os. Do not edit here — edit the TypeScript
 * source and re-port.
 *
 * Hash-chained, tamper-evident audit log. Every entry links to the previous
 * entry's hash. Modify, delete, or reorder any entry and verification fails.
 * This is the record the founder's tap writes to — the log the ship sails by.
 */

import { createHash } from 'node:crypto';

function sha256(data) {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

/**
 * Create a new audit chain. The genesis entry anchors the chain.
 */
export function createChain(genesisLabel = 'kingmaker-audit-genesis') {
  const genesis = {
    seq: 0,
    ts: new Date().toISOString(),
    actor: 'system',
    action: 'genesis',
    detail: genesisLabel,
    prevHash: '0'.repeat(64),
  };
  genesis.hash = sha256(JSON.stringify({ ...genesis, hash: undefined }));
  return [genesis];
}

/**
 * Append an entry. Returns the new entry (with hash and seq).
 * The chain is append-only — entries are never modified in place.
 */
export function appendEntry(chain, { actor, action, detail = '', meta = {} }) {
  if (!Array.isArray(chain) || chain.length === 0) {
    throw new Error('audit-chain: cannot append to empty chain — call createChain first');
  }
  if (!actor || !action) {
    throw new Error('audit-chain: actor and action are required');
  }
  const prev = chain[chain.length - 1];
  const entry = {
    seq: prev.seq + 1,
    ts: new Date().toISOString(),
    actor,
    action,
    detail,
    meta,
    prevHash: prev.hash,
  };
  entry.hash = sha256(JSON.stringify({ ...entry, hash: undefined }));
  chain.push(entry);
  return entry;
}

/**
 * Verify the full chain. Returns { ok: true } or { ok: false, atSeq, reason }.
 * Detects: modified entries, deleted entries, reordered entries.
 */
export function verifyChain(chain) {
  if (!Array.isArray(chain) || chain.length === 0) {
    return { ok: false, atSeq: -1, reason: 'empty chain' };
  }
  for (let i = 0; i < chain.length; i++) {
    const entry = chain[i];
    // Sequence must be contiguous from 0
    if (entry.seq !== i) {
      return { ok: false, atSeq: i, reason: `sequence break: expected ${i}, got ${entry.seq}` };
    }
    // Hash must recompute
    const recomputed = sha256(JSON.stringify({ ...entry, hash: undefined }));
    if (recomputed !== entry.hash) {
      return { ok: false, atSeq: i, reason: 'entry hash mismatch — entry was modified' };
    }
    // Link must chain (except genesis)
    if (i === 0) {
      if (entry.prevHash !== '0'.repeat(64)) {
        return { ok: false, atSeq: 0, reason: 'genesis prevHash corrupted' };
      }
    } else {
      if (entry.prevHash !== chain[i - 1].hash) {
        return { ok: false, atSeq: i, reason: 'chain link broken — entry deleted or reordered' };
      }
    }
  }
  return { ok: true };
}

/**
 * Serialize / deserialize for persistence. Verification runs on load —
 * a corrupted file is detected, not silently accepted.
 */
export function serializeChain(chain) {
  return JSON.stringify(chain);
}

export function loadChain(serialized) {
  const chain = JSON.parse(serialized);
  const result = verifyChain(chain);
  if (!result.ok) {
    throw new Error(
      `audit-chain: persisted chain failed verification at seq ${result.atSeq}: ${result.reason}`
    );
  }
  return chain;
}
