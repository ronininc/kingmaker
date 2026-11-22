/**
 * lib/chain-verify.mjs (training-data-pipeline)
 *
 * Shared reader/verifier for the house hash-chained audit logs. Two on-disk
 * shapes, one chain math (sha256 over the JSON of the entry with its hash
 * field undefined; seq starts at 0; genesis prevHash is 64 zeroes):
 *
 *   - JSON array file  (router-phase2 audit-chain: openAuditLog writes the
 *     whole array on every append)
 *   - JSONL file       (littlebrother audit-log: one entry per line)
 *
 * Used by the exhaust harvester. Local-first, no telemetry, $0.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const ZERO = '0'.repeat(64);

function sha256(data) {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

export function entryHash(entry) {
  return sha256(JSON.stringify({ ...entry, hash: undefined }));
}

export function detectFormat(text) {
  const t = String(text ?? '').trimStart();
  if (t.startsWith('[')) return 'json-array';
  if (t.startsWith('{')) return 'jsonl';
  return 'unknown';
}

/**
 * Parse an audit log file's text into an entries array.
 * Throws on malformed input — a log we cannot parse we do not mine.
 */
export function parseEntries(text) {
  const format = detectFormat(text);
  if (format === 'json-array') {
    const entries = JSON.parse(text);
    if (!Array.isArray(entries)) throw new Error('chain-verify: JSON top level is not an array');
    return entries;
  }
  if (format === 'jsonl') {
    const lines = String(text).trim().split('\n').filter((l) => l.trim().length > 0);
    return lines.map((line) => JSON.parse(line));
  }
  throw new Error('chain-verify: unrecognised audit log shape (expected JSON array or JSONL)');
}

export function readEntries(path) {
  return parseEntries(readFileSync(path, 'utf8'));
}

/**
 * Verify the chain. Same contract as the house pattern:
 * { ok: true } or { ok: false, atSeq, reason }.
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
    if (entryHash(entry) !== entry.hash) {
      return { ok: false, atSeq: i, reason: 'entry hash mismatch — entry was modified' };
    }
    if (i === 0) {
      if (entry.prevHash !== ZERO) return { ok: false, atSeq: 0, reason: 'genesis prevHash corrupted' };
    } else if (entry.prevHash !== entries[i - 1].hash) {
      return { ok: false, atSeq: i, reason: 'chain link broken — entry deleted or reordered' };
    }
  }
  return { ok: true };
}
