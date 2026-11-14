// addons/ronin/text-watch.mjs — the unanswered-text watch. Robbie (2026-10-17): when a text from a client he watches
// (Brent first) has waited an hour with no reply from him, the CRM phones him to say it is waiting.
//
//   READS    the Messages database (chat.db) READ-ONLY, the same way the DM bridge's iMessage/SMS watcher does
//            (sqlite3 -readonly, mode=ro). It also reads Robbie's own sent messages (is_from_me = 1, which the inbound
//            watcher skips), because a reply from him, from any of his devices, is what ends the wait.
//   WAITING  a text from a watched contact (iMessage or SMS) that came in after the watch was turned on, after Robbie's
//            last message in any chat with that contact, and is at least `afterMinutes` old (default 60). Tapbacks and
//            group events are not texts.
//   FLAG     one alert to the CRM in the ronininc-crm #346 shape: { from_name, contact_id?, received_at (ms), channel }.
//            NEVER the text and never a preview (calls never carry the text). The CRM places the owner call (or an urgent
//            push when owner calls are off) and says its own sentence. Routes, first that works:
//              1. request_owner_call on /mcp/desk with the Kingmaker desk key (Keychain)
//              2. REST POST /api/kingmaker/owner-alert/unanswered-text with the same desk key
//              3. no desk key, or both failed: the engine, which calls owner_alert_unanswered_text on /mcp/solomon with
//                 the :key ronin-crm key (the master key ronin_admin_ or a Solomon token) — the key never leaves the engine
//   ONCE     one flag per unanswered thread: the thread is keyed by the first unanswered text, kept in
//            text-watch-flags.json. A reply from Robbie closes it; a new text after that is a new thread. The CRM also
//            dedupes on contact_id (or name) + received_at, so a retry after a failure or a crash is the same alert.
//            A flag that keeps failing gives up once, and says so.
//   NEVER    contacts the watched person. This file has no way to send a message: it only runs sqlite3 read-only
//            and raises the owner alert.
//   SWITCH   off until `kingmaker text-watch on`; re-read every check, so `off` stops it at once.

import { execFile as nodeExecFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { callRoninDesk, storedRoninDeskToken } from './ronin-desk-dock.mjs';

export const TEXT_WATCH_FILE = 'text-watch.json';
export const TEXT_WATCH_FLAGS_FILE = 'text-watch-flags.json';
export const DEFAULT_AFTER_MINUTES = 60;
export const DEFAULT_CONTACTS = Object.freeze([Object.freeze({ name: 'Brent', handles: Object.freeze([]), contactId: 'ct_brent_agencyhub' })]);
export const CONTACT_ID_SHAPE = /^[A-Za-z0-9_.:-]{1,80}$/;
export const OWNER_ALERT_REST_PATH = '/api/kingmaker/owner-alert/unanswered-text';
export const ENGINE_ALERT_ROUTE = '/api/kingmaker-approver/owner-alert/unanswered-text';
const RONIN_CRM = 'https://www.ronininc.org';
export const CHECK_INTERVAL_MS = 5 * 60_000;
export const MAX_ATTEMPTS = 12; // an hour of 5-minute checks
const KEEP_FLAGS_MS = 30 * 24 * 3600_000;
const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);
const SEP = '\u241F';

const chatDbUri = (home = homedir()) => `file:${join(home, 'Library', 'Messages', 'chat.db')}?mode=ro`;

/** Apple Messages time (ns since 2001, or s on very old databases) ⇄ epoch ms. */
export const appleToMs = (raw) => { const n = Number(raw) || 0; return APPLE_EPOCH_MS + (n > 1e12 ? n / 1e6 : n * 1000); };
export const msToAppleNs = (ms) => Math.max(0, Math.round((Number(ms) - APPLE_EPOCH_MS) * 1e6));

/** A handle in a comparable form: a phone by its last 10 digits, an email lowercased. '' for nothing usable. */
export function normalizeHandle(value) {
  const v = String(value ?? '').trim();
  if (!v) return '';
  if (v.includes('@')) return v.toLowerCase();
  const digits = v.replace(/\D/g, '');
  return digits.length >= 7 ? digits.slice(-10) : '';
}

// ── Config ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const cleanContact = (c) => ({
  name: String(c?.name ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80),
  handles: [...new Set((Array.isArray(c?.handles) ? c.handles : []).map((h) => String(h ?? '').trim()).filter((h) => normalizeHandle(h)))].slice(0, 10),
  ...(typeof c?.contactId === 'string' && CONTACT_ID_SHAPE.test(c.contactId) ? { contactId: c.contactId } : {}),
});

export function readTextWatchConfig(paths) {
  let raw = null;
  try { raw = JSON.parse(readFileSync(join(paths.state, TEXT_WATCH_FILE), 'utf8')); } catch { /* not set up yet */ }
  const ok = raw?.schema === 1;
  const contacts = ok && Array.isArray(raw.contacts) ? raw.contacts.map(cleanContact).filter((c) => c.name) : DEFAULT_CONTACTS.map(cleanContact);
  const after = Number(ok ? raw.afterMinutes : DEFAULT_AFTER_MINUTES);
  return {
    enabled: ok && raw.enabled === true,
    afterMinutes: Number.isFinite(after) && after >= 5 && after <= 24 * 60 ? Math.round(after) : DEFAULT_AFTER_MINUTES,
    since: ok && Number.isFinite(Number(raw.since)) ? Number(raw.since) : null,
    contacts,
  };
}

function writeJson(paths, file, value) {
  mkdirSync(paths.state, { recursive: true, mode: 0o700 });
  const path = join(paths.state, file);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

export function writeTextWatchConfig(paths, config) {
  const c = { ...readTextWatchConfig(paths), ...config };
  writeJson(paths, TEXT_WATCH_FILE, { schema: 1, enabled: c.enabled === true, afterMinutes: c.afterMinutes, since: c.since, contacts: c.contacts.map(cleanContact).filter((x) => x.name) });
  return readTextWatchConfig(paths);
}

/** Turn it on (from now: texts that came in before this are never flagged) or off. */
export function setTextWatchEnabled(paths, enabled, nowMs = Date.now()) {
  const c = readTextWatchConfig(paths);
  return writeTextWatchConfig(paths, { enabled: enabled === true, since: enabled === true ? (c.enabled && c.since ? c.since : nowMs) : c.since });
}

/** Add or update a watched contact. `contactId`: the CRM's contact id (e.g. ct_brent_agencyhub), optional. */
export function addWatchedContact(paths, name, handles = [], { contactId } = {}) {
  const c = readTextWatchConfig(paths);
  const clean = cleanContact({ name, handles });
  if (!clean.name) throw new Error('A name is required.');
  const bad = handles.filter((h) => !normalizeHandle(h));
  if (bad.length) throw new Error(`Not a phone number or email: ${bad.join(', ')}`);
  if (contactId !== undefined && !CONTACT_ID_SHAPE.test(String(contactId))) throw new Error('A CRM contact id is 1-80 letters, digits, or _ . : - (like ct_brent_agencyhub).');
  const rest = c.contacts.filter((x) => x.name.toLowerCase() !== clean.name.toLowerCase());
  const prior = c.contacts.find((x) => x.name.toLowerCase() === clean.name.toLowerCase());
  const id = contactId ?? prior?.contactId;
  return writeTextWatchConfig(paths, { contacts: [...rest, { name: clean.name, handles: [...new Set([...(prior?.handles ?? []), ...clean.handles])], ...(id ? { contactId: id } : {}) }] });
}

export function removeWatchedContact(paths, name) {
  const c = readTextWatchConfig(paths);
  return writeTextWatchConfig(paths, { contacts: c.contacts.filter((x) => x.name.toLowerCase() !== String(name ?? '').trim().toLowerCase()) });
}

// ── Flags (one per unanswered thread) ────────────────────────────────────────────────────────────────────────────────

export function readFlags(paths) {
  try { const v = JSON.parse(readFileSync(join(paths.state, TEXT_WATCH_FLAGS_FILE), 'utf8')); return v?.schema === 1 && v.threads && typeof v.threads === 'object' ? v.threads : {}; } catch { return {}; }
}
function writeFlags(paths, threads, nowMs) {
  const kept = Object.fromEntries(Object.entries(threads).filter(([, t]) => nowMs - Number(t?.at ?? 0) < KEEP_FLAGS_MS));
  writeJson(paths, TEXT_WATCH_FLAGS_FILE, { schema: 1, threads: kept });
}

// ── Reading Messages and Contacts (read-only) ────────────────────────────────────────────────────────────────────────

const runFile = (file, args, opts = {}) => new Promise((resolve) => {
  nodeExecFile(file, args, { encoding: 'utf8', timeout: opts.timeoutMs ?? 10_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
  });
});

/** sqlite3, read-only, one query. The only process this file starts. */
async function sqlite(run, uri, sql) {
  const r = await run('sqlite3', ['-readonly', '-separator', SEP, uri, sql], { timeoutMs: 10_000 });
  if (r.code !== 0) {
    const denied = /denied|authoriz|not permitted|unable to open/i.test(r.stderr);
    throw Object.assign(new Error(denied ? 'macOS blocks Messages/Contacts access: give Kingmaker Full Disk Access (System Settings → Privacy & Security).' : (r.stderr.trim().slice(0, 160) || `sqlite3 exit ${r.code}`)), { denied });
  }
  return r.stdout.split('\n').map((l) => l.replace(/\r$/, '')).filter(Boolean).map((l) => l.split(SEP));
}
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

function addressBookUris(home = homedir(), ls = readdirSync, exists = existsSync) {
  const root = join(home, 'Library', 'Application Support', 'AddressBook');
  const out = [];
  const add = (p) => { if (exists(p)) out.push(`file:${p}?mode=ro`); };
  add(join(root, 'AddressBook-v22.abcddb'));
  try { for (const s of ls(join(root, 'Sources'))) add(join(root, 'Sources', s, 'AddressBook-v22.abcddb')); } catch { /* no sources */ }
  return out;
}

/** A contact's phone numbers and emails from macOS Contacts, by name. Exactly one person must match, or nothing is used. */
export async function handlesFromContacts(name, { run = runFile, uris = addressBookUris() } = {}) {
  const n = String(name ?? '').trim().toLowerCase();
  if (!n) return { handles: [], people: [] };
  const people = new Map();
  for (const uri of uris) {
    let rows = [];
    try {
      rows = await sqlite(run, uri, `SELECT r.Z_PK, COALESCE(r.ZFIRSTNAME,''), COALESCE(r.ZLASTNAME,''),
          (SELECT group_concat(p.ZFULLNUMBER, ',') FROM ZABCDPHONENUMBER p WHERE p.ZOWNER = r.Z_PK),
          (SELECT group_concat(e.ZADDRESS, ',') FROM ZABCDEMAILADDRESS e WHERE e.ZOWNER = r.Z_PK)
        FROM ZABCDRECORD r WHERE lower(trim(COALESCE(r.ZFIRSTNAME,''))) = ${q(n)} OR lower(trim(COALESCE(r.ZFIRSTNAME,'') || ' ' || COALESCE(r.ZLASTNAME,''))) = ${q(n)};`);
    } catch (error) { if (error.denied) throw error; continue; }
    for (const [, first, last, phones, emails] of rows) {
      const full = `${first} ${last}`.trim();
      const p = people.get(full.toLowerCase()) ?? { name: full, handles: new Set() };
      for (const h of `${phones ?? ''},${emails ?? ''}`.split(',')) if (normalizeHandle(h)) p.handles.add(h.trim());
      people.set(full.toLowerCase(), p);
    }
  }
  const list = [...people.values()];
  return { handles: list.length === 1 ? [...list[0].handles] : [], people: list.map((p) => p.name) };
}

/**
 * The first unanswered text from this contact, or null. "Unanswered": it came in after Robbie's last message in any chat
 * with them and after `sinceMs`. Returns { rowId, receivedAtMs, channel }.
 */
/** chat.db's message.service → the CRM's channel: 'iMessage' → imessage; SMS (and RCS, also a carrier text) → sms. */
export const channelOf = (service) => (/^imessage$/i.test(String(service ?? '').trim()) ? 'imessage' : 'sms');
export async function firstUnansweredText(handles, { sinceMs, run = runFile, uri = chatDbUri() } = {}) {
  const want = new Set(handles.map(normalizeHandle).filter(Boolean));
  if (!want.size) return null;
  const all = await sqlite(run, uri, 'SELECT ROWID, id FROM handle;');
  const ids = all.filter(([, id]) => want.has(normalizeHandle(id))).map(([rowid]) => Number(rowid)).filter(Number.isFinite);
  if (!ids.length) return null;
  const inList = ids.join(',');
  const rows = await sqlite(run, uri, `WITH chats AS (SELECT DISTINCT chat_id FROM chat_handle_join WHERE handle_id IN (${inList})),
      lastout AS (SELECT COALESCE(MAX(m.date), 0) AS d FROM message m JOIN chat_message_join j ON j.message_id = m.ROWID
        WHERE j.chat_id IN (SELECT chat_id FROM chats) AND m.is_from_me = 1 AND COALESCE(m.associated_message_type, 0) = 0 AND COALESCE(m.item_type, 0) = 0)
    SELECT m.ROWID, m.date, COALESCE(m.service, '') FROM message m
    WHERE m.handle_id IN (${inList}) AND m.is_from_me = 0 AND COALESCE(m.associated_message_type, 0) = 0 AND COALESCE(m.item_type, 0) = 0
      AND m.date > (SELECT d FROM lastout) AND m.date >= ${msToAppleNs(sinceMs ?? 0)}
    ORDER BY m.date ASC, m.ROWID ASC LIMIT 1;`);
  if (!rows.length) return null;
  const [rowId, date, service] = rows[0];
  return { rowId: Number(rowId), receivedAtMs: appleToMs(date), channel: channelOf(service) };
}

// ── One check ────────────────────────────────────────────────────────────────────────────────────────────────────────

export const threadKey = (name, rowId) => `${String(name).toLowerCase()}:${rowId}`;
const scrub = (v) => String(v ?? '').replace(/ronin_[a-z]+_[0-9a-f]{8,}/gi, '[token]').slice(0, 160);

/** The #346 flag. Exactly these fields: never the text, never a preview, never a handle. */
export function alertPayload(contact, first) {
  return {
    from_name: contact.name,
    ...(contact.contactId ? { contact_id: contact.contactId } : {}),
    received_at: Math.round(first.receivedAtMs),
    channel: first.channel === 'imessage' ? 'imessage' : 'sms',
  };
}

/** The CRM's answer { ok, id, deduplicated, delivery, call_id, push } → what we log and keep. */
const answer = (r, via) => ({
  via,
  id: typeof r?.id === 'string' ? r.id : null,
  deduplicated: r?.deduplicated === true,
  delivery: typeof r?.delivery === 'string' ? r.delivery : null,
  call_id: typeof r?.call_id === 'string' ? r.call_id : null,
  push: r?.push && typeof r.push === 'object' ? r.push : null,
});

async function restAlert({ crm = RONIN_CRM, token, payload, fetchImpl }) {
  const response = await fetchImpl(`${crm}${OWNER_ALERT_REST_PATH}`, {
    method: 'POST', signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload),
  });
  let body = null;
  try { body = await response.json(); } catch { /* not JSON */ }
  if (!response.ok || body?.ok !== true) throw new Error(`owner-alert HTTP ${response.status}${body?.error ? `: ${body.error}` : ''}`);
  return body;
}

/**
 * Deliver one flag. deps: { token (desk key), fetchImpl, engine(payload) → { ok, data|error } }.
 * → the logged answer, or throws with every route's reason.
 */
export async function deliverAlert(payload, { token, fetchImpl = fetch, engine } = {}) {
  const why = [];
  if (token) {
    try { return answer(await callRoninDesk({ token, name: 'request_owner_call', input: payload, fetchImpl }), 'desk'); }
    catch (error) { why.push(`desk: ${scrub(error.message)}`); }
    try { return answer(await restAlert({ token, payload, fetchImpl }), 'rest'); }
    catch (error) { why.push(`rest: ${scrub(error.message)}`); }
  }
  if (engine) {
    try {
      const r = await engine(payload);
      if (r?.ok && r.data?.ok !== false) return answer(r.data, 'engine');
      why.push(`engine: ${r?.error === 'NO_CRM_KEY' ? 'no CRM key (:key ronin-crm)' : scrub(r?.error ?? 'no answer')}`);
    } catch (error) { why.push(`engine: ${scrub(error.message)}`); }
  }
  if (!token && !engine) why.push('no Kingmaker desk key (kingmaker pair) and no CRM key (:key ronin-crm)');
  throw new Error(why.join('; '));
}

/** The engine route through Kingmaker's own owner console (office.mjs builds it with the launch nonce). */
export const engineAlerter = (ownerCall, port, nonce) => async (payload) => {
  const r = await ownerCall(port, ENGINE_ALERT_ROUTE, { nonce, method: 'POST', body: payload, timeoutMs: 20_000 });
  return { ok: r?.ok === true && r.json?.ok === true, data: r?.json?.data ?? null, error: r?.json?.error ?? (r?.ok ? null : `HTTP ${r?.status ?? '?'}`) };
};

/**
 * One pass over every watched contact. deps: { run, fetchImpl, token, engine, now, log, uri, contactsUris }.
 * Returns { flagged: [key], waiting: [key], skipped: [{ name, why }], errors: [string] }.
 */
export async function checkTextWatch(paths, deps = {}) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const out = { flagged: [], waiting: [], skipped: [], errors: [] };
  const config = readTextWatchConfig(paths);
  if (!config.enabled) return out;
  const token = 'token' in deps ? deps.token : storedRoninDeskToken(process.env);
  const engine = deps.engine ?? null;
  const threads = readFlags(paths);
  const nowMs = now();
  let dirty = false;
  for (const contact of config.contacts) {
    let handles = contact.handles;
    if (!handles.length) {
      try {
        const found = await handlesFromContacts(contact.name, { run: deps.run ?? runFile, uris: deps.contactsUris ?? addressBookUris() });
        handles = found.handles;
        if (!handles.length) { out.skipped.push({ name: contact.name, why: found.people.length > 1 ? `${found.people.length} people named ${contact.name} in Contacts (${found.people.join(', ')}); add the number: kingmaker text-watch add ${contact.name} <number>` : `no ${contact.name} with a number in Contacts; add one: kingmaker text-watch add ${contact.name} <number>` }); continue; }
      } catch (error) { out.errors.push(error.message); continue; }
    }
    let first;
    try { first = await firstUnansweredText(handles, { sinceMs: config.since ?? nowMs, run: deps.run ?? runFile, uri: deps.uri ?? chatDbUri() }); }
    catch (error) { out.errors.push(error.message); continue; }
    if (!first) continue;
    const key = threadKey(contact.name, first.rowId);
    if (nowMs - first.receivedAtMs < config.afterMinutes * 60_000) { out.waiting.push(key); continue; }
    const prior = threads[key];
    if (prior && (prior.state === 'flagged' || prior.state === 'gave_up')) continue; // one flag per thread, ever
    if (!token && !engine) { out.skipped.push({ name: contact.name, why: 'no way to reach the CRM: no Kingmaker desk key (kingmaker pair) and Kingmaker is not running with a CRM key (:key ronin-crm)' }); continue; }
    const attempts = Number(prior?.attempts ?? 0) + 1;
    try {
      const r = await deliverAlert(alertPayload(contact, first), { token, engine, fetchImpl: deps.fetchImpl ?? fetch });
      threads[key] = { state: 'flagged', at: nowMs, attempts, via: r.via, id: r.id, call: r.call_id, delivery: r.delivery, deduplicated: r.deduplicated };
      out.flagged.push(key);
      log('text_watch_flagged', { contact: contact.name, ...r });
    } catch (error) {
      const gaveUp = attempts >= MAX_ATTEMPTS;
      threads[key] = { state: gaveUp ? 'gave_up' : 'retry', at: nowMs, attempts, error: scrub(error.message) };
      out.errors.push(`${contact.name}: ${threads[key].error}`);
      log('text_watch_flag_failed', { contact: contact.name, attempts, gaveUp, error: threads[key].error });
      if (gaveUp) console.error(`! Text watch: could not ask the CRM to call you about ${contact.name}'s text (${threads[key].error}). Not trying again for that text.`);
    }
    dirty = true;
  }
  if (dirty) writeFlags(paths, threads, nowMs);
  return out;
}

/** The loop inside a running Kingmaker (office.mjs). Re-reads the switch every check; problems are said once each. */
export async function runTextWatchLoop({ paths, signal, log = () => {}, intervalMs = CHECK_INTERVAL_MS, deps = {} } = {}) {
  const said = new Set();
  const once = (line) => { if (!said.has(line)) { said.add(line); console.error(`! Text watch: ${line}`); } };
  while (!signal?.aborted) {
    try {
      const r = await checkTextWatch(paths, { ...deps, log });
      for (const s of r.skipped) once(`${s.name}: ${s.why}`);
      for (const e of r.errors) once(e);
    } catch (error) { once(error.message); }
    await new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const t = setTimeout(done, intervalMs);
      function done() { clearTimeout(t); signal?.removeEventListener?.('abort', done); resolve(); }
      signal?.addEventListener?.('abort', done, { once: true });
    });
  }
}

// ── `kingmaker text-watch …` ─────────────────────────────────────────────────────────────────────────────────────────

export const TEXT_WATCH_USAGE = 'Usage: kingmaker text-watch status | on | off | add <name> [number or email …] [--contact-id <CRM id>] | remove <name> | after <minutes>';

export async function textWatchCommand(args, { paths }) {
  const [verb = 'status', ...rest] = args;
  const show = (c) => {
    console.log(`Text watch is ${c.enabled ? 'on' : 'off'}. If a text waits ${c.afterMinutes} minutes with no reply from you, the CRM calls you about it (once per text). Nobody you watch is ever contacted.`);
    for (const x of c.contacts) console.log(`  ${x.name}: ${x.handles.length ? x.handles.join(', ') : 'number from Contacts'}${x.contactId ? ` (CRM ${x.contactId})` : ''}`);
    if (!c.contacts.length) console.log('  (nobody watched: kingmaker text-watch add <name>)');
  };
  try {
    if (verb === 'status') { show(readTextWatchConfig(paths)); return 0; }
    if (verb === 'on') { const c = setTextWatchEnabled(paths, true); show(c); console.log('Texts from now on count; older ones are never flagged. Needs Full Disk Access, and the CRM key (:key ronin-crm, the master key) or the Kingmaker desk key (kingmaker pair). The CRM calls you, or sends an urgent push when owner calls are off.'); return 0; }
    if (verb === 'off') { show(setTextWatchEnabled(paths, false)); return 0; }
    if (verb === 'add') {
      const at = rest.findIndex((a) => a === '--contact-id' || a.startsWith('--contact-id='));
      let contactId;
      const words = [...rest];
      if (at >= 0) {
        const flag = words[at];
        contactId = flag.includes('=') ? flag.slice(flag.indexOf('=') + 1) : words[at + 1];
        words.splice(at, flag.includes('=') ? 1 : 2);
        if (!contactId) { console.error(TEXT_WATCH_USAGE); return 2; }
      }
      const [name, ...handles] = words;
      if (!name) { console.error(TEXT_WATCH_USAGE); return 2; }
      show(addWatchedContact(paths, name, handles, contactId === undefined ? {} : { contactId })); return 0;
    }
    if (verb === 'remove') { if (!rest[0]) { console.error(TEXT_WATCH_USAGE); return 2; } show(removeWatchedContact(paths, rest[0])); return 0; }
    if (verb === 'after') {
      const m = Number(rest[0]);
      if (!Number.isFinite(m) || m < 5 || m > 24 * 60) { console.error('Minutes must be 5 to 1440.'); return 2; }
      show(writeTextWatchConfig(paths, { afterMinutes: Math.round(m) })); return 0;
    }
  } catch (error) { console.error(`✗ ${error.message}`); return 1; }
  console.error(TEXT_WATCH_USAGE); return 2;
}
