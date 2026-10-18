// lib/follow-up.mjs — a short reply right after a written answer is about that answer. The write lane's local model sees
// one message at a time, so "Draft a message asking for screen recording access" → the draft, then "yes you may" → "The
// owner of my Mac is Apple Inc." (owner, 2026-10-15). Two fixes, both pure:
//   1. A yes / no / "make it shorter" within a few minutes of a written answer goes to the writer WITH that exchange.
//   2. A yes aimed at a macOS permission ("yes you may" after "could you allow me to record the screen?") is not a chat
//      question: Kingmaker can't grant macOS permissions. Only the owner can, in System Settings, so it says that and
//      names the pane.

export const FOLLOW_UP_MS = 10 * 60_000;

const SHORT_REPLY = /^(?:yes|yeah|yep|yup|sure|ok(?:ay)?|no|nope|nah|you may|go ahead|do it|send it|that'?s? (?:good|fine|perfect|great)|perfect|great|thanks?|thank you|again|another|more|shorter|longer|simpler|make it\b|change it\b|use (?:that|this|it)\b|the (?:first|second|third|last|other) one|(?:a )?(?:bit|little) (?:more|less|shorter|longer))\b/i;

/** Pure: a short reply that only makes sense next to the answer before it. */
export function isShortFollowUp(text) {
  const t = String(text ?? '').trim();
  if (!t || t.split(/\s+/).length > 10) return false;
  return SHORT_REPLY.test(t);
}

// An edit to the last written answer: never a yes, no, ok or go ahead, which may be approving something waiting.
const EDIT_REPLY = /^(?:please\s+)?(?:again|another|more|shorter|longer|simpler|funnier|warmer|make it\b|change it\b|rewrite it\b|redo it\b|use (?:that|this|it)\b|the (?:first|second|third|last|other) one|(?:a )?(?:bit|little) (?:more|less|shorter|longer))/i;
/** Pure: a short reply that edits the last written answer ("make it shorter", "the second one"); never a yes/no. */
export function isEditFollowUp(text) { const t = String(text ?? '').trim(); return Boolean(t) && t.split(/\s+/).length <= 10 && EDIT_REPLY.test(t); }

/** Pure: the writer's prompt for a follow-up, carrying the last written exchange; anything else is left as it was. */
export function withFollowUp(framed, text, last, now = Date.now(), windowMs = FOLLOW_UP_MS) {
  if (!last?.asked || !last?.answer || now - (last.at ?? 0) > windowMs || !isShortFollowUp(text)) return framed;
  const clip = (v, n) => String(v).replace(/\s+/g, ' ').trim().slice(0, n);
  return `Your last exchange with the owner:\nThe owner asked: "${clip(last.asked, 1200)}"\nYou answered: "${clip(last.answer, 2400)}"\n\nThe owner now replies: "${clip(text, 400)}"\nAnswer that reply in the light of the exchange above.\n\n${framed}`;
}

// The macOS permissions Kingmaker asks for, with their System Settings panes (x-apple.systempreferences anchors).
const PERMISSIONS = [
  { re: /\bscreen (?:recording|capture)|\brecord (?:the |your |my )?screen|\bscreen and system audio\b/i, name: 'Screen & System Audio Recording', pane: 'Privacy_ScreenCapture' },
  { re: /\bmicrophone\b|\bthe mic\b|\bhear you\b/i, name: 'Microphone', pane: 'Privacy_Microphone' },
  { re: /\baccessibility\b|\bcontrol (?:the|your|my) (?:mac|computer)\b/i, name: 'Accessibility', pane: 'Privacy_Accessibility' },
  { re: /\bcamera\b/i, name: 'Camera', pane: 'Privacy_Camera' },
  { re: /\bcontacts\b/i, name: 'Contacts', pane: 'Privacy_Contacts' },
  { re: /\bfull disk access\b/i, name: 'Full Disk Access', pane: 'Privacy_AllFiles' },
  { re: /\bautomation\b/i, name: 'Automation', pane: 'Privacy_Automation' },
];
const ASKS_ACCESS = /\b(?:allow|permission|access|grant|let me)\b/i;
const GRANT = /^(?:yes|yeah|yep|sure|ok(?:ay)?|of course|go ahead|granted|allowed|approved)\b|\b(?:you may|you can|i allow|i grant|i approve|permission (?:is )?granted|you have (?:my )?permission|allow(?:ed)? it)\b/i;

/** Pure: the owner's "yes" to a macOS permission (named in their words, or in Kingmaker's last line) → what to say and
 *  the pane to show; null for anything else. */
export function permissionGrantReply(text, lastSaid = '') {
  const t = String(text ?? '').trim();
  if (!t || t.split(/\s+/).length > 14 || !GRANT.test(t)) return null;
  // Named in the owner's words, or in Kingmaker's last line when that line asked for access ("could you allow me to record
  // the screen?"). A "yes" to any other question (one that only mentions a camera) still goes to Kingmaker.
  const said = String(lastSaid ?? '');
  const p = PERMISSIONS.find((x) => x.re.test(t)) ?? (ASKS_ACCESS.test(said) ? PERMISSIONS.find((x) => x.re.test(said)) : undefined);
  if (!p) return null;
  return {
    pane: p.pane,
    line: `I can't grant macOS permissions myself; only you can, in System Settings. I've opened Privacy & Security → ${p.name}: turn Kingmaker on there.`,
  };
}
