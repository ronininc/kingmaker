/**
 * check-if-email-exists/lib/verify-gate.mjs (kingmaker-stack)
 *
 * The governed gate for check-if-email-exists (reacherhq, MIT) in the
 * outreach lane: Robbie's drafted investor/CRM lists get verified
 * BEFORE a send batch, so bounces never burn the domain. The tool is
 * absorbed as a library/CLI behind this gate — never as an ambient
 * capability — because of what verification actually does (verified
 * from core/src, HEAD 5fba96e):
 *
 *   - SMTP conversation with the target domain's MX + DNS lookups:
 *     the intended traffic, declared per batch.
 *   - Provider account-existence probes for the big webmail domains:
 *     Yahoo's signup validation endpoint (core/src/smtp/yahoo/api.rs),
 *     Gmail's gxlu page (core/src/smtp/gmail.rs), Outlook's
 *     password-recovery flow driven headlessly and an M365 SharePoint
 *     probe (core/src/smtp/outlook/). That is the tool's method, and
 *     it is why a batch needs provenance: we verify lists Robbie owns
 *     (his outreach/CRM lists), never harvested addresses.
 *   - haveibeenpwned.com — ONLY when an API key is configured
 *     (util/input_output.rs: default None). Behind this gate it is an
 *     explicit per-batch opt-in, declared in the batch record.
 *   - Gravatar — off by default upstream; pinned off here.
 *
 * A batch opens only with (a) a named list, (b) a provenance string
 * saying where the list came from, and (c) the founder tap. One tap
 * opens one batch with a hard allowance; the batch then verifies
 * without per-item prompts (the comms law shape). Every check's probe
 * methods are recorded in the audit chain and the batch record —
 * nothing about a verification is ambient or unlogged.
 *
 * The upstream HTTP backend ships NO auth layer; it is safe only
 * because its default bind is loopback (backend/src/config.rs:
 * 127.0.0.1:8080). buildBackendConfig pins that: a non-loopback host
 * refuses, and the Sentry DSN is pinned empty (upstream's Sentry is a
 * cargo feature + DSN — governed builds carry neither).
 */

import { refused, createTapGate, createEgressGuard } from '../../lib/governance.mjs';

export const CIE_PIN = Object.freeze({
  repo: 'reacherhq/check-if-email-exists',
  commit: '5fba96e451e987abd7a03ef89dd30df3cc9a0a18',
  commitDate: '2026-10-16',
  license: 'MIT',
});

/** Probe methods a verification can use — recorded per check, never hidden. */
export const PROBE_METHODS = Object.freeze(['syntax', 'dns-mx', 'smtp', 'provider-probe', 'hibp', 'gravatar']);

export const HIBP_HOST = 'haveibeenpwned.com';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * The HTTP backend's governed config. Loopback is a pin, not a
 * default: any other host refuses. Sentry is pinned OFF — a DSN in
 * caller config refuses rather than being silently dropped, so the
 * attempt is visible.
 */
export function buildBackendConfig({ host = '127.0.0.1', port = 8080, sentryDsn = null } = {}) {
  if (!LOOPBACK_HOSTS.has(String(host))) {
    return refused(`backend config: host '${host}' refused — the backend has no auth layer and is loopback-pinned`);
  }
  if (sentryDsn) {
    return refused('backend config: a Sentry DSN was supplied — telemetry is pinned off in the governed build');
  }
  return {
    ok: true,
    config: Object.freeze({
      host: '127.0.0.1',
      port: Number(port) || 8080,
      sentryDsn: null,
      gravatar: false,
      env: Object.freeze({ CHECK_GRAVATAR: 'false' }),
    }),
  };
}

/**
 * Open a verification batch. Founder-tap-gated; provenance is a
 * required field of the record, not a courtesy. hibp is opt-in per
 * batch and requires the key's PRESENCE flag (never the key itself).
 */
export async function openBatch({ listId, provenance, allowance, hibp = false, hibpKeyPresent = false, tapToken, verifyTap, auditLog } = {}) {
  const log = (action, detail, meta = {}) => { if (auditLog) auditLog.append({ actor: 'cie-verify-gate', action, detail, meta }); };
  if (!listId || typeof listId !== 'string') {
    const r = refused('verify batch: listId is required — batches are named, never anonymous');
    log('batch.refused', r.reason);
    return r;
  }
  if (!provenance || typeof provenance !== 'string' || provenance.trim().length < 8) {
    const r = refused('verify batch: provenance is required — state where this list came from (owned outreach/CRM lists only)');
    log('batch.refused', r.reason, { listId });
    return r;
  }
  if (!Number.isInteger(allowance) || allowance <= 0) {
    const r = refused('verify batch: a positive integer allowance is required — one tap opens one bounded batch');
    log('batch.refused', r.reason, { listId });
    return r;
  }
  if (hibp && !hibpKeyPresent) {
    const r = refused('verify batch: hibp opt-in declared but no API key present — refusing a batch that would silently skip it');
    log('batch.refused', r.reason, { listId });
    return r;
  }
  const gate = createTapGate(verifyTap);
  const blocked = await gate(tapToken);
  if (blocked) {
    log('batch.refused', blocked.reason, { listId });
    return blocked;
  }
  const batch = {
    id: listId,
    provenance: provenance.trim(),
    allowance,
    used: 0,
    open: true,
    hibp: Boolean(hibp),
    egressHosts: Object.freeze(hibp ? [HIBP_HOST] : []),
    records: [],
  };
  log('batch.opened', `list=${listId} allowance=${allowance} hibp=${batch.hibp}`, { listId, allowance });
  return { ok: true, batch };
}

/**
 * Verify one address inside an open batch. The transport is injected
 * (tests use fakes; live wiring is a Cage-intake act). The transport
 * result must declare the probe methods it used — an undeclared
 * method refuses the record, so nothing probes off the books.
 */
export async function verifyAddress(batch, email, { transport, auditLog } = {}) {
  const log = (action, detail, meta = {}) => { if (auditLog) auditLog.append({ actor: 'cie-verify-gate', action, detail, meta }); };
  if (!batch || batch.open !== true) {
    const r = refused('verify: no open batch — open a batch with a tap first');
    log('verify.refused', r.reason);
    return r;
  }
  if (batch.used >= batch.allowance) {
    batch.open = false;
    const r = refused(`verify: batch '${batch.id}' allowance exhausted (${batch.allowance}) — a new tap opens a new batch`);
    log('verify.refused', r.reason, { listId: batch.id });
    return r;
  }
  if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    const r = refused('verify: malformed address refused before any network shape is considered');
    log('verify.refused', r.reason, { listId: batch.id });
    return r;
  }
  if (typeof transport !== 'function') {
    const r = refused('verify: no transport wired — the gate never reaches the network itself');
    log('verify.refused', r.reason, { listId: batch.id });
    return r;
  }
  // HIBP egress, when the batch opted in, must clear the guard first.
  const result = await transport(email, { hibp: batch.hibp });
  const methods = Array.isArray(result?.methods) ? result.methods : [];
  for (const m of methods) {
    if (!PROBE_METHODS.includes(m)) {
      const r = refused(`verify: transport used undeclared probe method '${m}' — record refused, batch untouched`);
      log('verify.refused', r.reason, { listId: batch.id });
      return r;
    }
  }
  if (methods.includes('hibp') && !batch.hibp) {
    const r = refused('verify: transport used HIBP in a batch that did not opt in — record refused');
    log('verify.refused', r.reason, { listId: batch.id });
    return r;
  }
  if (methods.includes('gravatar')) {
    const r = refused('verify: gravatar probing is pinned off in the governed build — record refused');
    log('verify.refused', r.reason, { listId: batch.id });
    return r;
  }
  batch.used += 1;
  const record = Object.freeze({
    email,
    verdict: result?.verdict ?? 'unknown',
    methods: Object.freeze([...methods]),
  });
  batch.records.push(record);
  log('verify.checked', `verdict=${record.verdict} methods=${methods.join(',')}`, { listId: batch.id });
  return { ok: true, record, remaining: batch.allowance - batch.used };
}

/** HIBP URL pre-flight for batches that opted in; refused for all others. */
export function checkHibpEgress(batch, rawUrl, auditLog = null) {
  const guard = createEgressGuard({ allow: batch?.egressHosts ?? [], auditLog, actor: 'cie-verify-gate' });
  return guard.check(rawUrl);
}

export function closeBatch(batch, auditLog = null) {
  if (batch) batch.open = false;
  if (auditLog) auditLog.append({ actor: 'cie-verify-gate', action: 'batch.closed', detail: `list=${batch?.id} used=${batch?.used}`, meta: { listId: batch?.id } });
  return { ok: true };
}
