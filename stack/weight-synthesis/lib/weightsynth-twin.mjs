/**
 * weightsynth-twin.mjs — the headless digital twin: text in, work down
 * the list, receipts out, nothing left behind.
 *
 * The twin is TEXT until ordered (founder's correction, 2026-10-21):
 * its full definition is a small text spec — profile, caps, runtime
 * build, image pins — content-addressed like every other artifact in
 * the engine. No standing replica, no idle compute. On command, the
 * host builds an image FROM the text and boots it headless; this
 * module owns the spec format and the work-list discipline:
 *
 *   - Skills are placed in the twin's folder as *.item.json files.
 *   - A run works DOWN THE LIST in filename order, one item at a time.
 *   - Every item leaves a receipt in receipts/ (kept — receipts are IP).
 *   - Scratch space is wiped when the run ends (amnesic teardown).
 *   - Item payloads may not point outside the work folder: a list that
 *     can escape its folder is not a list, it's a hole.
 *
 * Item kinds: 'screen' (run the Judge suites on a candidate),
 * 'reproduce' (re-run a recipe; the artifact hash must match the
 * recorded one), 'canary' (replay recorded workloads against a pin).
 * Handlers are host-injected — the host owns cells and models; this
 * module owns order, receipts, and refusal.
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { sha256Hex } from './weightsynth-core.mjs';

/* ------------------------------------------------------------------ */
/* The text spec                                                        */
/* ------------------------------------------------------------------ */

const SPEC_KEYS = Object.freeze(['PROFILE', 'RAM_GB', 'CAP_GB', 'RUNTIME', 'IMAGE_PINS', 'HEADLESS']);

/** Canonical text: one KEY=VALUE per line, keys sorted, so the same
 *  twin always serializes to the same bytes — and the same hash. */
export function serializeTwinSpec(spec) {
  const keys = Object.keys(spec).sort();
  return keys.map((k) => `${k}=${spec[k]}`).join('\n') + '\n';
}

export function parseTwinSpec(text) {
  const spec = {};
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith(';')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) throw new Error(`REFUSE twin spec: line is not KEY=VALUE: "${line.slice(0, 40)}"`);
    spec[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  for (const k of ['PROFILE', 'RAM_GB', 'CAP_GB', 'RUNTIME', 'IMAGE_PINS']) {
    if (!spec[k]) throw new Error(`REFUSE twin spec: ${k} is required`);
  }
  if (spec.HEADLESS !== 'always') {
    throw new Error('REFUSE twin spec: HEADLESS=always is required — a twin with a UI surface is not this twin');
  }
  for (const k of Object.keys(spec)) {
    if (!SPEC_KEYS.includes(k)) throw new Error(`REFUSE twin spec: unknown key ${k}`);
  }
  return { spec, specHash: sha256Hex(serializeTwinSpec(spec)) };
}

export function twinSpecFromFile(path) {
  return parseTwinSpec(readFileSync(path, 'utf8'));
}

/* ------------------------------------------------------------------ */
/* The work list                                                        */
/* ------------------------------------------------------------------ */

export const ITEM_KINDS = Object.freeze(['screen', 'reproduce', 'canary']);

function insideFolder(folder, target) {
  const f = resolve(folder) + sep;
  const t = resolve(folder, target);
  return t.startsWith(f);
}

/**
 * Run the folder's list. `handlers[kind](item, ctx)` is host code;
 * ctx carries the twin spec and a scratch dir that will be wiped.
 * Returns the run record (also the receipts' index). A failing item
 * is recorded and the run CONTINUES down the list unless the item
 * says haltOnFailure — a screening list is supposed to contain
 * failures; an escape attempt is not a failure, it is a refusal of
 * the whole run.
 */
export async function runWorkList({ folder, spec, specHash, handlers, clock = () => new Date().toISOString() }) {
  if (!existsSync(folder)) throw new Error(`REFUSE twin run: no folder at ${folder}`);
  const receiptsDir = join(folder, 'receipts');
  const scratchDir = join(folder, '.scratch');
  mkdirSync(receiptsDir, { recursive: true });
  mkdirSync(scratchDir, { recursive: true });

  const files = readdirSync(folder).filter((f) => f.endsWith('.item.json')).sort();
  const record = { kind: 'twin-run', specHash, startedAt: clock(), items: [] };

  try {
    for (const file of files) {
      const item = JSON.parse(readFileSync(join(folder, file), 'utf8'));
      if (!ITEM_KINDS.includes(item.kind)) {
        throw new Error(`REFUSE twin run: ${file} has unknown kind "${item.kind}"`);
      }
      if (item.path && !insideFolder(folder, item.path)) {
        throw new Error(`REFUSE twin run: ${file} points outside the folder — the whole run refuses`);
      }
      const handler = handlers[item.kind];
      if (typeof handler !== 'function') {
        throw new Error(`REFUSE twin run: no handler for kind ${item.kind}`);
      }
      let receipt;
      try {
        const result = await handler(item, { spec, specHash, scratchDir, folder });
        receipt = { item: file, kind: item.kind, ok: true, result: result ?? null, at: clock() };
      } catch (err) {
        receipt = { item: file, kind: item.kind, ok: false, error: String(err.message || err), at: clock() };
      }
      writeFileSync(join(receiptsDir, file.replace(/\.item\.json$/, '.receipt.json')),
        JSON.stringify(receipt, null, 2) + '\n');
      record.items.push(receipt);
      if (!receipt.ok && item.haltOnFailure) break;
    }
  } finally {
    // Amnesic teardown: scratch never survives the run. Receipts do —
    // they are the IP-side record, and they contain no weights.
    rmSync(scratchDir, { recursive: true, force: true });
    record.finishedAt = clock();
    record.scratchWiped = !existsSync(scratchDir);
  }
  return record;
}
