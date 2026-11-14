// lib/method-iteration.mjs — recursive iteration: the loop's final step (owner's
// done-criterion, 2026-11-13). A feature is not done when it merely runs — the loop
// must be able to WRITE what it learned back into a method file, so the next
// conduction runs the improved technique instead of the original guess:
//
//   conduct → evaluate → write the improved method → conduct again.
//
// This module is the write seam. The method conductor (lib/method-conductor.mjs)
// reads a library of method files through an index (kingmaker.methods/1); nothing
// in the tree could WRITE one — methods only ever arrived as shipped catalog or as
// repo-streamed text. iterateMethod closes that: given a completed conduction, it
// reads the conducted method from a source index exactly as the conductor does,
// produces the next version of the file, and files it in a LOCAL method store —
// a directory with the same layout the conductor already reads:
//
//   <storeDir>/index.json          (schema kingmaker.methods/1)
//   <storeDir>/<method-id>.method.md
//
// What the next version carries, and what it deliberately does not:
//   · steps — VERBATIM. The step list is the technique; iteration never rewrites
//     the procedure it just ran, it re-files it with what the run proved.
//   · inputs — the values the completed run actually used, written back as the
//     file's new defaults, for the keys the file itself declares. A run that
//     proved samples=1 at 320x240 files a method that now defaults to them.
//     Undeclared keys in the run's inputs are dropped, never smuggled in.
//   · version — bumped (1.0 → 1.1 → 1.2 …), one bump per filed iteration.
//   · an "## Iteration log" section appended (or extended) with the receipt:
//     date, versions, conduction status, step counts, the streamed tool when a
//     check-tool step pulled one, and the inputs carried forward.
//   · quality — inherited from the source descriptor untouched; iteration is a
//     filing act, not a re-judgment.
//
// Fail-closed, like everything around it: the produced file is re-parsed with the
// conductor's own parseMethodFile and the store's next index is validated with
// normalizeMethodsIndex BEFORE anything is written, and the method file is
// written before the index (an unindexed file is inert; an index entry pointing
// at a missing file would break the conductor's library load).
//
// Destination: the store is LOCAL (the execution loop's default is
// <state>/brain-library/methods, beside the tool registry and the access-layer
// store). Whether iterations are later promoted into the shipped catalog or the
// Brain Library repo is the owner's open question — this module writes no repo,
// pushes nothing, and invents no write-back path.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseMethodFile } from './method-conductor.mjs';
import { METHODS_INDEX_URL, METHODS_SCHEMA, normalizeMethodsIndex } from './brain-library.mjs';

const defaultReadText = (loc) => readFile(loc, 'utf8');
const BLOCK_RE = /```kingmaker-method\r?\n[\s\S]*?```/;

/** "1.0" → "1.1", "1.9" → "1.10", "2" → "3", anything else gains a ".1". */
export function bumpMethodVersion(version) {
  const parts = String(version ?? '1.0').split('.');
  const last = parts[parts.length - 1];
  if (/^\d+$/.test(last)) {
    parts[parts.length - 1] = String(Number(last) + 1);
    return parts.join('.');
  }
  return `${String(version ?? '1.0')}.1`;
}

/** The file:// URL of a method store's index — what a conductor is pointed at to read the store. */
export function methodStoreIndexUrl(storeDir) {
  return pathToFileURL(join(storeDir, 'index.json'));
}

function iterationLogLine({ now, fromVersion, toVersion, conduction, appliedInputs, note }) {
  const steps = conduction?.trace ?? [];
  const executed = steps.filter((s) => s.status === 'executed').length;
  const declared = steps.filter((s) => s.status === 'declared').length;
  const pull = steps.find((s) => s.type === 'check-tool' && s.result?.pull?.tool)?.result?.pull;
  const pullText = pull ? ` Streamed tool: ${pull.tool} ${pull.version} (${pull.platform}).` : '';
  const inputsText = appliedInputs.length ? ` Inputs carried forward as the new defaults: ${appliedInputs.join(', ')}.` : ' No input values carried forward.';
  const noteText = note ? ` Run note: ${String(note).replace(/\s+/g, ' ').trim().slice(0, 200)}.` : '';
  return `- ${now.toISOString()} — v${fromVersion} conducted → ${conduction?.status ?? 'unknown'} (${executed} step(s) executed, ${declared} declared).${pullText}${inputsText}${noteText} Filed as v${toVersion} by lib/method-iteration.mjs — this file is the method of record in the local store; the next conduction reads it from there.`;
}

/**
 * File the next version of a conducted method into a local method store.
 * → { id, fromVersion, toVersion, appliedInputs, storeDir, path, indexPath, sha256 }
 * Throws (fail closed, nothing written) when the method is absent from the source
 * index, the produced file does not re-parse as the same method at the new
 * version, or the store's next index fails validation.
 */
export async function iterateMethod({
  methodId,
  conduction = null,
  sourceIndexUrl = METHODS_INDEX_URL,
  readText = defaultReadText,
  storeDir,
  inputUpdates = {},
  note = null,
  now = new Date(),
} = {}) {
  if (!methodId) throw new Error('method-iteration: iterateMethod needs a methodId');
  if (!storeDir) throw new Error('method-iteration: iterateMethod needs a storeDir (the local method store)');
  const nowDate = now instanceof Date ? now : new Date(now);

  // 1. Locate + read the source method exactly as the conductor does.
  const descriptors = normalizeMethodsIndex(JSON.parse(await readText(sourceIndexUrl)));
  const descriptor = descriptors.find((d) => d.id === methodId);
  if (!descriptor) throw new Error(`method-iteration: no method "${methodId}" in the source index — nothing to iterate`);
  const sourceText = await readText(new URL(descriptor.file, sourceIndexUrl));
  const spec = parseMethodFile(sourceText);
  if (spec.id !== methodId) throw new Error(`method-iteration: source file for "${methodId}" parses as "${spec.id}" — refusing to iterate a mismatched file`);

  // 2. The next version: steps verbatim, proven inputs as the new defaults.
  const fromVersion = String(spec.version ?? '1.0');
  const toVersion = bumpMethodVersion(fromVersion);
  const inputs = { ...(spec.inputs ?? {}) };
  const appliedInputs = [];
  for (const [key, value] of Object.entries(inputUpdates ?? {})) {
    if (Object.prototype.hasOwnProperty.call(inputs, key)) {
      inputs[key] = value;
      appliedInputs.push(key);
    }
  }
  const nextSpec = { ...spec, version: toVersion, inputs };

  // 3. Rebuild the file: the source prose stands; the executable block is
  // re-serialized at the new version; the iteration log records the receipt.
  let replaced = false;
  let nextText = sourceText.replace(BLOCK_RE, () => {
    replaced = true;
    return `\`\`\`kingmaker-method\n${JSON.stringify(nextSpec, null, 2)}\n\`\`\``;
  });
  if (!replaced) throw new Error(`method-iteration: source file for "${methodId}" carries no executable block to re-serialize`);
  const line = iterationLogLine({ now: nowDate, fromVersion, toVersion, conduction, appliedInputs, note });
  nextText = /^## Iteration log$/m.test(nextText)
    ? `${nextText.trimEnd()}\n${line}\n`
    : `${nextText.trimEnd()}\n\n## Iteration log\n\n${line}\n`;

  // 4. Validate BEFORE writing: the produced file re-parses as this method at the
  // new version, and the store's next index passes the library's own validation.
  const check = parseMethodFile(nextText);
  if (check.id !== methodId || String(check.version) !== toVersion) {
    throw new Error('method-iteration: the produced file failed validation — nothing written');
  }
  const fileName = `${methodId}.method.md`;
  const nextDescriptor = {
    id: methodId,
    title: spec.title ?? descriptor.title ?? methodId,
    domain: spec.domain ?? descriptor.domain ?? null,
    file: fileName,
    quality: descriptor.quality,
  };
  let prior = [];
  try { prior = normalizeMethodsIndex(JSON.parse(await readFile(join(storeDir, 'index.json'), 'utf8'))); } catch { prior = []; }
  const indexDoc = { schema: METHODS_SCHEMA, methods: [...prior.filter((m) => m.id !== methodId), nextDescriptor] };
  normalizeMethodsIndex(indexDoc);

  // 5. Write: method file first, then the index that makes it conductable.
  await mkdir(storeDir, { recursive: true });
  const filePath = join(storeDir, fileName);
  await writeFile(filePath, nextText, 'utf8');
  const indexPath = join(storeDir, 'index.json');
  await writeFile(indexPath, `${JSON.stringify(indexDoc, null, 2)}\n`, 'utf8');

  return {
    id: methodId, fromVersion, toVersion, appliedInputs,
    storeDir, path: filePath, indexPath,
    sha256: createHash('sha256').update(nextText).digest('hex'),
  };
}
