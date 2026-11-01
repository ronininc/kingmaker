// A DO-NOT-CALL LIST, KEPT LOCAL for the iPhone bridge.
//
// The bridge must make no network calls while it operates, so the list is copied to this Mac by an explicit owner step
// and checked locally:
//   kingmaker iphone dnc import <file>   a saved copy of the list ({entries:[{phone_e164,…}], complete})
//   kingmaker iphone dnc sync            one GET from the CRM that publishes it, with a one-scope reader token the owner
//                                        put in the Keychain (service "Kingmaker iPhone Bridge", account "crm-dnc-token").
//                                        Which CRM, and what its reader tokens look like, comes from an add-on (the Ronin
//                                        add-on knows the Ronin CRM's); with none, sync says so and import still works.
// Fail closed: no snapshot, one older than the max age (24 h by default), or one that may be incomplete (complete:false,
// or a list cut at the 500-row page) means NOTHING is callable.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { e164 } from './phone.mjs';

export const DNC_SCHEMA = 'kingmaker.iphone.dnc/1';
export const DNC_ENDPOINT_LIMIT = 500;
export const DNC_MAX_AGE_MS = 24 * 3600_000;
export const TOKEN_SERVICE = 'Kingmaker iPhone Bridge';
export const TOKEN_ACCOUNT = 'crm-dnc-token';

/** The endpoint's {entries:[{phone_e164,…}]} → a snapshot. Pure. */
export function snapshotFrom(body, { now = Date.now(), source = 'import' } = {}) {
  const entries = Array.isArray(body?.entries) ? body.entries : null;
  if (!entries) throw new Error('That is not the CRM do-not-call list (no entries).');
  const phones = [...new Set(entries.map((e) => e164(e?.phone_e164)).filter(Boolean))].sort();
  // The snapshot endpoint says whether it is complete; the admin list (an import) is cut at 500 rows.
  const truncated = body.complete === false || (body.complete !== true && entries.length >= DNC_ENDPOINT_LIMIT);
  return { schema: DNC_SCHEMA, fetchedAt: new Date(now).toISOString(), source, count: entries.length, truncated, phones };
}

/** A snapshot → {ok, reason?, check(e164)}. Pure. */
export function dncFrom(snap, { now = Date.now(), maxAgeMs = DNC_MAX_AGE_MS } = {}) {
  if (!snap || snap.schema !== DNC_SCHEMA || !Array.isArray(snap.phones)) return { ok: false, reason: 'no do-not-call snapshot' };
  const age = now - Date.parse(snap.fetchedAt);
  if (!Number.isFinite(age) || age < -60_000) return { ok: false, reason: 'the do-not-call snapshot has a bad date' };
  if (age > maxAgeMs) return { ok: false, reason: `the do-not-call snapshot is ${Math.round(age / 3600_000)} h old` };
  if (snap.truncated) return { ok: false, reason: `the CRM's list of ${snap.count} rows may be incomplete` };
  const blocked = new Set(snap.phones);
  return {
    ok: true, fetchedAt: snap.fetchedAt, count: blocked.size,
    check(number) {
      const n = e164(number);
      if (!n) return { callable: false, reason: 'unreadable phone number' };
      return blocked.has(n) ? { callable: false, reason: 'on the CRM do-not-call list' } : { callable: true, reason: 'not on the CRM do-not-call list' };
    },
  };
}

export function readSnapshot(file) {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null; } catch { return null; }
}

export function writeSnapshot(file, snap) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(`${file}.tmp`, `${JSON.stringify(snap, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

export const loadDnc = (file, opts) => dncFrom(readSnapshot(file), opts);

/** The owner's sync: one GET to their own CRM. `token` is never logged or returned. */
export async function syncDnc(file, { token, fetchImpl = fetch, url, tokenPrefix, now = Date.now() } = {}) {
  if (!url || !tokenPrefix) throw new Error('No CRM publishes a do-not-call list to this Mac. Import a saved copy: kingmaker iphone dnc import <file>.');
  if (!token) throw new Error(`No do-not-call reader token in the Keychain (service "${TOKEN_SERVICE}", account ${TOKEN_ACCOUNT}).`);
  // Only the one-scope reader is ever sent: a stronger token (capital, master) must not ride this request.
  if (!String(token).startsWith(tokenPrefix)) {
    const kind = (/^[a-z]+_[a-z]+_/.exec(String(token)) ?? ['an unknown'])[0];
    throw new Error(`The Keychain item holds ${kind === 'an unknown' ? 'an unknown token' : `a ${kind}… token`}, not a do-not-call reader (${tokenPrefix}…); nothing was sent. Replace it: security delete-generic-password -s "${TOKEN_SERVICE}" -a ${TOKEN_ACCOUNT}, then add the reader token.`);
  }
  const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
  if (!res.ok) throw new Error(`The CRM answered ${res.status}; the snapshot was not changed.`);
  const snap = snapshotFrom(await res.json(), { now, source: url });
  writeSnapshot(file, snap);
  return snap;
}
