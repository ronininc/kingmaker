/**
 * lib/darkweb-search.mjs
 *
 * PORTED from ronininc/kingmaker-os runtime/darkweb-search.ts
 * Source of truth: kingmaker-os. Three tightenings were applied 2026-10-20 on
 * Robbie's direct orders ahead of the v0.4.1 build — (1) "tripwire needs to
 * be instant", (2) "dark web search needs read to happen in a bounded
 * sandbox", (3) mic/camera sealed at the device level for the whole dive
 * and released only after the sandbox's post-dive self-scan — port all
 * three back to runtime/darkweb-search.ts so the source and this copy stay
 * in step.
 *
 * Governed dark/deep web search. Tor-only, fail-closed, read-only, text-only.
 * Per-session founder tap with bounded scope. Full transcripts in audit chain.
 *
 * BOUNDED SANDBOX: a session cannot exist without a sandbox binding. The
 * binding is issued by the governor/host layer (the SPACE cell governor for
 * the read, the host agent for the device seal) and provides: the read
 * transport (executes INSIDE the cell, Tor-only egress, no host filesystem),
 * the device seal (mic + camera disabled at the device level), and the
 * self-scan (a snapshot/diff of the sandbox's own state). No binding, no
 * session, no exceptions.
 *
 * SESSION LIFECYCLE (a state machine, fail-closed at every gate):
 *   created → begin(): seal devices, THEN snapshot, then active.
 *             A query on a session that is not active is refused. If the
 *             seal or the snapshot fails, the session never activates.
 *   active  → queries (below). kill() stops queries immediately.
 *   ending  → end(): the self-scan diffs the sandbox against its pre-dive
 *             snapshot. CLEAN → unseal, closed-clean. FINDINGS (anything
 *             added or changed that was not there before the dive) → the
 *             devices STAY SEALED, the session is quarantined, the founder
 *             is notified; unseal then requires the founder's explicit
 *             acknowledgment of the findings. A scan that FAILS is treated
 *             as findings: nothing unseals on an error, ever. A killed
 *             session still owes its scan — kill stops the reading, it
 *             does not skip the scan.
 *
 * CSAM auto-abort: HARD RULE, no override path. Not tap, not session, nothing.
 * INSTANT, not budgeted: results are scanned as they STREAM, chunk by chunk,
 * before anything is assembled, returned, or written anywhere. The first
 * matching chunk kills the transfer mid-flight (the transport is torn down),
 * kills the session, and logs the abort WITHOUT content. A query that trips
 * the check never reaches the network at all. (A CSAM abort does not skip
 * the lifecycle: the session still ends through end() and its self-scan.)
 *
 * TEXT ONLY, enforced: the read returns text or it returns nothing. Every
 * chunk must be a string — a Buffer, an object, any non-string payload is
 * refused and the stream is torn down. A long unbroken base64 run inside
 * the text is an encoded binary wearing a text costume: refused the same
 * way. No images, no binaries, no decoders — if it isn't text, it never
 * crosses the sandbox wall.
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

// Rolling-window carry: long enough that a pattern split across a chunk
// boundary still matches whole. Comfortably above any seed pattern's span.
const CARRY_CHARS = 128;

// Text-only enforcement: an unbroken run of base64 alphabet this long is an
// encoded binary, not prose (512 chars ≈ 384 bytes of payload). Shorter
// runs — hashes, onion addresses, tokens — are ordinary text.
const BINARY_BLOB = /[A-Za-z0-9+/]{512,}={0,2}/;

const DEFAULT_SCOPE = {
  maxDurationMs: 30 * 60 * 1000, // 30 minutes
  maxQueries: 50,
  maxStreamBytes: 5 * 1024 * 1024, // a read is bounded in size, not just time
};

/**
 * A sandbox binding is the governor/host layer's handle:
 *   { id, transport, seal, unseal, snapshot, diffScan }
 * transport(query) performs the fetch INSIDE the bounded cell and returns a
 * string/object or an async iterable of text chunks. seal()/unseal()
 * disable/restore mic + camera at the device level and resolve to an
 * attestation { mic: boolean, camera: boolean } (true = disabled for seal,
 * restored for unseal). snapshot() resolves to an opaque pre-dive state
 * token; diffScan(before) resolves to { added: [], changed: [], removed: [] }
 * describing what in the sandbox is different from before the dive.
 * Anything missing any of these is not a binding and starts nothing.
 */
const BINDING_FUNCTIONS = ['transport', 'seal', 'unseal', 'snapshot', 'diffScan'];
function assertSandbox(sandbox) {
  if (!sandbox || typeof sandbox !== 'object'
    || typeof sandbox.id !== 'string' || sandbox.id.length === 0
    || BINDING_FUNCTIONS.some((f) => typeof sandbox[f] !== 'function')) {
    throw new Error('darkweb-search: no bounded sandbox binding — session refused (reads happen in the sandbox, devices sealed, self-scan owed)');
  }
}

export function createSession({ founderTap, auditAppend, scope = {}, sandbox = null }) {
  if (!founderTap) {
    throw new Error('darkweb-search: no founder tap — session refused');
  }
  assertSandbox(sandbox);
  const merged = { ...DEFAULT_SCOPE, ...scope };
  const session = {
    id: `dw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
    startedAt: null,
    queries: 0,
    maxQueries: merged.maxQueries,
    maxStreamBytes: merged.maxStreamBytes,
    maxDurationMs: merged.maxDurationMs,
    deadline: null,
    state: 'created', // created → active → scanning → closed-clean | quarantined → closed-flagged
    killed: false,
    sealed: false,
    snapshot: null,
    findings: null,
    transcript: [],
    sandbox,
  };
  if (auditAppend) {
    auditAppend({
      actor: 'founder',
      action: 'darkweb-session-start',
      detail: `session=${session.id} sandbox=${sandbox.id} maxQueries=${session.maxQueries} maxStreamBytes=${session.maxStreamBytes}`,
    });
  }
  session.auditAppend = auditAppend || null;
  return session;
}

/**
 * Begin the dive: seal the devices FIRST, snapshot SECOND, activate LAST.
 * Fail-closed: any failure leaves the session un-activated (and a failed
 * seal means nothing was ever exposed; a failed snapshot after a good seal
 * unseals and refuses — no dive without a baseline to diff against).
 */
export async function beginSession(session) {
  if (session.state !== 'created') {
    return { ok: false, reason: `session is ${session.state}, not created` };
  }
  assertSandbox(session.sandbox);
  let seal;
  try {
    seal = await session.sandbox.seal();
  } catch (err) {
    return { ok: false, reason: `device seal failed (fail-closed, dive refused): ${err.message}` };
  }
  if (!seal || seal.mic !== true || seal.camera !== true) {
    return { ok: false, reason: 'device seal not attested (mic AND camera must report disabled) — dive refused' };
  }
  session.sealed = true;
  audit(session, 'system', 'darkweb-devices-sealed', `session=${session.id} sandbox=${session.sandbox.id}`);
  try {
    session.snapshot = await session.sandbox.snapshot();
  } catch (err) {
    // Sealed but no baseline: unseal and refuse. A dive without a snapshot
    // can never prove what it left behind.
    try { await session.sandbox.unseal(); session.sealed = false; } catch { /* stay sealed; surfaced below */ }
    return { ok: false, reason: `pre-dive snapshot failed (fail-closed, dive refused): ${err.message}` };
  }
  session.startedAt = Date.now();
  session.deadline = session.startedAt + (session.maxDurationMs ?? DEFAULT_SCOPE.maxDurationMs);
  session.state = 'active';
  audit(session, 'system', 'darkweb-session-active', `session=${session.id}`);
  return { ok: true };
}

/** Kill switch: immediate. Marks the session dead synchronously; an in-flight
 *  stream checks the flag between chunks and tears down on the next chunk.
 *  Devices stay sealed and the self-scan is still owed — see endSession. */
export function killSession(session, { auditAppend = null, reason = 'manual kill' } = {}) {
  session.killed = true;
  const append = auditAppend || session.auditAppend;
  if (append) {
    append({ actor: 'system', action: 'darkweb-session-kill', detail: `session=${session.id} reason=${reason}` });
  }
  return true;
}

/**
 * End the dive: run the self-scan and settle the seal.
 *   diff clean        → unseal, state closed-clean.
 *   findings          → STAY SEALED, state quarantined, founder notified
 *                       (onAnomaly). Unseal only via acknowledgeFindings()
 *                       with a fresh founder tap.
 *   scan/unseal error → treated as findings (quarantined); nothing unseals
 *                       on an error.
 */
export async function endSession(session, { onAnomaly = null } = {}) {
  if (session.state === 'closed-clean' || session.state === 'closed-flagged') {
    return { ok: false, reason: `session already ${session.state}` };
  }
  if (!session.sealed) {
    session.state = 'closed-clean';
    return { ok: true, clean: true, note: 'never sealed (dive never began)' };
  }
  session.state = 'scanning';
  let diff = null;
  let scanError = null;
  try {
    diff = await session.sandbox.diffScan(session.snapshot);
  } catch (err) {
    scanError = err;
  }
  const added = Array.isArray(diff?.added) ? diff.added : [];
  const changed = Array.isArray(diff?.changed) ? diff.changed : [];
  const removed = Array.isArray(diff?.removed) ? diff.removed : [];
  if (!scanError && added.length === 0 && changed.length === 0) {
    try {
      await session.sandbox.unseal();
    } catch (err) {
      session.state = 'quarantined';
      session.findings = { added, changed, removed, error: `unseal failed: ${err.message}` };
      notifyAnomaly(session, onAnomaly, session.findings);
      return { ok: false, clean: false, quarantined: true, reason: `clean scan but unseal failed: ${err.message}` };
    }
    session.sealed = false;
    session.state = 'closed-clean';
    audit(session, 'system', 'darkweb-selfscan-clean', `session=${session.id} removed=${removed.length} — devices unsealed`);
    return { ok: true, clean: true, removed: removed.length };
  }
  // Findings (or a failed scan): the seal HOLDS.
  session.findings = { added, changed, removed, ...(scanError ? { error: scanError.message } : {}) };
  session.state = 'quarantined';
  audit(session, 'system', 'darkweb-selfscan-findings',
    `session=${session.id} added=${added.length} changed=${changed.length} removed=${removed.length}${scanError ? ` scanError=${scanError.message}` : ''} — devices REMAIN SEALED`);
  notifyAnomaly(session, onAnomaly, session.findings);
  return { ok: false, clean: false, quarantined: true, findings: session.findings };
}

/**
 * The ONLY way out of quarantine: the founder sees the findings and taps.
 * Paths/hashes of findings are the founder's to review in the audit chain;
 * this function takes the tap, unseals, and closes the session flagged.
 */
export async function acknowledgeFindings(session, { founderTap } = {}) {
  if (session.state !== 'quarantined') {
    return { ok: false, reason: `session is ${session.state}, not quarantined` };
  }
  if (!founderTap) {
    return { ok: false, reason: 'findings acknowledgment requires the founder tap — seal holds' };
  }
  try {
    await session.sandbox.unseal();
  } catch (err) {
    return { ok: false, reason: `unseal failed: ${err.message} — seal holds` };
  }
  session.sealed = false;
  session.state = 'closed-flagged';
  audit(session, 'founder', 'darkweb-findings-acknowledged', `session=${session.id} — devices unsealed on founder tap, session closed FLAGGED`);
  return { ok: true };
}

function notifyAnomaly(session, onAnomaly, findings) {
  if (onAnomaly) {
    try { onAnomaly({ sessionId: session.id, findings }); } catch { /* notification failure changes nothing */ }
  }
}

function audit(session, actor, action, detail) {
  if (session.auditAppend) session.auditAppend({ actor, action, detail });
}

function checkScope(session) {
  if (session.state !== 'active') return { ok: false, reason: `session not active (state=${session.state})` };
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
 * Run one query through the session's sandbox (session must be active —
 * sealed, snapshotted). The sandbox's transport may return a whole result
 * (string/object) or an ASYNC ITERABLE of text chunks. Chunks are scanned
 * BEFORE assembly with a rolling carry window, so a match split across
 * chunk boundaries still trips. On a trip — on the session being killed
 * mid-stream — or on the stream exceeding its byte bound, iteration stops
 * at once: breaking the iterator calls its return(), which the sandboxed
 * transport MUST honor by tearing down the underlying Tor request inside
 * the cell. Nothing partial is returned, transcripted, or retained.
 * Returns { ok, result } or { ok: false, aborted?, reason }.
 *
 * CSAM auto-abort: instant (first matching chunk), logs WITHOUT content,
 * notifies founder. There is no override path. Do not add one.
 */
export async function query(session, queryText, { onCsAbuse = null } = {}) {
  const scope = checkScope(session);
  if (!scope.ok) {
    return { ok: false, reason: scope.reason };
  }
  // Re-assert the binding at call time: a session whose sandbox was stripped
  // or swapped after creation does not run.
  assertSandbox(session.sandbox);

  // CSAM check on the QUERY first — abort before any traffic.
  if (csamCheck(queryText)) {
    return csamAbort(session, 'query', onCsAbuse);
  }

  session.queries += 1;
  let raw;
  try {
    // The ONLY network path: the sandbox's own transport (Tor-only inside
    // the cell, enforced by the cell's egress policy + the egress guard).
    raw = await session.sandbox.transport(queryText);
  } catch (err) {
    return { ok: false, reason: `sandbox transport failed (fail-closed, no clearnet fallback): ${err.message}` };
  }

  // Normalize to a chunk stream — TEXT ONLY. An async iterable streams; a
  // string is a single chunk through the exact same scan path; anything
  // else (object, Buffer, number) is a non-text result and is refused
  // before a single byte is scanned or assembled.
  let chunks;
  if (raw && typeof raw[Symbol.asyncIterator] === 'function') {
    chunks = raw;
  } else if (typeof raw === 'string') {
    chunks = [raw];
  } else {
    return { ok: false, reason: 'non-text result refused (the dark web read is text only)' };
  }

  let assembled = '';
  let carry = '';
  try {
    for await (const chunk of chunks) {
      // A kill (manual or otherwise) lands between chunks — never finish a
      // stream on a dead session.
      if (session.killed) {
        return { ok: false, reason: 'session killed mid-stream' };
      }
      // Every chunk must be text. A non-string chunk tears the stream down.
      if (typeof chunk !== 'string') {
        audit(session, 'system', 'darkweb-nontext-refused', `session=${session.id} — non-string chunk torn down`);
        return { ok: false, reason: 'non-text chunk refused — stream torn down (the dark web read is text only)' };
      }
      const text = chunk;
      // An encoded binary inside the text is refused like any binary.
      if (BINARY_BLOB.test(carry + text)) {
        audit(session, 'system', 'darkweb-nontext-refused', `session=${session.id} — encoded binary blob torn down`);
        return { ok: false, reason: 'encoded binary payload refused — stream torn down (the dark web read is text only)' };
      }
      // Bounded read: the byte bound trips the same teardown as any abort.
      if (assembled.length + text.length > session.maxStreamBytes) {
        return { ok: false, reason: `stream exceeded the sandbox read bound (${session.maxStreamBytes} bytes) — torn down` };
      }
      // Scan first, assemble second. The window is carry + chunk so a
      // boundary-split pattern still matches whole.
      const window = carry + text;
      if (csamCheck(window)) {
        // Returning out of the for-await tears the iterator down NOW —
        // mid-transfer, not after it. `assembled` is discarded with the
        // session; nothing matched is ever returned or stored.
        return csamAbort(session, 'result-stream', onCsAbuse);
      }
      assembled += text;
      carry = window.slice(-CARRY_CHARS);
    }
  } catch (err) {
    return { ok: false, reason: `sandbox transport failed mid-stream (fail-closed, no clearnet fallback): ${err.message}` };
  }

  session.transcript.push({ q: queryText, at: new Date().toISOString(), chars: assembled.length });
  return { ok: true, result: assembled };
}

function csamAbort(session, where, onCsAbuse) {
  killSession(session, { reason: `csam-auto-abort (${where})` });
  // Log the abort WITHOUT content. Never the matched text.
  audit(session, 'system', 'darkweb-csam-abort', `session=${session.id} where=${where} — content withheld by policy`);
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
