// THE iPHONE BRIDGE'S OUTBOUND GATE (operator 2026-10-13 build order: "Outbound to known contacts: allowed.
// Outbound to strangers: prohibited." — "If I'm following them it means I know them.").
//
// Every iMessage, SMS and call the bridge makes passes decideOutbound() first, in this order, and any failure is a
// refusal with a plain reason (fail closed):
//   1. the request is well formed (an action, a recipient, a message for messages);
//   2. the message does not carry a password, a one-time code or card details (those stay the owner's to type);
//   3. the recipient is ONE card in the Mac's Contacts, and the number/email asked for is really on that card
//      (no card: refused as a stranger; a name that matches several cards or a card with several numbers: refused
//      as ambiguous, say which);
//   4. the CRM's do-not-call list (a local snapshot of ronininc worker/dnc.ts's do_not_call table, see
//      iphone-dnc.mjs) clears the number and every other number on that card; no snapshot, a stale or truncated
//      one, or an unreadable number: refused;
//   5. then it NEEDS THE OWNER'S CONFIRMATION (Touch ID or their login password, per action) unless they trusted
//      that contact for that channel (`kingmaker iphone trust`, which also takes their Touch ID). Nothing an agent
//      can call relaxes this.
// Follow lists: no iPhone app exposes one locally without a paid/cloud API, so Contacts is the proof of
// relationship today. Inbound (reading what arrived) is never gated here.
//
// Pure: lookups, the DNC check and the policy are passed in, so the tests run with no Mac permissions.
import { e164 } from './phone.mjs';

export const ACTIONS = Object.freeze(['imessage', 'sms', 'call']);
export const MAX_MESSAGE = 2000;
const ACTION_WORDS = { imessage: 'send an iMessage to', sms: 'send a text (SMS) to', call: 'call' };

/** "+1 (602) 555-0100" → phone, "a@b.co" → email, anything else → a name. null for empty. Pure. */
export function classifyHandle(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return { kind: 'email', value: s.toLowerCase() };
  if (/^[+\d()\-.\s]{7,}$/.test(s)) {
    const n = e164(s);
    return n ? { kind: 'phone', value: n } : { kind: 'unparseable', value: s };
  }
  return { kind: 'name', value: s };
}

const luhn = (digits) => {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
};

/** Does this text carry a secret the owner must type themself? → a reason, or null. Pure. */
export function secretInText(text) {
  const s = String(text ?? '');
  if (/\b(pass(word|code|phrase)|pin|2fa|otp|one[-\s]?time|verification|security|auth(entication)?|login)\b[^\n]{0,24}?[:=\s]\s*\S*\d{3,}/i.test(s)) return 'it looks like a password or one-time code';
  if (/\b(password|passcode)\s*(is|:|=)\s*\S+/i.test(s)) return 'it looks like a password';
  for (const m of s.matchAll(/(?:\d[\s-]?){13,19}/g)) { const d = m[0].replace(/\D/g, ''); if (d.length >= 13 && d.length <= 19 && luhn(d)) return 'it looks like a card number'; }
  if (/\b(cvv|cvc|security code)\b\s*[:=]?\s*\d{3,4}\b/i.test(s)) return 'it looks like card security details';
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(s)) return 'it looks like a Social Security number';
  return null;
}

/**
 * The screen guard for raw input (tap/type/key). `texts` are the words on the phone's screen (OCR).
 *   'secret'  — a password, passcode, verification code or payment screen: stop, hand it to the owner
 *   'compose' — what looks like a message box in a messaging app: typing or sending here needs their confirmation
 *   'ok'
 * A heuristic, not a guarantee: the guaranteed path for outbound is decideOutbound(). Pure.
 */
export function classifyScreen(texts) {
  const words = (texts ?? []).map((t) => String(t ?? '').trim()).filter(Boolean);
  const all = words.join('\n');
  if (/\b(password|passcode|verification code|security code|one[-\s]?time (pass)?code|two[-\s]?factor|card number|cvv|cvc|expir(y|ation) date|apple pay|enter (your )?(apple account|apple id) password|enter code)\b/i.test(all)) return 'secret';
  if (words.some((w) => /^(i?message|text message(\s*[•·]\s*sms)?|send( message)?|message\.\.\.|add a comment|write a (message|reply)|reply|new message|to:)$/i.test(w))) return 'compose';
  if (words.some((w) => /^(i?message|text message|type a message|message…|write a message)\b/i.test(w))) return 'compose';
  return 'ok';
}

/**
 * Contacts lookup over every card (the Contacts.app fallback reads them all at once): a phone or email must be ON a
 * card; a name matches a full name exactly, else every word of it starts a word of the card's name. Pure.
 */
export function matchContacts(cards, query) {
  const q = classifyHandle(query);
  if (!q || q.kind === 'unparseable') return [];
  const all = (cards ?? []).filter((c) => c && c.id);
  if (q.kind === 'phone') return all.filter((c) => (c.phones ?? []).some((p) => e164(p) === q.value));
  if (q.kind === 'email') return all.filter((c) => (c.emails ?? []).some((e) => String(e).toLowerCase() === q.value));
  const want = q.value.toLowerCase().split(/\s+/);
  const exact = all.filter((c) => String(c.name ?? '').toLowerCase().trim() === want.join(' '));
  if (exact.length) return exact;
  return all.filter((c) => { const words = String(c.name ?? '').toLowerCase().split(/\s+/); return want.every((w) => words.some((n) => n.startsWith(w))); });
}

/** The trusted list from the owner's policy, defensively. Pure. */
export function trustedFor(policy, contactId, action) {
  const list = Array.isArray(policy?.trusted) ? policy.trusted : [];
  return list.some((t) => t && t.contactId === contactId && Array.isArray(t.channels) && t.channels.includes(action));
}

const quoteShort = (s, n = 140) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/**
 * Pure. request = {action, to, text?}; ctx = {contacts: [{id,name,phones[],emails[]}] (the Contacts lookup of `to`),
 * dnc: {ok, reason?, check(e164) → {callable, reason}}, policy}.
 * → {allowed:false, refusal} | {allowed:true, needsConfirm, contact:{id,name}, handle, readBack}
 */
export function decideOutbound(request, ctx = {}) {
  const refuse = (refusal, code) => ({ allowed: false, refusal, code });
  const action = String(request?.action ?? '');
  if (!ACTIONS.includes(action)) return refuse(`Unknown action "${action}". I can only ${ACTIONS.join(', ')}.`, 'bad-request');
  const asked = classifyHandle(request?.to);
  if (!asked) return refuse('Who to? A name in Contacts, or their number or email.', 'bad-request');
  if (asked.kind === 'unparseable') return refuse(`"${asked.value}" is not a phone number I can read, so I will not contact it.`, 'bad-request');
  if (action === 'call' && asked.kind === 'email') return refuse('A phone call needs a phone number, not an email.', 'bad-request');
  let text = null;
  if (action !== 'call') {
    text = String(request?.text ?? '');
    if (!text.trim()) return refuse('The message is empty.', 'bad-request');
    if (text.length > MAX_MESSAGE) return refuse(`The message is ${text.length} characters; ${MAX_MESSAGE} is the most I send.`, 'bad-request');
    const secret = secretInText(text);
    if (secret) return refuse(`I will not send that: ${secret}. Passwords, codes and payment details are yours to type.`, 'secret');
  }

  // 3. one known contact, and the handle really on that card
  const cards = Array.isArray(ctx.contacts) ? ctx.contacts.filter((c) => c && c.id) : [];
  if (cards.length === 0) return refuse(`Refused: ${asked.value} is not in your Contacts. I only ${action === 'call' ? 'call' : 'message'} people you know; add them to Contacts first if you know them.`, 'unknown-recipient');
  const phonesOf = (c) => (c.phones ?? []).map((p) => ({ raw: p, e164: e164(p) }));
  let card; let handle;
  if (asked.kind === 'name') {
    if (cards.length > 1) return refuse(`Refused: "${asked.value}" matches ${cards.length} contacts (${cards.slice(0, 5).map((c) => c.name).join(', ')}). Say which, or use their number.`, 'ambiguous');
    card = cards[0];
    const phones = phonesOf(card).filter((p) => p.e164);
    const emails = (card.emails ?? []).map((e) => String(e).toLowerCase());
    if (phones.length === 1) handle = { kind: 'phone', value: phones[0].e164 };
    else if (phones.length > 1) return refuse(`Refused: ${card.name} has ${phones.length} numbers. Say which number.`, 'ambiguous');
    else if (action === 'imessage' && emails.length === 1) handle = { kind: 'email', value: emails[0] };
    else return refuse(`Refused: ${card.name} has no ${action === 'imessage' ? 'single number or email' : 'phone number'} I can use.`, 'ambiguous');
  } else {
    const onCard = (c) => (asked.kind === 'phone'
      ? phonesOf(c).some((p) => p.e164 === asked.value)
      : (c.emails ?? []).some((e) => String(e).toLowerCase() === asked.value));
    const matches = cards.filter(onCard);
    if (matches.length === 0) return refuse(`Refused: ${asked.value} is not in your Contacts. I only ${action === 'call' ? 'call' : 'message'} people you know.`, 'unknown-recipient');
    if (matches.length > 1) return refuse(`Refused: ${asked.value} is on ${matches.length} contact cards. Merge them or say which.`, 'ambiguous');
    card = matches[0]; handle = asked;
  }
  if (action !== 'imessage' && handle.kind !== 'phone') return refuse(`${ACTION_WORDS[action]} needs a phone number.`, 'bad-request');

  // 4. the CRM's do-not-call list, fail closed
  const dnc = ctx.dnc;
  if (!dnc || dnc.ok !== true || typeof dnc.check !== 'function') return refuse(`Refused: the do-not-call list is not available here (${dnc?.reason ?? 'no snapshot'}), so I contact no one. the owner runs: kingmaker iphone dnc sync`, 'dnc-unavailable');
  const numbers = new Set(phonesOf(card).map((p) => p.e164).filter(Boolean));
  if (handle.kind === 'phone') numbers.add(handle.value);
  for (const n of numbers) {
    let r;
    try { r = dnc.check(n); } catch { r = { callable: false, reason: 'the do-not-call check failed' }; }
    if (!r || r.callable !== true) return refuse(`Refused: ${card.name} (${n}) is on the do-not-call list${r?.reason ? ` (${r.reason})` : ''}.`, 'dnc');
  }

  // 5. The owner's confirmation unless they trusted this contact for this channel themself
  const needsConfirm = !trustedFor(ctx.policy, card.id, action);
  const who = `${card.name} (${handle.value})`;
  const readBack = action === 'call' ? `Call ${who} from your iPhone.` : `${action === 'sms' ? 'Text (SMS)' : 'iMessage'} ${who}: "${quoteShort(text)}"`;
  return { allowed: true, needsConfirm, contact: { id: card.id, name: card.name }, handle, action, text, readBack };
}
