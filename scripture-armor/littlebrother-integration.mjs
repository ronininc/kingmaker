// littlebrother-integration.mjs — Scripture Armor ↔ Little Brother
// integration (ITEM 10, remainder run 2026-11-04).
//
// *** RELEASE CANDIDATE 2026-11-04 *** — this module ships in the
// candidate tree (armor-release-candidate-2026-11-04) as a governed
// part, behind its gate defaults: nothing in the tree imports it yet,
// no transport is injected, and SCRIPTURE_ARMOR_LB_MODULE is unset,
// so every call returns the named not-wired refusal by design. Host
// attach points and wiring steps: INTEGRATION-NOTE-item-09-10.md.
//
// THE CLAIM UNDER TEST: "the Little Brother stack is baked into
// Scripture Armor" (owner report, 2026-11-04). The 2026-11-04 search
// (see item-10-lb-pricing.md for scope/depth) found the Little Brother
// stack itself on the KINGMAKER side only — build home
// ~/workspace/littlebrother/, vendored at
// kingmaker-final-local/stack/littlebrother/, plus a CRM bot seat
// (crm-littlebrother-build/worker/littlebrother-mcp.ts) — and ZERO
// Armor-side integration in any reachable Armor tree. This module is
// the missing piece, built against Little Brother's real governed
// interface:
//
//   createLittleBrother({ mode, transport, tapVerifier, auditPath,
//                         auditLog, spine })
//     → frozen api { mode, methods[], verifyAudit(),
//         usernameLookup, ipLookup, domainLookup, webRecon,
//         emailFormatCheck            (public-source, both builds)
//         phoneLookup, personLookup, breachQuery
//                                     (kingmaker build only, tap-gated) }
//
// GOVERNANCE, inherited — not reinvented:
//   * Armor never calls a Little Brother method except through the
//     factory above, so every call is CSAM-screened and appended to
//     LB's hash-chained audit log by LB itself.
//   * Transport is injected by the host. NO transport = every lookup
//     refuses (LB fails closed); this module adds no network code.
//   * The tap-gated full set is never invoked by Armor: device-scan
//     enrichment uses the public-source methods only. If a future
//     caller asks for a full method, this module refuses in Armor's
//     own voice before LB is even consulted.
//   * Unwired = refused. If the LB factory cannot be loaded (module
//     absent on this install), every call returns a named refusal —
//     Armor's scan verdicts never depend on enrichment, so a missing
//     LB degrades to "no enrichment", never to a failed scan and
//     never to a silent pass.
//
// WHAT IT DOES: Armor's binary/source lanes already surface embedded
// endpoint indicators (scan.mjs 'embedded-endpoint' findings). After a
// scan record exists, enrichScanRecord() extracts domain/IP/URL
// indicators from it and asks LB — through the governed interface —
// for public-source context on each. Enrichment results are APPENDED
// as findings (basis 'littlebrother-enrichment'); the original record
// is not mutated and its digest is untouched.

export const LB_INTEGRATION_VERSION = 'armor-lb-integration/1';

const PUBLIC_METHODS = new Set(['usernameLookup', 'ipLookup', 'domainLookup', 'webRecon', 'emailFormatCheck']);
const FULL_METHODS = new Set(['phoneLookup', 'personLookup', 'breachQuery']);

function refusal(reason) {
  return { ok: false, refused: true, reason };
}

/**
 * createArmorLittleBrother({
 *   lbFactory,     // injected createLittleBrother (tests pass a stub;
 *                  // production passes the real factory — see loadRealFactory)
 *   transport,     // injected LB transport; absent = LB refuses lookups
 *   tapVerifier,   // accepted for interface completeness; Armor never
 *                  // invokes tap-gated methods, so it is never used here
 *   auditPath,     // LB audit log path (LB owns the chain)
 *   lbModulePath,  // explicit path/URL of littlebrother.mjs, or null
 * })
 */
export async function createArmorLittleBrother(opts = {}) {
  let factory = opts.lbFactory ?? null;
  let loadError = null;
  if (!factory && opts.lbModulePath) {
    try {
      const mod = await import(opts.lbModulePath);
      factory = mod.createLittleBrother;
      if (typeof factory !== 'function') throw new Error('module has no createLittleBrother export');
    } catch (e) { loadError = e; }
  }
  if (!factory) {
    const why = loadError ? `little brother module failed to load (${loadError.message})` : 'little brother not wired on this install (no factory injected, no module path configured)';
    return Object.freeze({
      wired: false,
      version: LB_INTEGRATION_VERSION,
      lookup: async () => refusal(`littlebrother-not-wired: ${why}`),
      enrichScanRecord: async (record) => ({ record, enrichment: { wired: false, results: [], note: `enrichment skipped — ${why}` } }),
      verifyAudit: () => ({ ok: false, reason: `littlebrother-not-wired: ${why}` }),
    });
  }

  // mode 'solomon': the public-source set only — Armor's enrichment
  // has no business holding the tap-gated full set in memory at all.
  const lb = await factory({
    mode: 'solomon',
    transport: opts.transport ?? null,
    auditPath: opts.auditPath,
    spine: 'scripture-armor',
  });

  async function lookup(method, input) {
    if (FULL_METHODS.has(method)) {
      return refusal(`armor-lb-policy: '${method}' is a tap-gated full method; Armor enrichment uses public-source methods only and never invokes it`);
    }
    if (!PUBLIC_METHODS.has(method)) {
      return refusal(`armor-lb-policy: unknown little brother method '${method}'`);
    }
    if (typeof lb[method] !== 'function') {
      return refusal(`armor-lb-policy: method '${method}' is absent in this little brother build`);
    }
    return lb[method](input);
  }

  async function enrichScanRecord(record) {
    const indicators = extractIndicators(record);
    const results = [];
    for (const ind of indicators) {
      const res = await lookup(ind.method, ind.value);
      results.push({ ...ind, result: res });
    }
    const extraFindings = results.map((r) => ({
      rule: 'littlebrother-enrichment', severity: 'info', basis: 'littlebrother-enrichment',
      location: `${r.kind}: ${r.value}`,
      detail: r.result?.ok
        ? `Little Brother public-source context for ${r.value} (${r.method}): ${JSON.stringify(r.result.data ?? {}).slice(0, 300)}`
        : `Little Brother enrichment for ${r.value} (${r.method}) returned no context: ${r.result?.reason || 'refused'}`,
    }));
    return {
      record,
      enrichment: { wired: true, results, findings: extraFindings, audit: lb.verifyAudit() },
    };
  }

  return Object.freeze({
    wired: true,
    version: LB_INTEGRATION_VERSION,
    methods: lb.methods,
    lookup,
    enrichScanRecord,
    verifyAudit: () => lb.verifyAudit(),
  });
}

// Indicator extraction: embedded-endpoint findings already carry the
// endpoint text in `detail` ("embedded endpoint string: <value>").
export function extractIndicators(record) {
  const out = [];
  const seen = new Set();
  for (const f of record?.findings || []) {
    if (f.rule !== 'embedded-endpoint') continue;
    const m = String(f.detail || '').match(/(https?:\/\/[^\s]+|\b(?:\d{1,3}\.){3}\d{1,3}\b(?::\d{1,5})?)/);
    if (!m) continue;
    const value = m[1];
    if (seen.has(value)) continue;
    seen.add(value);
    if (/^\d+\.\d+\.\d+\.\d+/.test(value)) out.push({ kind: 'ip', value: value.split(':')[0], method: 'ipLookup' });
    else {
      let host = value;
      try { host = new URL(value).hostname; } catch { /* keep raw */ }
      out.push({ kind: 'domain', value: host, method: 'domainLookup' });
      out.push({ kind: 'url', value, method: 'webRecon' });
    }
  }
  return out.slice(0, 20); // bounded: enrichment never fans out unbounded
}

/**
 * Production factory loader — the ONLY place a path is named, and it
 * is deliberately explicit: a future apply step sets
 * SCRIPTURE_ARMOR_LB_MODULE to the installed LB module path (the
 * Kingmaker payload's lib/stack-littlebrother/littlebrother.mjs).
 * No path is guessed and no search is performed at runtime.
 */
export function lbModulePathFromEnv(env = process.env) {
  return env.SCRIPTURE_ARMOR_LB_MODULE || null;
}
