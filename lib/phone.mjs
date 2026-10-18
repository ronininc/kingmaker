// Phone calls to the OWNER (operator 2026-10-08: "add the phone call ability where Kingmaker can call the user's phone
// to provide updates"). Kingmaker rings one number only, the owner's own, saved at setup, through the owner's own
// Twilio account, and speaks a short update (Twilio's neural voice reads it; nothing is recorded, nothing is heard
// back). It never calls anyone else: there is no "call <number>" here, so it can't become an outbound dialer.
//
//   kingmaker phone setup      opens Twilio's console in Chrome; asks (hidden) for the Account SID, Auth Token, the
//                              Twilio number to call from and the owner's own number; stores them in the Keychain
//   kingmaker phone test       rings the owner once ("This is <wake word>. Phone updates are working.")
//   kingmaker call me "<text>" rings the owner and says <text>
//   kingmaker phone off        forgets it all
//   (textOwner)                texts the owner's own number a problem alert from the delegated approvals; same
//                              Twilio account, same single recipient, never a routine approval
//
// Credentials live in the login Keychain (service "Kingmaker Phone"), written through `security -i` on stdin so they
// never appear in a process list, and are sent only to api.twilio.com.
import { runSecurity } from './keychain-seal.mjs';

export const PHONE_SERVICE = 'Kingmaker Phone';
export const PHONE_ACCOUNT = 'twilio';
export const TWILIO_CONSOLE = 'https://console.twilio.com/';
const quote = (s) => `"${String(s).replace(/["\\\n\r]/g, '')}"`;

/** "+1 (602) 555-0100" → "+16025550100"; a 10-digit US number gets +1. Anything else → null. Pure. */
export function e164(value) {
  const digits = String(value ?? '').replace(/[^\d+]/g, '');
  if (/^\+\d{8,15}$/.test(digits)) return digits;
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  return null;
}

/** The saved setup {sid, token, from, to} or null. */
export function readPhone({ run = runSecurity } = {}) {
  const r = run(['find-generic-password', '-s', PHONE_SERVICE, '-a', PHONE_ACCOUNT, '-w']);
  if (r.status !== 0) return null;
  try {
    const j = JSON.parse(Buffer.from(r.stdout.trim(), 'base64').toString('utf8'));
    return j.sid && j.token && j.from && j.to ? j : null;
  } catch { return null; }
}

export function savePhone({ sid, token, from, to }, { run = runSecurity } = {}) {
  if (!/^AC[0-9a-f]{32}$/i.test(String(sid))) throw new Error('That Account SID does not look right (it starts with AC and has 34 characters).');
  if (!/^[0-9a-f]{32}$/i.test(String(token))) throw new Error('That Auth Token does not look right (32 letters and digits).');
  const f = e164(from); const t = e164(to);
  if (!f) throw new Error('The Twilio number does not look like a phone number.');
  if (!t) throw new Error('Your phone number does not look like a phone number.');
  const json = JSON.stringify({ sid, token, from: f, to: t });
  run(['delete-generic-password', '-s', PHONE_SERVICE, '-a', PHONE_ACCOUNT]);
  const r = run(['-i'], `add-generic-password -s ${quote(PHONE_SERVICE)} -a ${quote(PHONE_ACCOUNT)} -l ${quote(PHONE_SERVICE)} -w ${Buffer.from(json).toString('base64')}\n`);
  if (r.status !== 0) throw new Error('Could not save to the Keychain.');
  return { from: f, to: t };
}

export function forgetPhone({ run = runSecurity } = {}) {
  run(['delete-generic-password', '-s', PHONE_SERVICE, '-a', PHONE_ACCOUNT]);
}

/** TwiML that speaks `text` twice-safe and short. Pure. */
export function twiml(text) {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 600)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<Response><Pause length="1"/><Say voice="Polly.Joanna-Neural">${line}</Say><Pause length="1"/><Say voice="Polly.Joanna-Neural">${line}</Say></Response>`;
}

/** Ring the owner and say `text`. Only ever the saved `to` number. → {ok, sid?, error?} */
export async function callOwner(text, { phone = readPhone(), fetchImpl = fetch } = {}) {
  if (!phone) return { ok: false, error: 'Phone calls are not set up (kingmaker phone setup).' };
  const body = new URLSearchParams({ To: phone.to, From: phone.from, Twiml: twiml(text) });
  try {
    const r = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(phone.sid)}/Calls.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${phone.sid}:${phone.token}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(20_000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: j.message ? String(j.message).slice(0, 160) : `Twilio answered ${r.status}` };
    return { ok: true, sid: j.sid };
  } catch (e) { return { ok: false, error: String(e?.message ?? e).slice(0, 160) }; }
}

/**
 * Text the owner `text` (SMS from the Twilio number to the saved `to` number ONLY; there is no other recipient).
 * Used for problem alerts from the delegated approvals (never for a routine approval). → {ok, sid?, error?}
 */
export async function textOwner(text, { phone = readPhone(), fetchImpl = fetch } = {}) {
  if (!phone) return { ok: false, error: 'Phone is not set up (kingmaker phone setup).' };
  const body = new URLSearchParams({ To: phone.to, From: phone.from, Body: String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 600) });
  try {
    const r = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(phone.sid)}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${phone.sid}:${phone.token}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(20_000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: j.message ? String(j.message).slice(0, 160) : `Twilio answered ${r.status}` };
    return { ok: true, sid: j.sid };
  } catch (e) { return { ok: false, error: String(e?.message ?? e).slice(0, 160) }; }
}
