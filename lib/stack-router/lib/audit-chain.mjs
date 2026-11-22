/**
 * lib/audit-chain.mjs (router-phase2)
 *
 * Hash-chained, tamper-evident audit log — the router's copy of the house
 * pattern (kingmaker lib/audit-chain.mjs), adapted for Phase 2: same chain
 * math (every entry links to the previous entry's hash; modify, delete, or
 * reorder any entry and verification fails), plus a file-backed log handle
 * so routing decisions persist across processes. RuFlow's shipped audit
 * store is an in-memory array (§4.4 of the behavior spec) — this chain is
 * the fix: every routing decision lands here, on disk, verifiable.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

function sha256(data) {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

/**
 * Create a new audit chain. The genesis entry anchors the chain.
 */
export function createChain(genesisLabel = 'router-phase2-audit-genesis') {
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
    if (entry.seq !== i) {
      return { ok: false, atSeq: i, reason: `sequence break: expected ${i}, got ${entry.seq}` };
    }
    const recomputed = sha256(JSON.stringify({ ...entry, hash: undefined }));
    if (recomputed !== entry.hash) {
      return { ok: false, atSeq: i, reason: 'entry hash mismatch — entry was modified' };
    }
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

/**
 * A file-backed audit log. Opens (and verifies) the chain at `path`, or
 * starts a fresh one there. append() writes the whole chain back on every
 * entry — routing volume is low and a torn write must never leave a
 * half-valid chain on disk.
 */
export function openAuditLog(path, genesisLabel) {
  let chain;
  if (path && existsSync(path)) {
    chain = loadChain(readFileSync(path, 'utf8'));
  } else {
    chain = createChain(genesisLabel);
    if (path) writeFileSync(path, serializeChain(chain));
  }
  return {
    path: path ?? null,
    entries: chain,
    append(input) {
      const entry = appendEntry(chain, input);
      if (path) writeFileSync(path, serializeChain(chain));
      return entry;
    },
    verify() {
      return verifyChain(chain);
    },
  };
}
