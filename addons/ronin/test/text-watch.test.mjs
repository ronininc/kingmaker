// The unanswered-text watch (text-watch.mjs): a watched contact's text that waits past the limit with no reply from
// Robbie gets exactly one owner alert in the ronininc-crm #346 shape ({ from_name, contact_id?, received_at, channel },
// never the text or a preview): request_owner_call on /mcp/desk, else the REST route, else the engine with the
// :key ronin-crm (master) key. Nothing ever goes to the contact.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addWatchedContact, alertPayload, appleToMs, channelOf, checkTextWatch, deliverAlert, engineAlerter, msToAppleNs, normalizeHandle, readFlags, readTextWatchConfig,
  removeWatchedContact, setTextWatchEnabled, textWatchCommand, writeTextWatchConfig,
} from '../text-watch.mjs';

const SEP = '\u241F';
const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 19, 17, 0, 0); // Mon 10:00 AM Phoenix
const paths = () => ({ state: mkdtempSync(join(tmpdir(), 'km-text-watch-')) });

/** A tiny Messages database: handles and messages; the runner answers the two queries text-watch.mjs makes. */
function fakeMessages({ handles = [[7, '+16025550100'], [8, 'someone@else.com']], messages = [] } = {}) {
  const calls = [];
  const run = async (file, args) => {
    calls.push({ file, args });
    assert.equal(file, 'sqlite3', 'the only process is sqlite3');
    assert.equal(args[0], '-readonly', 'always read-only');
    const uri = args[3]; const sql = args[4];
    assert.match(uri, /mode=ro$/);
    if (/FROM ZABCDRECORD/.test(sql)) return { code: 0, stdout: '', stderr: '' };
    if (/^SELECT ROWID, id FROM handle;$/.test(sql)) return { code: 0, stdout: handles.map((h) => h.join(SEP)).join('\n'), stderr: '' };
    const ids = (/m\.handle_id IN \(([\d,]+)\)/.exec(sql)?.[1] ?? '').split(',').map(Number);
    const since = Number(/m\.date >= (\d+)/.exec(sql)?.[1] ?? 0);
    const lastOut = Math.max(0, ...messages.filter((m) => m.fromMe && !m.tapback).map((m) => m.date));
    const hit = messages.filter((m) => !m.fromMe && !m.tapback && ids.includes(m.handle) && m.date > lastOut && m.date >= since).sort((a, b) => a.date - b.date)[0];
    assert.match(sql, /m\.service/, 'the query reads the service (iMessage or SMS)');
    return { code: 0, stdout: hit ? `${hit.rowid}${SEP}${hit.date}${SEP}${hit.service ?? 'iMessage'}` : '', stderr: '' };
  };
  return { run, calls };
}
const inbound = (rowid, ms, handle = 7, extra = {}) => ({ rowid, date: msToAppleNs(ms), handle, fromMe: false, ...extra });
const outbound = (rowid, ms) => ({ rowid, date: msToAppleNs(ms), handle: 7, fromMe: true });

const CRM_ANSWER = (n, dup = false) => ({ ok: true, id: `out-${n}`, deduplicated: dup, delivery: 'owner_call', call_id: `oc-${n}`, push: { sent: 0, failed: 0 } });
/** The CRM: /mcp/desk (JSON-RPC) and the REST route. `fail`: an HTTP status for the desk; `restFail` for REST. */
function fakeDesk({ fail = null, restFail = fail } = {}) {
  const calls = [];
  const seen = new Set();
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const rest = url.endsWith('/api/kingmaker/owner-alert/unanswered-text');
    const args = rest ? body : body.params.arguments;
    calls.push({ url, auth: init.headers.authorization, name: rest ? 'REST' : body.params.name, args });
    const status = rest ? restFail : fail;
    if (status) return new Response('{"error":"down"}', { status });
    const key = `${args.contact_id ?? args.from_name}|${args.received_at}`;
    const answer = CRM_ANSWER(calls.length, seen.has(key)); seen.add(key);
    if (rest) return new Response(JSON.stringify(answer), { status: 200 });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(answer) }] } }), { status: 200 });
  };
  return { fetchImpl, calls };
}
/** The engine route (Kingmaker's owner console → /mcp/solomon with the :key ronin-crm key). */
function fakeEngine({ error = null } = {}) {
  const calls = [];
  const engine = async (payload) => { calls.push(payload); return error ? { ok: false, error } : { ok: true, data: { ok: true, ...CRM_ANSWER(calls.length) } }; };
  return { engine, calls };
}

function setup({ afterMinutes = 60 } = {}) {
  const p = paths();
  addWatchedContact(p, 'Brent', ['(602) 555-0100']);
  writeTextWatchConfig(p, { afterMinutes });
  setTextWatchEnabled(p, true, T0);
  return p;
}

test('defaults: off, Brent first, an hour, from the moment it is turned on', () => {
  const p = paths();
  const c = readTextWatchConfig(p);
  assert.equal(c.enabled, false);
  assert.deepEqual(c.contacts, [{ name: 'Brent', handles: [], contactId: 'ct_brent_agencyhub' }]);
  assert.equal(c.afterMinutes, 60);
  const on = setTextWatchEnabled(p, true, T0);
  assert.equal(on.enabled, true); assert.equal(on.since, T0);
  assert.equal(setTextWatchEnabled(p, true, T0 + 999).since, T0, 'turning it on again keeps the start');
  addWatchedContact(p, 'Dana', ['dana@example.com']);
  assert.deepEqual(readTextWatchConfig(p).contacts.map((x) => x.name), ['Brent', 'Dana']);
  removeWatchedContact(p, 'dana');
  assert.deepEqual(readTextWatchConfig(p).contacts.map((x) => x.name), ['Brent']);
  assert.throws(() => addWatchedContact(p, 'Eve', ['not a number']), /Not a phone number or email/);
  assert.throws(() => addWatchedContact(p, 'Eve', [], { contactId: 'ct eve/..' }), /CRM contact id/);
  addWatchedContact(p, 'Dana', [], { contactId: 'ct_dana_1' });
  addWatchedContact(p, 'Dana', ['dana@example.com']);
  assert.deepEqual(readTextWatchConfig(p).contacts.find((x) => x.name === 'Dana'), { name: 'Dana', handles: ['dana@example.com'], contactId: 'ct_dana_1' }, 'adding a number keeps the CRM id');
  assert.equal(readTextWatchConfig(p).contacts.find((x) => x.name === 'Brent').contactId, 'ct_brent_agencyhub', 'Brent keeps his CRM id');
});

test('handles compare by the last 10 digits or the lowercased email', () => {
  assert.equal(normalizeHandle('+1 (602) 555-0100'), '6025550100');
  assert.equal(normalizeHandle('6025550100'), '6025550100');
  assert.equal(normalizeHandle('Brent@Example.com'), 'brent@example.com');
  assert.equal(normalizeHandle('hi'), '');
  assert.ok(Math.abs(appleToMs(msToAppleNs(T0)) - T0) < 2);
});

test('a text from Brent unanswered for an hour → exactly one request_owner_call in the #346 shape, with the desk key, and nothing to Brent', async () => {
  const p = setup();
  const db = fakeMessages({ messages: [inbound(101, T0 + 5 * MIN), inbound(102, T0 + 10 * MIN)] });
  const desk = fakeDesk();
  const logged = [];
  const deps = { run: db.run, fetchImpl: desk.fetchImpl, token: 'ronin_desk_fixture', contactsUris: [], uri: 'file:/x/chat.db?mode=ro', log: (e, d) => logged.push([e, d]) };

  let r = await checkTextWatch(p, { ...deps, now: () => T0 + 50 * MIN });
  assert.deepEqual(r.flagged, []); assert.deepEqual(r.waiting, ['brent:101'], 'under an hour: waiting, no call');
  assert.equal(desk.calls.length, 0);

  r = await checkTextWatch(p, { ...deps, now: () => T0 + 66 * MIN });
  assert.deepEqual(r.flagged, ['brent:101']);
  assert.equal(desk.calls.length, 1);
  const c = desk.calls[0];
  assert.equal(c.url, 'https://www.ronininc.org/mcp/desk');
  assert.equal(c.auth, 'Bearer ronin_desk_fixture');
  assert.equal(c.name, 'request_owner_call');
  const received = Math.round(appleToMs(msToAppleNs(T0 + 5 * MIN)));
  assert.deepEqual(c.args, { from_name: 'Brent', contact_id: 'ct_brent_agencyhub', received_at: received, channel: 'imessage' }, 'exactly the #346 fields: no preview, no text, no handle');
  assert.ok(Number.isInteger(c.args.received_at), 'received_at is integer ms');
  assert.deepEqual(logged.find(([e]) => e === 'text_watch_flagged')?.[1], { contact: 'Brent', via: 'desk', id: 'out-1', deduplicated: false, delivery: 'owner_call', call_id: 'oc-1', push: { sent: 0, failed: 0 } }, 'the CRM answer is logged');

  // No repeats: the same thread on later checks, even after Brent texts again, is never flagged twice.
  await checkTextWatch(p, { ...deps, now: () => T0 + 90 * MIN });
  await checkTextWatch(p, { ...deps, now: () => T0 + 600 * MIN });
  assert.equal(desk.calls.length, 1, 'one flag per unanswered thread');
  assert.equal(readFlags(p)['brent:101'].state, 'flagged');
  assert.equal(readFlags(p)['brent:101'].call, 'oc-1');
  assert.equal(readFlags(p)['brent:101'].id, 'out-1');

  // Every process was a read-only sqlite3; no Messages send, no osascript, nothing addressed to Brent.
  assert.ok(db.calls.every((x) => x.file === 'sqlite3' && x.args[0] === '-readonly'));
  assert.ok(desk.calls.every((x) => x.name === 'request_owner_call'));
});

test('a reply from Robbie ends the wait; a new text after it is a new thread and gets its own one flag', async () => {
  const p = setup();
  const messages = [inbound(201, T0 + 1 * MIN), outbound(202, T0 + 20 * MIN)];
  const db = fakeMessages({ messages });
  const desk = fakeDesk();
  const deps = { run: db.run, fetchImpl: desk.fetchImpl, token: 'ronin_desk_fixture', contactsUris: [], uri: 'file:/x?mode=ro' };
  let r = await checkTextWatch(p, { ...deps, now: () => T0 + 120 * MIN });
  assert.deepEqual(r.flagged, []); assert.equal(desk.calls.length, 0, 'answered within the hour: no call');
  messages.push(inbound(203, T0 + 130 * MIN));
  r = await checkTextWatch(p, { ...deps, now: () => T0 + 200 * MIN });
  assert.deepEqual(r.flagged, ['brent:203']);
  assert.equal(desk.calls.length, 1);
});

test('texts from before the watch was turned on, tapbacks, and other people never count', async () => {
  const p = setup();
  const db = fakeMessages({ messages: [inbound(301, T0 - 30 * MIN), inbound(302, T0 + 5 * MIN, 7, { tapback: true }), inbound(303, T0 + 5 * MIN, 8)] });
  const desk = fakeDesk();
  const r = await checkTextWatch(p, { run: db.run, fetchImpl: desk.fetchImpl, token: 'x', contactsUris: [], uri: 'file:/x?mode=ro', now: () => T0 + 300 * MIN });
  assert.deepEqual(r.flagged, []); assert.equal(desk.calls.length, 0);
});

test('off means off; a failing CRM is retried with the same flag (the CRM dedupes it), then given up once', async () => {
  const p = setup();
  const db = fakeMessages({ messages: [inbound(401, T0 + 1 * MIN)] });
  const off = fakeDesk();
  setTextWatchEnabled(p, false);
  await checkTextWatch(p, { run: db.run, fetchImpl: off.fetchImpl, token: 'x', contactsUris: [], uri: 'file:/x?mode=ro', now: () => T0 + 300 * MIN });
  assert.equal(off.calls.length, 0);
  assert.equal(db.calls.length, 0, 'off: Messages is not even read');

  setTextWatchEnabled(p, true, T0);
  const down = fakeDesk({ fail: 503 });
  const deps = { run: db.run, fetchImpl: down.fetchImpl, token: 'x', contactsUris: [], uri: 'file:/x?mode=ro', now: () => T0 + 300 * MIN };
  const orig = console.error; const said = []; console.error = (l) => said.push(l);
  try { for (let i = 0; i < 15; i += 1) await checkTextWatch(p, deps); } finally { console.error = orig; }
  assert.equal(down.calls.filter((c) => c.name === 'request_owner_call').length, 12, 'twelve tries (an hour), then stop');
  assert.equal(down.calls.filter((c) => c.name === 'REST').length, 12, 'each try falls back to the REST route');
  assert.ok(new Set(down.calls.map((c) => JSON.stringify(c.args))).size === 1, 'the same flag every try (contact + received_at: the CRM dedupes)');
  assert.equal(readFlags(p)['brent:401'].state, 'gave_up');
  assert.equal(said.length, 1, 'said once');
});

test('no number saved: the watch looks Brent up in Contacts, and refuses to guess between two Brents', async () => {
  const p = paths(); setTextWatchEnabled(p, true, T0);
  const book = [['1', 'Brent', 'Miller', '(602) 555-0100', 'brent@miller.co']];
  const db = fakeMessages({ messages: [inbound(501, T0 + 1 * MIN)] });
  const run = async (file, args) => /FROM ZABCDRECORD/.test(args[4]) ? { code: 0, stdout: book.map((r) => r.join(SEP)).join('\n'), stderr: '' } : db.run(file, args);
  const desk = fakeDesk();
  let r = await checkTextWatch(p, { run, fetchImpl: desk.fetchImpl, token: 'x', contactsUris: ['file:/ab?mode=ro'], uri: 'file:/x?mode=ro', now: () => T0 + 120 * MIN });
  assert.deepEqual(r.flagged, ['brent:501']);
  book.push(['2', 'Brent', 'Ortiz', '480 555 0199', '']);
  const p2 = paths(); setTextWatchEnabled(p2, true, T0);
  r = await checkTextWatch(p2, { run, fetchImpl: desk.fetchImpl, token: 'x', contactsUris: ['file:/ab?mode=ro'], uri: 'file:/x?mode=ro', now: () => T0 + 120 * MIN });
  assert.deepEqual(r.flagged, []);
  assert.match(r.skipped[0].why, /2 people named Brent .*kingmaker text-watch add Brent <number>/);
});

test('the flag is the #346 shape: name, CRM id when set, integer ms, imessage|sms; never the text', () => {
  assert.deepEqual(alertPayload({ name: 'Brent', handles: ['+16025550100'], contactId: 'ct_brent_agencyhub' }, { rowId: 9, receivedAtMs: T0 + 0.6, channel: 'sms', text: 'secret' }),
    { from_name: 'Brent', contact_id: 'ct_brent_agencyhub', received_at: T0 + 1, channel: 'sms' });
  assert.deepEqual(alertPayload({ name: 'Dana', handles: [] }, { receivedAtMs: T0, channel: 'imessage' }), { from_name: 'Dana', received_at: T0, channel: 'imessage' });
  assert.equal(channelOf('iMessage'), 'imessage'); assert.equal(channelOf('SMS'), 'sms'); assert.equal(channelOf('RCS'), 'sms');
});

test('an SMS thread goes out as channel sms', async () => {
  const p = setup();
  const db = fakeMessages({ messages: [inbound(601, T0 + 1 * MIN, 7, { service: 'SMS' })] });
  const desk = fakeDesk();
  await checkTextWatch(p, { run: db.run, fetchImpl: desk.fetchImpl, token: 'x', contactsUris: [], uri: 'file:/x?mode=ro', now: () => T0 + 120 * MIN });
  assert.equal(desk.calls[0].args.channel, 'sms');
});

test('no desk key: the engine flags the CRM with the :key ronin-crm (master) key; nothing goes to the CRM from here', async () => {
  const p = setup();
  const db = fakeMessages({ messages: [inbound(701, T0 + 1 * MIN)] });
  const desk = fakeDesk(); const eng = fakeEngine();
  const logged = [];
  const r = await checkTextWatch(p, { run: db.run, fetchImpl: desk.fetchImpl, token: null, engine: eng.engine, contactsUris: [], uri: 'file:/x?mode=ro', now: () => T0 + 120 * MIN, log: (e, d) => logged.push([e, d]) });
  assert.deepEqual(r.flagged, ['brent:701']);
  assert.equal(desk.calls.length, 0, 'no desk key: the add-on calls nothing itself');
  assert.deepEqual(Object.keys(eng.calls[0]).sort(), ['channel', 'contact_id', 'from_name', 'received_at']);
  assert.equal(logged[0][1].via, 'engine');
  await checkTextWatch(p, { run: db.run, fetchImpl: desk.fetchImpl, token: null, engine: eng.engine, contactsUris: [], uri: 'file:/x?mode=ro', now: () => T0 + 200 * MIN });
  assert.equal(eng.calls.length, 1, 'still one flag per thread');
});

test('a desk route that fails falls back to REST, then to the engine; neither key: says so, no call', async () => {
  const payload = { from_name: 'Brent', contact_id: 'ct_brent_agencyhub', received_at: T0, channel: 'imessage' };
  const deskOnlyDown = fakeDesk({ fail: 500, restFail: null });
  let r = await deliverAlert(payload, { token: 'ronin_desk_x', fetchImpl: deskOnlyDown.fetchImpl });
  assert.equal(r.via, 'rest'); assert.equal(r.call_id, 'oc-2');
  assert.equal(deskOnlyDown.calls[1].url, 'https://www.ronininc.org/api/kingmaker/owner-alert/unanswered-text');
  assert.equal(deskOnlyDown.calls[1].auth, 'Bearer ronin_desk_x');
  const allDown = fakeDesk({ fail: 404 }); const eng = fakeEngine();
  r = await deliverAlert(payload, { token: 'ronin_desk_x', fetchImpl: allDown.fetchImpl, engine: eng.engine });
  assert.equal(r.via, 'engine'); assert.equal(eng.calls.length, 1);
  await assert.rejects(deliverAlert(payload, { token: null, engine: fakeEngine({ error: 'NO_CRM_KEY' }).engine }), /no CRM key \(:key ronin-crm\)/);
  const p = setup();
  const db = fakeMessages({ messages: [inbound(801, T0 + 1 * MIN)] });
  const out = await checkTextWatch(p, { run: db.run, token: null, engine: null, contactsUris: [], uri: 'file:/x?mode=ro', now: () => T0 + 120 * MIN });
  assert.match(out.skipped[0].why, /no Kingmaker desk key.*:key ronin-crm/);
});

test('the engine route goes through the owner console with the launch nonce', async () => {
  const seen = [];
  const ownerCall = async (port, path, opts) => { seen.push({ port, path, opts }); return { ok: true, status: 200, json: { ok: true, data: { ok: true, id: 'o1', deduplicated: true, delivery: 'push', call_id: null, push: { sent: 1 } } } }; };
  const r = await engineAlerter(ownerCall, 4321, 'n'.repeat(64))({ from_name: 'Brent', received_at: T0, channel: 'sms' });
  assert.equal(seen[0].path, '/api/kingmaker-approver/owner-alert/unanswered-text');
  assert.equal(seen[0].opts.method, 'POST'); assert.equal(seen[0].opts.nonce, 'n'.repeat(64));
  assert.equal(r.ok, true); assert.equal(r.data.deduplicated, true);
});

test('the file cannot send a message: no Messages send, AppleScript or SMS path in it', () => {
  const src = readFileSync(new URL('../text-watch.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /osascript|send_message|sendMessage|textOwner|imessage-send|tell application "Messages"/i);
  assert.doesNotMatch(src, /preview['"]?\s*:/, 'no preview field is ever built');
  assert.match(src, /name: 'request_owner_call'/);
});

test('kingmaker text-watch on|add|after|status', async () => {
  const p = paths();
  const out = []; const log = console.log; const err = console.error;
  console.log = (l) => out.push(String(l)); console.error = (l) => out.push(String(l));
  try {
    assert.equal(await textWatchCommand(['add', 'Brent', '+16025550100'], { paths: p }), 0);
    assert.equal(await textWatchCommand(['add', 'Dana', '--contact-id', 'ct_dana_9', 'dana@example.com'], { paths: p }), 0);
    assert.equal(await textWatchCommand(['add', 'Sam', '--contact-id=ct_sam'], { paths: p }), 0);
    assert.equal(await textWatchCommand(['add', 'Bad', '--contact-id'], { paths: p }), 2);
    assert.equal(await textWatchCommand(['after', '45'], { paths: p }), 0);
    assert.equal(await textWatchCommand(['on'], { paths: p }), 0);
    assert.equal(await textWatchCommand(['after', '2'], { paths: p }), 2);
    assert.equal(await textWatchCommand(['nope'], { paths: p }), 2);
  } finally { console.log = log; console.error = err; }
  const c = readTextWatchConfig(p);
  assert.equal(c.enabled, true); assert.equal(c.afterMinutes, 45);
  assert.deepEqual(c.contacts, [
    { name: 'Brent', handles: ['+16025550100'], contactId: 'ct_brent_agencyhub' },
    { name: 'Dana', handles: ['dana@example.com'], contactId: 'ct_dana_9' },
    { name: 'Sam', handles: [], contactId: 'ct_sam' },
  ]);
  assert.ok(out.some((l) => /Nobody you watch is ever contacted/.test(l)));
});
