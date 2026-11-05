// scripture-armor/streaming-binding.mjs — the small (streaming) build's binding
// to the Brain Library streaming layer.
//
// DESIGN CONSTRAINT (owner, 2026-11-05): this flavor is INVOCATION-AWARE ONLY.
// The streamed capability is inert until a function call invokes it; nothing
// in this module watches, polls, or stays resident between calls. There are
// no timers, watchers, or background loops here by design. Omni-awareness —
// continuous watching, including between jobs — is a property of the full,
// always-loaded build, and no part of the streaming flavor may claim it.
//
// BINDING RULE: this module binds ONLY to a portion-precise puller that ships
// inside this product's own tree (in a source checkout: ../lib/brain-puller.mjs;
// in a staged bundle: ./streaming/brain-puller.mjs). It never reaches into
// another build's tree at runtime. When no puller is present at either
// location the binding fails closed and names the wall instead of improvising
// a substitute puller.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const STREAMING_SCHEMA = 'scripture-armor.streaming/1';
export const AWARENESS = 'invocation-aware-only';
export const WALL_NO_PULLER = 'WALL-STREAMING-LAYER-ABSENT: no portion-precise Brain Library puller (lib/brain-puller.mjs: fetchRange/pullPortion/downloadPartResumable) ships in this tree; the proven puller exists only in an unmerged Kingmaker build copy. Clearing act: merge the proven puller into this tree, then this binding resolves it unchanged.';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function pullerCandidates({ bundleRoot = HERE } = {}) {
  return [
    path.join(bundleRoot, 'streaming', 'brain-puller.mjs'),
    path.join(bundleRoot, '..', 'lib', 'brain-puller.mjs'),
  ];
}

/** Resolve the streaming binding. Inert: performs no network or file writes. */
export function resolveStreamingBinding(opts = {}) {
  const candidates = pullerCandidates(opts);
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    return { schema: STREAMING_SCHEMA, awareness: AWARENESS, available: false, wall: WALL_NO_PULLER, candidates };
  }
  return { schema: STREAMING_SCHEMA, awareness: AWARENESS, available: true, pullerPath: found, candidates };
}

/**
 * The loaded-skill entry point: the ONLY way streamed capability is reached.
 * A caller names a function and the portions it needs; the binding resolves
 * the puller and pulls exactly those portions, which persist in the portion
 * store for the daily churn scan to manage. Between invocations this module
 * does nothing and knows nothing.
 */
export async function invokeStreamed({ portions, storeDir, ...rest } = {}) {
  const binding = resolveStreamingBinding(rest);
  if (!binding.available) throw Object.assign(new Error(binding.wall), { code: 'STREAMING_LAYER_ABSENT' });
  const puller = await import(binding.pullerPath);
  if (typeof puller.pullPortion !== 'function') {
    throw Object.assign(new Error('WALL-STREAMING-LAYER-ABSENT: resolved puller has no pullPortion export'), { code: 'STREAMING_LAYER_ABSENT' });
  }
  const pulled = [];
  for (const portion of portions ?? []) {
    pulled.push(await puller.pullPortion(portion.model, portion, { ...rest, storeDir }));
  }
  return { schema: STREAMING_SCHEMA, awareness: AWARENESS, pulled };
}
