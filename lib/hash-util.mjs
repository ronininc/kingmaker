/**
 * Model ingestion pipeline — shared hashing helpers.
 *
 * PORTED from kingmaker-os (contracts/model-scan.ts + runtime/hash-util.ts)
 * for the app. Native .mjs; TypeScript types stripped, logic identical.
 *
 * The two TS sources each carried their own copy of canonicalJson/sha256Hex
 * with identical semantics; the port dedupes them into this single module.
 * Every digest in the pipeline (scan signatures, packet hashes, distribution
 * package hashes) flows through here.
 *
 * canonicalJson: deterministic canonical JSON — recursively sorted keys,
 * undefined entries dropped, no whitespace. sha256Hex: lowercase hex sha256
 * of the UTF-8 bytes, via node:crypto. Pure, offline — no I/O, no network.
 *
 * Source of truth: kingmaker-os.
 */

import { createHash } from 'node:crypto';

/** Deterministic canonical JSON: recursively sorted keys, no whitespace. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
    .join(',')}}`;
}

/** sha256 hex of a UTF-8 string. Pure, offline — no I/O, no network. */
export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
