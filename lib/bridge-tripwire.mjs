/**
 * Kingmaker — the Bridge tripwire: what happens when docking fails.
 *
 * When verification fails, the tripwire declares an incident and hands
 * it to the response pipeline. The responders are injected — at the
 * platform level they wire to the uncensored toolkit (forensics,
 * sandboxing, attribution, defense-building). This module never imports
 * them; it declares, records, and routes.
 *
 * Pipeline: trip → forensics (read-only) → sandbox → catalog →
 * attribute → defend → restore. Every step is audited. Nothing here
 * reaches out or modifies the system on its own; the responders do,
 * under the platform's governance.
 *
 * Pure orchestration + injected deps. No I/O, no network.
 */

/** Incident severities. */
export const SEVERITY = {
  RETIRED_CODE: 'low', // stale call sign — likely clock drift, reconnect path
  UNKNOWN_CODE: 'high', // not from this pairing — possible spoof, investigate
  REPEATED_FAILURE: 'critical', // pattern of failures — hostile code suspected
};

/**
 * Declare an incident from a failed docking verification.
 * `history` = recent verification outcomes (for pattern detection).
 */
export function declareIncident({ pairingId, reason, evidence = {}, history = [], deps }) {
  const failures = history.filter((h) => !h.ok).length;
  const severity =
    failures >= 3 ? SEVERITY.REPEATED_FAILURE
    : reason.includes('Unknown') || reason.includes('unknown') ? SEVERITY.UNKNOWN_CODE
    : SEVERITY.RETIRED_CODE;

  const incident = {
    id: `bridge-${deps.now()}`,
    pairingId,
    reason,
    severity,
    evidence,
    failuresInWindow: failures,
    at: deps.now(),
  };
  deps.appendAudit({ type: 'bridge/tripwire', ...incident });

  // Hand off to the response pipeline (injected; platform wires the tools).
  const disposition =
    severity === SEVERITY.RETIRED_CODE
      ? { action: 'reconnect', message: 'Call sign retired — re-run pairing to re-sync.' }
      : { action: 'investigate', message: 'Docking failed — forensics running, do not reinstall yet.' };
  deps.onIncident(incident, disposition);

  return { incident, disposition };
}
