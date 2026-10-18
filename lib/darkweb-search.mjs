/**
 * lib/darkweb-search.mjs
 *
 * PORTED from ronininc/kingmaker-os runtime/darkweb-search.ts
 * Source of truth: kingmaker-os. Do not edit here.
 *
 * Governed dark/deep web search. Tor-only, fail-closed, read-only, text-only.
 * Per-session founder tap with bounded scope. Full transcripts in audit chain.
 *
 * CSAM auto-abort: HARD RULE, no override path. Not tap, not session, nothing.
 * Abort in <1s, log the abort WITHOUT content, notify the founder.
 *
 * Status: UNTESTED live. No Tor traffic has run through this module.
 * The keyword blocklist below is a minimal seed — production MUST add a
 * comprehensive blocklist + hash database before live use.
 */

// Minimal seed blocklist. NOT production-complete.
const CSAM_SEED_PATTERNS = [
  /\bchild\s*porn/i,
  /\bcp\s*(video|pic|image)/i,
  /\blolita\b/i,
  /\bpreteen\b/i,
];

const DEFAULT_SCOPE = {
  maxDurationMs: 30 * 60 * 1000, // 30 minutes
  maxQueries: 50,
};

export function createSession({ founderTap, auditAppend, scope = {} }) {
  if (!founderTap) {
    throw new Error('darkweb-search: no founder tap — session refused');
  }
  const merged = { ...DEFAULT_SCOPE, ...scope };
  const session = {
    id: `dw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    startedAt: Date.now(),
    queries: 0,
    maxQueries: merged.maxQueries,
    deadline: Date.now() + merged.maxDurationMs,
    killed: false,
    transcript: [],
  };
  if (auditAppend) {
    auditAppend({
      actor: 'founder',
      action: 'darkweb-session-start',
      detail: `session=${session.id} maxQueries=${session.maxQueries}`,
    });
  }
  session.auditAppend = auditAppend || null;
  return session;
}

/** Kill switch: <5s. Marks session dead; further queries refused. */
export function killSession(session, { auditAppend = null, reason = 'manual kill' } = {}) {
  session.killed = true;
  const append = auditAppend || session.auditAppend;
  if (append) {
    append({ actor: 'system', action: 'darkweb-session-kill', detail: `session=${session.id} reason=${reason}` });
  }
  return true;
}

function checkScope(session) {
  if (session.killed) return { ok: false, reason: 'session killed' };
  if (Date.now() > session.deadline) return { ok: false, reason: 'session scope expired (30min bound)' };
  if (session.queries >= session.maxQueries) return { ok: false, reason: 'session query bound reached (50)' };
  return { ok: true };
}

function csamCheck(text) {
  for (const re of CSAM_SEED_PATTERNS) {
    if (re.test(text)) return true;
  }
  return false;
}

/**
 * Run one query. The `transport` is injected (Tor client on the host).
 * Returns { ok, result } or { ok: false, aborted, reason }.
 *
 * CSAM auto-abort: aborts in <1s, logs WITHOUT content, notifies founder.
 * There is no override path. Do not add one.
 */
export async function query(session, queryText, { transport, onCsAbuse = null } = {}) {
  const scope = checkScope(session);
  if (!scope.ok) {
    return { ok: false, reason: scope.reason };
  }

  // CSAM check on the QUERY first — abort before any traffic.
  if (csamCheck(queryText)) {
    return csamAbort(session, 'query', onCsAbuse);
  }

  session.queries += 1;
  let result;
  try {
    // Transport MUST be tor-only (enforced by egress-guard tor-only policy).
    result = await transport(queryText);
  } catch (err) {
    return { ok: false, reason: `transport failed (fail-closed, no clearnet fallback): ${err.message}` };
  }

  // CSAM check on the RESULT — text only, never images/binaries.
  const text = typeof result === 'string' ? result : JSON.stringify(result);
  if (csamCheck(text)) {
    return csamAbort(session, 'result', onCsAbuse);
  }

  session.transcript.push({ q: queryText, at: new Date().toISOString(), chars: text.length });
  return { ok: true, result: text };
}

function csamAbort(session, where, onCsAbuse) {
  killSession(session, { reason: `csam-auto-abort (${where})` });
  // Log the abort WITHOUT content. Never the matched text.
  if (session.auditAppend) {
    session.auditAppend({
      actor: 'system',
      action: 'darkweb-csam-abort',
      detail: `session=${session.id} where=${where} — content withheld by policy`,
    });
  }
  if (onCsAbuse) {
    try {
      onCsAbuse({ sessionId: session.id, where });
    } catch {
      // Notification failure must not resurrect the session.
    }
  }
  return {
    ok: false,
    aborted: true,
    reason: 'CSAM auto-abort: session killed, no override path exists',
  };
}
