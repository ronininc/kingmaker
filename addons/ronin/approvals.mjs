// THE DELEGATED APPROVALS, as Kingmaker's console and voice see them. The loop itself runs in Solomon's core
// (solomon/server/src/runtime/kingmaker-approver.ts): it approves only what the CRM delegates inside the owner's
// server-enforced caps, and never outreach. Here:
//
//   :approvals on      the owner's own act at this console (a typed line, never a spoken one): turn it on
//   :approvals off     the kill switch, typed
//   :approvals         its state
//   "stop approving" / "pause approvals", said or typed: the kill switch, at once, before anything else hears it
//
// PROBLEMS ONLY: the core's alert stream (a 409, a failed submit, an escalation awaiting the owner, a stale Kronos feed,
// a refused token, the loop stopping) is printed, said aloud when Kingmaker is awake, and texted to the owner's own
// number through the Twilio setup in phone.mjs when it is set up. A routine approval is never on that stream.
import { textOwner } from './core.mjs';

export const APPROVER_ROUTE = '/api/kingmaker-approver';

/** Mirrors the core's STOP_APPROVING (engine-wiring test keeps them equivalent). */
export { STOP_APPROVING, isStopApproving } from './core.mjs';

/** Pure: `:approvals [on|off|status]` → 'on' | 'off' | 'status', or null when the line is something else. */
export function approvalsCommand(line) {
  const m = /^:approvals?(?:\s+(on|off|pause|stop|status))?\s*$/i.exec(String(line ?? '').trim());
  if (!m) return null;
  const w = (m[1] ?? 'status').toLowerCase();
  return w === 'on' ? 'on' : w === 'status' ? 'status' : 'off';
}

const CENTS = (c) => (Number.isFinite(c) ? `$${(c / 100).toFixed(2)}` : '?');
/** Pure: the core's /status → one line. */
export function statusLine(s) {
  if (!s || typeof s !== 'object') return 'Approvals: the core did not answer.';
  const seats = `seats: approver ${s.seats?.approver ? '✓' : '✗'}, Seeker ${s.seats?.seeker ? (s.docked ? '✓ docked' : '✓') : '✗'}, local ${s.seats?.local ? '✓' : '✗'}`;
  const why = {
    running: `on (a pass every ${Math.round((s.intervalMs ?? 0) / 60_000)} min, local ceiling ${CENTS(s.localCeilingCents)}, at most ${s.maxPerTick} a pass)`,
    'no-token': 'off: no CRM key for approvals yet (:key ronin-crm with the master key covers them once the CRM has #346; or :key ronin-approver)',
    'never-enabled': 'off: not turned on yet (:approvals on)',
    paused: `paused${s.pausedVia ? ` (${s.pausedVia})` : ''}: :approvals on to resume`,
    halted: `stopped on its own (${s.halted}): fix it, then :approvals on`,
  }[s.state] ?? String(s.state);
  return `Approvals ${why}; ${seats}${s.kronosStale ? '; Kronos forecasts are stale' : ''}.`;
}

/**
 * The alert stream → print / speak (awake only) / text (when phone is set up). Each alert id is handled once;
 * the connect snapshot's alerts from before this run are not replayed.
 */
export function createApprovalAlerts({ out = console.log, announce = () => {}, isAwake = () => false, text = textOwner, log = () => {}, armedAtMs = Date.now() } = {}) {
  const seen = new Set();
  return async function onEvent({ type, data } = {}) {
    const list = type === 'approver.alert' ? [data] : type === 'approver.snapshot' && Array.isArray(data?.alerts) ? data.alerts : [];
    for (const a of list) {
      if (!a || typeof a.id !== 'string' || typeof a.line !== 'string' || seen.has(a.id)) continue;
      seen.add(a.id);
      const at = Date.parse(String(a.at ?? ''));
      if (type === 'approver.snapshot' && Number.isFinite(at) && at < armedAtMs - 1_000) continue;
      const line = a.line.replace(/\s+/g, ' ').trim().slice(0, 400);
      out(`  ⚠ ${line}`);
      if (isAwake()) announce(line);
      const sent = await Promise.resolve(text(`Kingmaker: ${line}`)).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
      log('approver_alert', { kind: String(a.kind ?? '').slice(0, 30), spoken: isAwake(), texted: Boolean(sent?.ok) });
    }
  };
}
