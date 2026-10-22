/**
 * lib/audit-log.mjs
 *
 * LittleBrother's audit log: a local JSONL file, one entry per line,
 * hash-chained exactly the way lib/audit-chain.mjs chains (sha256 over the
 * JSON of the entry with its hash field undefined; every entry links to the
 * previous entry's hash; genesis anchors to 64 zeroes). Modify, delete, or
 * reorder any line and verification fails.
 *
 * Every LittleBrother call is written here — lookups AND refusals. The log
 * is the record the stack sails by. Local file only: no telemetry, nothing
 * leaves the machine.
 *
 * Clean-room: written for LittleBrother from the boundary spec; the hash
 * pattern follows the house audit-chain design.
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
} from 'node:fs';
import { dirname } from 'node:path';

function sha256(data) {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

function hashEntry(entry) {
  return sha256(JSON.stringify({ ...entry, hash: undefined }));
}

/**
 * Verify an array of entries (in file order). Returns { ok: true } or
 * { ok: false, atSeq, reason } — same contract as the house audit chain.
 */
export function verifyEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { ok: false, atSeq: -1, reason: 'empty chain' };
  }
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.seq !== i) {
      return { ok: false, atSeq: i, reason: `sequence break: expected ${i}, got ${entry.seq}` };
    }
    if (hashEntry(entry) !== entry.hash) {
      return { ok: false, atSeq: i, reason: 'entry hash mismatch — entry was modified' };
    }
    if (i === 0) {
      if (entry.prevHash !== '0'.repeat(64)) {
        return { ok: false, atSeq: 0, reason: 'genesis prevHash corrupted' };
      }
    } else if (entry.prevHash !== entries[i - 1].hash) {
      return { ok: false, atSeq: i, reason: 'chain link broken — entry deleted or reordered' };
    }
  }
  return { ok: true };
}

/**
 * Open (or create) the JSONL audit log at `path`. An existing file is parsed
 * and verified on open — a corrupted log is detected, never silently
 * accepted. Returns { append, entries, verify, path }.
 */
export function openAuditLog(path, { genesisLabel = 'littlebrother-audit-genesis' } = {}) {
  if (!path) throw new Error('audit-log: a file path is required');
  let entries = [];

  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf8').trim();
    if (raw.length > 0) {
      entries = raw.split('\n').map((line, i) => {
        try {
          return JSON.parse(line);
        } catch {
          throw new Error(`audit-log: line ${i + 1} of ${path} is not valid JSON — log refused`);
        }
      });
      const check = verifyEntries(entries);
      if (!check.ok) {
        throw new Error(
          `audit-log: persisted chain failed verification at seq ${check.atSeq}: ${check.reason}`
        );
      }
    }
  }

  if (entries.length === 0) {
    mkdirSync(dirname(path), { recursive: true });
    const genesis = {
      seq: 0,
      ts: new Date().toISOString(),
      actor: 'system',
      action: 'genesis',
      detail: genesisLabel,
      prevHash: '0'.repeat(64),
    };
    genesis.hash = hashEntry(genesis);
    entries = [genesis];
    writeFileSync(path, JSON.stringify(genesis) + '\n', 'utf8');
  }

  /**
   * Append an entry and persist it as one JSONL line. Append-only.
   */
  function append({ actor, action, detail = '', meta = {} }) {
    if (!actor || !action) {
      throw new Error('audit-log: actor and action are required');
    }
    const prev = entries[entries.length - 1];
    const entry = {
      seq: prev.seq + 1,
      ts: new Date().toISOString(),
      actor,
      action,
      detail,
      meta,
      prevHash: prev.hash,
    };
    entry.hash = hashEntry(entry);
    entries.push(entry);
    appendFileSync(path, JSON.stringify(entry) + '\n', 'utf8');
    return entry;
  }

  function verify() {
    return verifyEntries(entries);
  }

  return { append, entries, verify, path };
}
