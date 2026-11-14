/**
 * lib/harvest.mjs (kingmaker-stack)
 *
 * Minimal adapter over the training-data-pipeline's exhaust harvester.
 *
 * WHY THIS EXISTS — a documented/implemented contract mismatch in the
 * pipeline component (found by the stack seam checks, 2026-10-20):
 * `harvestFile`'s doc comment promises `{ records, dropped, chainOk,
 * format }`, but `harvestChain` (which harvestFile delegates to) returns
 * only `{ records, dropped, chainOk }`. The format IS detected — inside
 * chain-verify's parseEntries — but never surfaced to the caller, so a
 * consumer cannot learn which on-disk shape was read.
 *
 * This adapter restores the documented surface without touching the
 * component: it runs the pipeline's OWN detectFormat (the same function
 * parseEntries branches on) over the file bytes and attaches the result.
 * Detection semantics therefore cannot drift from the reader's.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WS = dirname(dirname(dirname(fileURLToPath(import.meta.url)))); // ~/workspace
const PIPELINE = join(WS, 'training-data-pipeline');

const { harvestFile } = await import(join(PIPELINE, 'tools/exhaust-harvester.mjs'));
const { detectFormat } = await import(join(PIPELINE, 'lib/chain-verify.mjs'));

/**
 * harvestFile + the documented `format` field.
 * @returns {{ records, dropped, chainOk, format: 'json-array' | 'jsonl' | 'unknown' }}
 */
export function harvestFileWithFormat(path, opts = {}) {
  const format = detectFormat(readFileSync(path, 'utf8'));
  return { ...harvestFile(path, opts), format };
}
