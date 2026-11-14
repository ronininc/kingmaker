/**
 * lib/audit-chain.mjs (space-cell)
 *
 * The house hash-chained, tamper-evident audit pattern — this module's copy
 * for the v0.4.1 space-cell build (same math as router-phase2/lib/audit-chain.mjs:
 * every entry links to the previous entry's hash; modify, delete, or reorder
 * any entry and verification fails), plus a file-backed handle so cell
 * decisions persist across processes.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

function sha256(data) {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

export function createChain(genesisLabel = 'space-cell-audit-genesis') {
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
    } else if (entry.prevHash !== chain[i - 1].hash) {
      return { ok: false, atSeq: i, reason: 'chain link broken — entry deleted or reordered' };
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
