/**
 * lib/governance-spine.mjs
 *
 * PORTED from ronininc/kingmaker-os contracts/governance-spine.ts
 * Source of truth: kingmaker-os. Do not edit here.
 *
 * The spine is set once at the top. Every model underneath inherits it.
 * The model gets no vote.
 *
 * Spine `kingmaker-x-heretic`: only pinned ABLITERATED models load.
 *   Tap required per session. Full audit. Pinned-but-not-abliterated: refused.
 * Spine `custom`: pinned models load without abliteration requirement.
 * Unpinned weights: refused under BOTH spines.
 */

export const SPINES = {
  CUSTOM: 'custom',
  HERETIC: 'kingmaker-x-heretic',
};

export function createSpineContext(spine = SPINES.CUSTOM) {
  if (!Object.values(SPINES).includes(spine)) {
    throw new Error(`governance-spine: unknown spine "${spine}"`);
  }
  return { spine, sessionTaps: new Set() };
}

/** Record the founder's tap for a session. Required for heretic spine. */
export function tapSession(ctx, sessionId, { auditAppend = null } = {}) {
  ctx.sessionTaps.add(sessionId);
  if (auditAppend) {
    auditAppend({ actor: 'founder', action: 'spine-tap', detail: `spine=${ctx.spine} session=${sessionId}` });
  }
  return true;
}

/**
 * Resolve which model loads for inference under the active spine.
 * Returns { ok: true, record } or { ok: false, reason }.
 */
export function resolveModelForInference(ctx, pinRegistry, canLoadFn, sha256, sessionId) {
  // Unpinned weights are refused under both spines. No exceptions.
  const pin = canLoadFn(pinRegistry, sha256);
  if (!pin.ok) {
    return { ok: false, reason: `unpinned weights refused (spine=${ctx.spine}): ${pin.reason}` };
  }
  const record = pin.record;

  if (ctx.spine === SPINES.HERETIC) {
    if (!record.abliterated) {
      return {
        ok: false,
        reason: 'heretic spine: pinned but not abliterated — refused. Abliterate first, then pin.',
      };
    }
    if (!ctx.sessionTaps.has(sessionId)) {
      return {
        ok: false,
        reason: 'heretic spine: no founder tap for this session — refused. Tap required per session.',
      };
    }
  }
  // custom spine: pinned is enough.
  return { ok: true, record, spine: ctx.spine };
}
