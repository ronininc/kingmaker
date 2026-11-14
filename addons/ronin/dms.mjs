// THE INBOUND DM BRIDGE, as Kingmaker's console and voice see it. The bridge itself runs in Solomon's core
// (solomon/server/src/runtime/crm-dm-bridge.ts): every new inbound iMessage / SMS / WhatsApp / Instagram DM the comms
// watchers see is forwarded to the owner's CRM once, tagged 'prospect' or 'likely_personal'. It never sends a reply:
// the watchers' ack drafts wait for "send the acks". Here:
//
//   :dms on      the owner's own act at this console (typed, never spoken): turn forwarding on / clear its pause
//   :dms off     pause it, typed
//   :dms         its state
//   "stop forwarding" / "pause forwarding", said or typed: pause at once, before anything else hears it
//
// "brief me" / "what came in" is a Solomon turn (the status brief): new DMs by channel. A forward that keeps failing
// arrives on the approvals' problems-only alert stream (printed, said when awake, texted).
// Business only instead of everything: SOLOMON_DM_FORWARD_SCOPE=business in lib/profile.mjs.

export const DMS_ROUTE = '/api/kingmaker-approver/dms';

/** Mirrors the core's STOP_FORWARDING (engine-wiring test keeps them equivalent). */
export const STOP_FORWARDING = /^\s*(?:(?:hey|ok|okay)\s+\w+[,\s]+)?(?:please\s+)?(?:(?:stop|pause|halt|disable|suspend)\s+(?:the\s+)?(?:(?:dm|message|messages|inbox)\s+)?forwarding(?:\s+(?:my\s+|the\s+)?(?:dms|messages|texts))?(?:\s+to\s+the\s+crm)?|(?:stop|pause)\s+(?:sending|forwarding)\s+(?:my\s+|the\s+)?(?:dms|messages|texts)\s+to\s+the\s+crm|turn\s+off\s+(?:dm\s+|message\s+)?forwarding)(?:\s+(?:now|right\s+now))?(?:\s+please)?[.!]*\s*$/i;
export const isStopForwarding = (text) => STOP_FORWARDING.test(String(text ?? ''));

/** Pure: `:dms [on|off|status]` → 'on' | 'off' | 'status', or null when the line is something else. */
export function dmsCommand(line) {
  const m = /^:dms?(?:\s+(on|off|pause|stop|status))?\s*$/i.exec(String(line ?? '').trim());
  if (!m) return null;
  const w = (m[1] ?? 'status').toLowerCase();
  return w === 'on' ? 'on' : w === 'status' ? 'status' : 'off';
}

/** Pure: the core's /dms/status → one line. */
export function dmsStatusLine(s) {
  if (!s || typeof s !== 'object') return 'DM forwarding: the core did not answer.';
  const scope = s.scope === 'business' ? 'business only (prospects)' : 'everything, tagged';
  const why = {
    running: `on: forwarding ${scope} to the CRM`,
    'never-enabled': 'off: not turned on yet (:dms on)',
    paused: `paused${s.pausedVia ? ` (${s.pausedVia})` : ''}: :dms on to resume`,
    'no-crm': 'on, but no CRM is connected (:key ronin-crm)',
  }[s.state] ?? String(s.state);
  return `DM forwarding: ${why}. Replies are never sent; they stay drafts.`;
}
