/**
 * lib/methods-full.mjs
 *
 * LittleBrother's FULL-ONLY methods. Kingmaker build only — this module is
 * never shipped in the Solomon build (build-solomon.mjs physically excludes
 * it and strips every reference to it).
 *
 * These are GOVERNED STUBS with the full interface. Each method requires a
 * founder-tap token to run and refuses without one. The refusal is the
 * default; access is the exception.
 *
 * HARD RULES:
 * - NEVER wire a real non-public source here. The transport is injected for
 *   interface completeness, but these stubs never call it: with a valid tap
 *   they return a stub evidence record (verified:false) noting that wiring a
 *   live source is a founder act, not a code default. A non-public source
 *   gets wired only when the founder points one at it, never by default.
 * - No credential handling. No password resets. No pretexting capability.
 *   Those do not exist in this module, as stubs or otherwise — their
 *   absence is the design, not a feature flag.
 * - CSAM auto-abort discipline (mirrored from darkweb-search): a matched
 *   input aborts, is logged WITHOUT content, and there is no override.
 *
 * Clean-room: implemented from the boundary spec's method descriptions;
 * the GPL upstream was never read and its code is not here.
 */

export const FULL_METHOD_IDS = ['phoneLookup', 'personLookup', 'breachQuery'];

// Minimal seed blocklist, mirrored from darkweb-search. NOT
// production-complete. A matched input aborts the call — no override path.
const CSAM_SEED_PATTERNS = [
  /\bchild\s*porn/i,
  /\bcp\s*(video|pic|image)/i,
  /\blolita\b/i,
  /\bpreteen\b/i,
];

function csamHit(text) {
  for (const re of CSAM_SEED_PATTERNS) {
    if (re.test(text)) return true;
  }
  return false;
}

function refused(reason) {
  return { ok: false, refused: true, reason };
}

function stubResult(methodId, input, note) {
  return {
    ok: true,
    stub: true,
    source: `littlebrother/${methodId}`,
    outlet: 'none — no live non-public source is wired in this build',
    date: new Date().toISOString(),
    data: { input, note },
    verified: false,
  };
}

/**
 * Create the full-only method set. ctx = { verifyTap } where verifyTap is
 * a (possibly async) function (token) => boolean. If verifyTap is absent,
 * every method refuses — fail-closed.
 *
 * Each stub re-verifies the tap itself (defense in depth): even if this
 * module is imported directly, the gate still holds.
 */
export function createFullMethods(ctx = {}) {
  const verifyTap = typeof ctx.verifyTap === 'function' ? ctx.verifyTap : null;

  async function gate(tapToken) {
    if (!verifyTap) return refused('no tap verifier configured — fail-closed');
    let ok = false;
    try {
      ok = Boolean(await verifyTap(tapToken));
    } catch {
      ok = false;
    }
    return ok ? null : refused('founder tap required — full-only method refused');
  }

  async function phoneLookup(phone, { tapToken } = {}) {
    if (!phone || typeof phone !== 'string' || phone.trim() === '') {
      throw new Error('phoneLookup: a non-empty phone string is required');
    }
    if (csamHit(phone)) {
      // Abort WITHOUT content. No override path.
      return { ok: false, aborted: true, reason: 'auto-abort: input matched policy blocklist' };
    }
    const denied = await gate(tapToken);
    if (denied) return denied;
    return stubResult(
      'phoneLookup',
      phone.trim().slice(0, 64),
      'stub: no live non-public source wired — a real source requires a founder pointing one at this method, never a default'
    );
  }

  async function personLookup(query, { tapToken } = {}) {
    if (!query || typeof query !== 'string' || query.trim() === '') {
      throw new Error('personLookup: a non-empty query string is required');
    }
    if (csamHit(query)) {
      return { ok: false, aborted: true, reason: 'auto-abort: input matched policy blocklist' };
    }
    const denied = await gate(tapToken);
    if (denied) return denied;
    return stubResult(
      'personLookup',
      query.trim().slice(0, 256),
      'stub: no live non-public source wired — aggregation of non-public data requires a founder-pointed source, never a default'
    );
  }

  async function breachQuery(identifier, { tapToken } = {}) {
    if (!identifier || typeof identifier !== 'string' || identifier.trim() === '') {
      throw new Error('breachQuery: a non-empty identifier string is required');
    }
    if (csamHit(identifier)) {
      return { ok: false, aborted: true, reason: 'auto-abort: input matched policy blocklist' };
    }
    const denied = await gate(tapToken);
    if (denied) return denied;
    return stubResult(
      'breachQuery',
      identifier.trim().slice(0, 320),
      'stub: no live non-public source wired — breach-data queries require a founder-pointed source, never a default'
    );
  }

  return { phoneLookup, personLookup, breachQuery };
}
