import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyHandle, classifyScreen, decideOutbound, matchContacts, secretInText } from '../lib/iphone-policy.mjs';
import { DNC_ENDPOINT_LIMIT, dncFrom, snapshotFrom, syncDnc, writeSnapshot } from '../lib/iphone-dnc.mjs';
import { createBridge, findTarget, loopStuck, ollamaDecider, runLoop, toElements } from '../lib/iphone-bridge.mjs';
import { IPHONE_TOOLS, callIphoneTool } from '../lib/iphone-mcp.mjs';
import { TOOLS, handleMessage } from '../lib/mcp.mjs';
import { claudeArgs, claudeDraftArgs, DRAFT_DENIED } from '../lib/claude-brain.mjs';

const MOM = { id: 'C-MOM', name: 'Mom', phones: ['(602) 555-0100'], emails: ['mom@example.com'] };
const SAM = { id: 'C-SAM', name: 'Sam Lee', phones: ['602-555-0111', '+1 480 555 0112'], emails: [] };
const NOW = Date.parse('2026-10-13T18:00:00Z');
const fresh = (phones = []) => dncFrom(snapshotFrom({ entries: phones.map((p) => ({ phone_e164: p })) }, { now: NOW - 3600_000 }), { now: NOW });

// ---- the policy gate (pure) ----------------------------------------------------------------------------------

test('a known contact is allowed, and still needs Ana\'s confirmation by default', () => {
  const d = decideOutbound({ action: 'imessage', to: 'Mom', text: 'Running 10 min late' }, { contacts: [MOM], dnc: fresh() });
  assert.equal(d.allowed, true);
  assert.equal(d.needsConfirm, true);
  assert.deepEqual(d.handle, { kind: 'phone', value: '+16025550100' });
  assert.match(d.readBack, /^iMessage Mom \(\+16025550100\): "Running 10 min late"$/);
  const byNumber = decideOutbound({ action: 'call', to: '602.555.0100' }, { contacts: [MOM], dnc: fresh() });
  assert.equal(byNumber.allowed, true);
  assert.equal(byNumber.readBack, 'Call Mom (+16025550100) from your iPhone.');
  const byEmail = decideOutbound({ action: 'imessage', to: 'MOM@example.com', text: 'hi' }, { contacts: [MOM], dnc: fresh() });
  assert.equal(byEmail.allowed, true);
  assert.equal(byEmail.handle.value, 'mom@example.com');
});

test('an unknown number or handle is refused, with a clear refusal', () => {
  for (const to of ['+1 (480) 555-0199', 'stranger@example.com', 'Bob Nobody']) {
    const d = decideOutbound({ action: 'imessage', to, text: 'hey' }, { contacts: [], dnc: fresh() });
    assert.equal(d.allowed, false, to);
    assert.equal(d.code, 'unknown-recipient');
    assert.match(d.refusal, /not in your Contacts/);
  }
  // Contacts' fuzzy phone match returned a card, but the number asked for is not on it: still a stranger.
  const fuzzy = decideOutbound({ action: 'sms', to: '480-555-0199', text: 'hey' }, { contacts: [MOM], dnc: fresh() });
  assert.equal(fuzzy.code, 'unknown-recipient');
  assert.equal(decideOutbound({ action: 'call', to: '12345678' }, { contacts: [MOM], dnc: fresh() }).code, 'bad-request');
});

test('a do-not-call number is refused, including another number on the same card', () => {
  const d = decideOutbound({ action: 'call', to: 'Mom' }, { contacts: [MOM], dnc: fresh(['+16025550100']) });
  assert.equal(d.allowed, false);
  assert.equal(d.code, 'dnc');
  assert.match(d.refusal, /do-not-call/);
  // iMessage to Mom's email still checks the phones on her card
  assert.equal(decideOutbound({ action: 'imessage', to: 'mom@example.com', text: 'hi' }, { contacts: [MOM], dnc: fresh(['+16025550100']) }).code, 'dnc');
  assert.equal(decideOutbound({ action: 'call', to: '602-555-0111' }, { contacts: [SAM], dnc: fresh(['+14805550112']) }).code, 'dnc');
});

test('no do-not-call snapshot, a stale one or a truncated one blocks everything (fail closed)', () => {
  const ask = { action: 'call', to: 'Mom' };
  assert.equal(decideOutbound(ask, { contacts: [MOM] }).code, 'dnc-unavailable');
  assert.equal(decideOutbound(ask, { contacts: [MOM], dnc: dncFrom(null) }).code, 'dnc-unavailable');
  const stale = dncFrom(snapshotFrom({ entries: [] }, { now: NOW - 30 * 3600_000 }), { now: NOW });
  assert.equal(stale.ok, false);
  assert.equal(decideOutbound(ask, { contacts: [MOM], dnc: stale }).code, 'dnc-unavailable');
  const full = snapshotFrom({ entries: Array.from({ length: DNC_ENDPOINT_LIMIT }, (_, i) => ({ phone_e164: `+1602555${String(i).padStart(4, '0')}` })) }, { now: NOW });
  assert.equal(full.truncated, true);
  assert.equal(decideOutbound(ask, { contacts: [MOM], dnc: dncFrom(full, { now: NOW }) }).code, 'dnc-unavailable');
  const throwing = { ok: true, check() { throw new Error('boom'); } };
  assert.equal(decideOutbound(ask, { contacts: [MOM], dnc: throwing }).code, 'dnc');
});

test('ambiguous names and cards with several numbers are refused, not guessed', () => {
  assert.equal(decideOutbound({ action: 'imessage', to: 'Sam', text: 'yo' }, { contacts: [SAM, { ...SAM, id: 'C-SAM2', name: 'Sam Ortiz' }], dnc: fresh() }).code, 'ambiguous');
  assert.equal(decideOutbound({ action: 'call', to: 'Sam Lee' }, { contacts: [SAM], dnc: fresh() }).code, 'ambiguous');
  assert.equal(decideOutbound({ action: 'call', to: '+14805550112' }, { contacts: [SAM], dnc: fresh() }).allowed, true);
});

test('a trusted contact skips confirmation only on the channels Ana trusted', () => {
  const policy = { trusted: [{ contactId: 'C-MOM', name: 'Mom', channels: ['imessage'] }] };
  assert.equal(decideOutbound({ action: 'imessage', to: 'Mom', text: 'hi' }, { contacts: [MOM], dnc: fresh(), policy }).needsConfirm, false);
  assert.equal(decideOutbound({ action: 'call', to: 'Mom' }, { contacts: [MOM], dnc: fresh(), policy }).needsConfirm, true);
  assert.equal(decideOutbound({ action: 'imessage', to: 'Mom', text: 'hi' }, { contacts: [MOM], dnc: fresh(), policy: { trusted: 'everyone' } }).needsConfirm, true);
});

test('passwords, codes and card numbers are never sent or typed', () => {
  for (const t of ['my password is hunter2', 'Your verification code: 482913', 'card 4242 4242 4242 4242 exp 12/29', 'cvv 123', 'ssn 123-45-6789']) {
    assert.ok(secretInText(t), t);
    assert.equal(decideOutbound({ action: 'imessage', to: 'Mom', text: t }, { contacts: [MOM], dnc: fresh() }).code, 'secret', t);
  }
  for (const t of ['Meet at 5:30, room 1204', 'Call me at 602-555-0100', 'Order #4242 is ready']) assert.equal(secretInText(t), null, t);
});

test('screen guard: secret screens and compose boxes are recognized', () => {
  assert.equal(classifyScreen(['Apple Account', 'Enter your Apple Account password', 'Cancel']), 'secret');
  assert.equal(classifyScreen(['Enter Passcode', '1', '2', '3']), 'secret');
  assert.equal(classifyScreen(['Mom', 'iMessage', 'Today 9:41 AM']), 'compose');
  assert.equal(classifyScreen(['Settings', 'General', 'Wi-Fi']), 'ok');
  assert.deepEqual(classifyHandle(' +1 602 555 0100 '), { kind: 'phone', value: '+16025550100' });
});

// ---- the bridge with a fake helper (no Mac permissions, no phone) -------------------------------------------

const WIN = { id: 77, pid: 9, x: 100, y: 50, w: 300, h: 650 };
const ocrOf = (texts) => texts.map((t, i) => ({ text: t, conf: 0.99, x: 0.1, y: 0.05 + i * 0.05, w: 0.3, h: 0.03 }));

function fakeMac({ contacts = [MOM], contactsOk = true, appContacts = null, approve = false, screens = [['Settings', 'General']], policy = {}, dncPhones = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'km-iphone-'));
  writeSnapshot(join(dir, 'dnc-snapshot.json'), snapshotFrom({ entries: dncPhones.map((p) => ({ phone_e164: p })) }, { now: Date.now() }));
  const calls = []; const asked = [];
  let shot = 0;
  const reply = (o) => ({ code: o.ok === false ? 1 : 0, stdout: `${JSON.stringify(o)}\n`, stderr: '' });
  const run = async (cmd, args, { input } = {}) => {
    calls.push({ cmd, args, input });
    if (cmd === process.execPath) {
      switch (args[0]) {
        case 'window': return reply({ ok: true, window: WIN });
        case 'ocr': return reply({ ok: true, items: ocrOf(screens[Math.min(shot++, screens.length - 1)]) });
        case 'activate': case 'click': case 'key': case 'type': case 'drag': return reply({ ok: true });
        case 'contacts': return reply(contactsOk ? { ok: true, contacts } : { ok: false, error: 'contacts access not granted', access: 'denied' });
        case 'policy-get': return reply({ ok: true, policy: JSON.stringify(policy) });
        case 'auth': asked.push(args[1]); return reply({ ok: true, approved: approve });
        default: return reply({ ok: false, error: 'unexpected' });
      }
    }
    if (cmd === '/usr/bin/osascript' && args[0] === '-l') return appContacts ? { code: 0, stdout: JSON.stringify(appContacts), stderr: '' } : { code: 1, stdout: '', stderr: 'Not authorized to send Apple events to Contacts. (-1743)' };
    if (cmd === '/usr/bin/osascript') return { code: 0, stdout: args.length > 1 ? 'handed to Messages\n' : 'pressed\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const bridge = createBridge({ stateDir: dir, helper: process.execPath, run, sleep: async () => {}, settleMs: 0 });
  const sent = () => calls.filter((c) => c.cmd === '/usr/bin/osascript' && c.args.length > 1 && c.args[0] !== '-l');
  return { bridge, calls, asked, sent, dir };
}

test('send: Ana says no → nothing reaches Messages; says yes → it does, text as an argument, never in the script', async () => {
  const no = fakeMac({ approve: false });
  const r1 = await no.bridge.sendMessage({ to: 'Mom', text: 'On my way "now"' });
  assert.equal(r1.sent, false);
  assert.match(no.asked[0], /^iMessage Mom \(\+16025550100\)/);
  assert.equal(no.sent().length, 0);

  const yes = fakeMac({ approve: true });
  const r2 = await yes.bridge.sendMessage({ to: 'Mom', text: 'On my way "now"' });
  assert.equal(r2.sent, true);
  const [m] = yes.sent();
  assert.deepEqual(m.args, ['-', '+16025550100', 'On my way "now"', 'iMessage']);
  assert.ok(!m.input.includes('On my way'), 'message text never becomes AppleScript source');
  const log = readFileSync(join(yes.dir, 'actions.jsonl'), 'utf8');
  assert.ok(!log.includes('On my way'), 'the audit log keeps a hash, not the message');
});

test('send to a stranger is refused before Ana is even asked; no Contacts permission refuses too', async () => {
  const m = fakeMac({ contacts: [], approve: true });
  const r = await m.bridge.sendMessage({ to: '+14805550199', text: 'hello' });
  assert.equal(r.sent, false);
  assert.equal(r.code, 'unknown-recipient');
  assert.equal(m.asked.length, 0);
  assert.equal(m.sent().length, 0);
  const denied = fakeMac({ contactsOk: false, approve: true });
  const d = await denied.bridge.sendMessage({ to: 'Mom', text: 'hello' });
  assert.match(d.refusal, /cannot read your Contacts/);
  assert.equal(denied.sent().length, 0);
});

test('no Contacts framework access → Contacts.app over Automation, same gate', async () => {
  const m = fakeMac({ contactsOk: false, appContacts: [MOM, SAM], approve: true });
  const r = await m.bridge.sendMessage({ to: '602 555 0100', text: 'hello' });
  assert.equal(r.sent, true);
  assert.deepEqual(m.sent()[0].args.slice(1, 2), ['+16025550100']);
  const s = fakeMac({ contactsOk: false, appContacts: [MOM], approve: true });
  assert.equal((await s.bridge.sendMessage({ to: '+14805550199', text: 'hello' })).code, 'unknown-recipient');
  assert.equal(s.sent().length, 0);
});

test('matchContacts: a number or email must be on the card; names match whole words from the start', () => {
  assert.deepEqual(matchContacts([MOM, SAM], '+1 602 555 0100').map((c) => c.id), ['C-MOM']);
  assert.deepEqual(matchContacts([MOM, SAM], '480 555 0199'), []);
  assert.deepEqual(matchContacts([MOM, SAM], 'MOM@example.com').map((c) => c.id), ['C-MOM']);
  assert.deepEqual(matchContacts([MOM, SAM], 'sam').map((c) => c.id), ['C-SAM']);
  assert.deepEqual(matchContacts([MOM, SAM, { id: 'X', name: 'Mommy Dearest', phones: [] }], 'mom').map((c) => c.id), ['C-MOM']);
  assert.deepEqual(matchContacts([MOM, SAM], 'am'), []);
});

test('an exact full name picks its card over looser matches, on the Contacts-framework path too', async () => {
  const dot = { id: 'C-R1', name: 'Ana G.', phones: ['602-555-0150'], emails: [] };
  const bare = { id: 'C-R2', name: 'Ana G', phones: ['602-555-0150'], emails: [] };
  const m = fakeMac({ contacts: [dot, bare], approve: true });
  const r = await m.bridge.sendMessage({ to: 'Ana G.', text: 'test' });
  assert.equal(r.sent, true);
  assert.match(r.readBack, /^iMessage Ana G\. \(\+16025550150\)/);
  const n = fakeMac({ contacts: [dot, bare], approve: true });
  assert.equal((await n.bridge.sendMessage({ to: '+16025550150', text: 'test' })).code, 'ambiguous', 'a number on two cards stays ambiguous');
});

test('DNC on the bridge: refused, Ana is not asked, nothing is sent', async () => {
  const m = fakeMac({ approve: true, dncPhones: ['+16025550100'] });
  const r = await m.bridge.placeCall({ to: 'Mom' });
  assert.equal(r.code, 'dnc');
  assert.equal(m.asked.length, 0);
  assert.ok(!m.calls.some((c) => c.cmd === '/usr/bin/open'));
});

test('call: confirmed → tel: link for the contact\'s number; trusted → no prompt', async () => {
  const m = fakeMac({ approve: true });
  const r = await m.bridge.placeCall({ to: 'Mom' });
  assert.equal(r.ok, true);
  assert.deepEqual(m.calls.find((c) => c.cmd === '/usr/bin/open').args, ['tel:+16025550100']);
  const t = fakeMac({ approve: false, policy: { trusted: [{ contactId: 'C-MOM', channels: ['call'] }] } });
  const r2 = await t.bridge.placeCall({ to: 'Mom' });
  assert.equal(r2.ok, true);
  assert.equal(t.asked.length, 0);
  assert.equal(r2.confirmedBy, 'owner-trusted-contact');
});

test('tap by text clicks the element\'s center in screen points, then reads the screen again', async () => {
  const m = fakeMac({ screens: [['Settings', 'General'], ['General', 'About']] });
  const r = await m.bridge.tap({ text: 'general' });
  assert.equal(r.ok, true);
  const click = m.calls.find((c) => c.args?.[0] === 'click');
  const el = toElements(ocrOf(['Settings', 'General']), WIN)[1];
  assert.deepEqual(click.args, ['click', String(WIN.x + el.x), String(WIN.y + el.y)]);
  assert.equal(r.changed, true);
  assert.equal((await m.bridge.tap({ text: 'Bluetooth' })).ok, false);
});

test('a password screen stops tap and type and hands back; a compose box needs Ana', async () => {
  const s = fakeMac({ screens: [['Sign In', 'Password', 'Cancel']] });
  const r = await s.bridge.tap({ text: 'Cancel' });
  assert.equal(r.handBack, true);
  assert.ok(!s.calls.some((c) => c.args?.[0] === 'click'));
  assert.equal((await s.bridge.type({ text: 'hello' })).handBack, true);
  const c = fakeMac({ screens: [['Mom', 'iMessage']], approve: false });
  const t = await c.bridge.type({ text: 'hi stranger' });
  assert.equal(t.ok, false);
  assert.match(c.asked[0], /message box/);
  assert.ok(!c.calls.some((x) => x.args?.[0] === 'type'));
  const send = fakeMac({ screens: [['Photos', 'Send']], approve: false });
  assert.equal((await send.bridge.tap({ text: 'Send' })).ok, false);
  assert.equal(send.asked.length, 1);
});

test('typing needs Ana in a messaging app or an app the bridge did not open; not in Settings', async () => {
  const fresh = fakeMac({ approve: false, screens: [['Mr. Social', 'Yes', 'Post it']] });
  assert.equal((await fresh.bridge.type({ text: 'hi' })).ok, false, 'fresh connect: context unknown');
  assert.match(fresh.asked[0], /did not open myself/);
  const settings = fakeMac({ approve: false });
  await settings.bridge.openApp({ name: 'Settings' });
  assert.equal((await settings.bridge.type({ text: 'wifi' })).ok, true);
  assert.equal(settings.asked.length, 0);
  await settings.bridge.openApp({ name: 'WhatsApp' });
  assert.equal((await settings.bridge.type({ text: 'hey' })).ok, false);
  assert.equal((await settings.bridge.press({ button: 'return' })).ok, false);
  assert.equal(settings.asked.length, 2);
  await settings.bridge.press({ button: 'home' });
  await settings.bridge.tap({ text: 'General' }); // a Home Screen icon label → that app
  assert.equal((await settings.bridge.type({ text: 'x' })).ok, true);
  const yes = fakeMac({ approve: true });
  await yes.bridge.openApp({ name: 'Messages' });
  assert.equal((await yes.bridge.type({ text: 'hello' })).ok, true, 'his Touch ID lets it through');
});

test('Wallet and Passwords are never opened; typing a code is refused', async () => {
  const m = fakeMac();
  assert.equal((await m.bridge.openApp({ name: 'Wallet' })).ok, false);
  assert.equal((await m.bridge.type({ text: 'passcode: 123456' })).handBack, true);
  const ok = await m.bridge.openApp({ name: 'Settings' });
  assert.equal(ok.ok, true);
  assert.deepEqual(m.calls.filter((c) => c.args?.[0] === 'key').map((c) => c.args[1]), ['cmd+1', 'cmd+3', 'return']);
});

test('findTarget prefers an exact match, top to bottom', () => {
  const els = [{ text: 'General settings', x: 1, y: 30 }, { text: 'General', x: 1, y: 60 }];
  assert.equal(findTarget(els, 'general').y, 60);
  assert.equal(findTarget(els, 'settings').y, 30);
});

// ---- the registry and the loop --------------------------------------------------------------------------------

test('the registry carries the order\'s methods and no way to approve, trust or change policy', async () => {
  const names = TOOLS.map((t) => t.name);
  for (const n of ['see-phone-screen', 'tap-phone', 'type-on-phone', 'open-phone-app', 'call-from-phone', 'send-imessage-to-contact']) assert.ok(names.includes(n), n);
  assert.ok(!names.some((n) => /approv|trust|policy|dnc|confirm/i.test(n)), 'no self-approval surface');
  assert.ok(IPHONE_TOOLS.every((t) => /^[a-z-]{1,64}$/.test(t.name)));
  const m = fakeMac({ contacts: [], approve: true });
  const res = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send-imessage-to-contact', arguments: { to: '+14805550199', text: 'hi' } } }, { iphone: m.bridge });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /not in your Contacts/);
  assert.equal((await callIphoneTool('see-phone-screen', {}, {})).isError, true, 'no bridge → a setup hint, not a crash');
});

test('the loop stops on a secret screen and refuses unknown steps; the decider must be local', async () => {
  const s = fakeMac({ screens: [['Enter Passcode']] });
  const r = await runLoop({ bridge: s.bridge, goal: 'x', decide: async () => ({ action: 'tap', text: '1' }) });
  assert.equal(r.handBack, true);
  const o = fakeMac();
  const bad = await runLoop({ bridge: o.bridge, goal: 'x', decide: async () => ({ action: 'send_imessage', to: 'anyone' }) });
  assert.match(bad.reason, /unknown step/);
  const done = await runLoop({ bridge: o.bridge, goal: 'open General', decide: async ({ history }) => (history.length ? { action: 'done' } : { action: 'tap', text: 'General' }) });
  assert.equal(done.done, true);
  assert.throws(() => ollamaDecider({ url: 'https://api.example.com/chat' }), /local/);
});

test('the loop stops when it is stuck: the same step three times, back and forth, or nothing changing', async () => {
  // A scripted phone: every step "works"; `changes` says whether the screen moved.
  const phone = (changes = () => true) => { let n = 0; const res = () => ({ ok: true, changed: changes(n++), screen: { screen: 'app', elements: [{ text: 'General' }] } });
    return { see: async () => ({ screen: 'app', elements: [{ text: 'General' }] }), tap: async () => res(), press: async () => res(), swipe: async () => res(), type: async () => res(), openApp: async () => res() }; };
  const steps = (list) => async ({ history }) => list[history.length] ?? { action: 'done' };
  const tap = (text) => ({ action: 'tap', text });
  const rep = await runLoop({ bridge: phone(), goal: 'x', decide: steps([tap('General'), tap('General'), tap('General'), tap('About')]) });
  assert.deepEqual([rep.stuck, rep.history.length, rep.done], ['repeat', 3, false]);
  const pp = await runLoop({ bridge: phone(), goal: 'x', decide: steps([tap('General'), { action: 'press', button: 'escape' }, tap('General'), { action: 'press', button: 'escape' }, tap('About')]) });
  assert.deepEqual([pp.stuck, pp.history.length], ['ping_pong', 4]);
  const still = await runLoop({ bridge: phone(() => false), goal: 'x', decide: steps([tap('A'), tap('B'), tap('C'), tap('D')]) });
  assert.deepEqual([still.stuck, still.history.length], ['no_change', 3]); assert.match(still.reason, /changed nothing/);
  // Real progress is never cut short.
  const ok = await runLoop({ bridge: phone(), goal: 'x', decide: steps([tap('Settings'), tap('General'), tap('About'), tap('Name')]) });
  assert.deepEqual([ok.done, ok.history.length, ok.stuck], [true, 4, undefined]);
  assert.equal(loopStuck([]), null);
  assert.equal(loopStuck([{ step: tap('A'), changed: false }, { step: tap('B'), changed: true }, { step: tap('C'), changed: false }]), null, 'one change resets it');
});

test('dnc sync: one GET with the bearer to the CRM list; no token → nothing fetched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'km-dnc-'));
  const file = join(dir, 'dnc.json');
  let seen;
  const fetchImpl = async (url, opts) => { seen = { url, auth: opts.headers.authorization }; return { ok: true, json: async () => ({ entries: [{ phone_e164: '+16025550100' }, { phone_e164: 'junk' }] }) }; };
  const src = { url: 'https://crm.example.com/api/dnc/snapshot', tokenPrefix: 'crm_dnc_' };
  const s = await syncDnc(file, { token: 'crm_dnc_test', fetchImpl, ...src });
  assert.equal(seen.url, src.url);
  assert.equal(seen.auth, 'Bearer crm_dnc_test');
  assert.deepEqual(s.phones, ['+16025550100']);
  assert.ok(!readFileSync(file, 'utf8').includes('crm_dnc_test'));
  seen = null;
  await assert.rejects(syncDnc(join(dir, 'y.json'), { token: 'crm_capital_abc123', fetchImpl, ...src }), /crm_capital_… token, not a do-not-call reader/);
  await assert.rejects(syncDnc(join(dir, 'z.json'), { token: 'crm_dnc_test', fetchImpl }), /dnc import/, 'no CRM source: import only');
  assert.equal(seen, null, 'a stronger token is never sent');
  const big = (n, complete) => snapshotFrom({ entries: Array.from({ length: n }, (_, i) => ({ phone_e164: `+1602555${String(i).padStart(4, '0')}` })), complete }, { now: NOW });
  assert.equal(big(600, true).truncated, false, 'the snapshot endpoint has no 500 cap');
  assert.equal(big(3, false).truncated, true);
  await assert.rejects(syncDnc(join(dir, 'x.json'), { token: null, fetchImpl, ...src }), /Keychain/);
  assert.equal(existsSync(join(dir, 'x.json')), false);
});

// ---- the interactive brains' tool surface: the acting iPhone tools are gated SERVER-SIDE, reached the way a brain reaches them ----
test('through the MCP tools a brain calls: message, call, tap Send and type in a message box do nothing without Robbie\'s yes', async () => {
  const deny = { send: fakeMac({ approve: false }), call: fakeMac({ approve: false }), tap: fakeMac({ approve: false, screens: [['Photos', 'Send']] }), type: fakeMac({ approve: false, screens: [['Mom', 'iMessage']] }) };
  const results = {
    send: await callIphoneTool('send-imessage-to-contact', { to: 'Mom', text: 'hello' }, { bridge: deny.send.bridge }),
    call: await callIphoneTool('call-from-phone', { to: 'Mom' }, { bridge: deny.call.bridge }),
    tap: await callIphoneTool('tap-phone', { text: 'Send' }, { bridge: deny.tap.bridge }),
    type: await callIphoneTool('type-on-phone', { text: 'hi' }, { bridge: deny.type.bridge }),
  };
  for (const [k, r] of Object.entries(results)) { assert.equal(r.isError, true, `${k} is refused without the yes`); assert.equal(deny[k].asked.length, 1, `${k} asked the owner (Touch ID) first`); }
  assert.equal(deny.send.sent().length, 0, 'nothing reached Messages');
  assert.ok(!deny.call.calls.some((c) => c.cmd === '/usr/bin/open'), 'no call was placed');
  assert.ok(!deny.tap.calls.some((c) => c.args?.[0] === 'click'), 'Send was not tapped');
  assert.ok(!deny.type.calls.some((c) => c.args?.[0] === 'type'), 'nothing was typed into the message box');
  // and the same calls with his yes do go through, so the gate is the owner's, not a stub
  const yes = fakeMac({ approve: true });
  assert.equal((await callIphoneTool('send-imessage-to-contact', { to: 'Mom', text: 'hello' }, { bridge: yes.bridge })).isError, undefined);
  assert.equal(yes.sent().length, 1);
});

test('the interactive Claude brain reaches the iPhone only through that gate; the draft denies the acting tools outright', () => {
  const a = claudeArgs({ text: 'hi', mcpConfigPath: '/m.json' });
  const allowed = a.slice(a.indexOf('--allowedTools') + 1, a.indexOf('--disallowedTools'));
  assert.ok(allowed.includes('mcp__kingmaker'), 'the interactive brain keeps the Kingmaker server (each acting tool is gated inside it, proven above)');
  assert.ok(!a.some((x) => /^Bash|^Write$|^WebFetch$/.test(x) && allowed.includes(x)));
  const d = claudeDraftArgs({ text: 'x', mcpConfigPath: '/m.json' });
  for (const t of ['send-imessage-to-contact', 'call-from-phone', 'tap-phone', 'type-on-phone']) assert.ok(d.includes(`mcp__kingmaker__${t}`) && DRAFT_DENIED.includes(`mcp__kingmaker__${t}`), `${t} is denied to a draft`);
  assert.ok(IPHONE_TOOLS.some((t) => t.name === 'send-imessage-to-contact') && !IPHONE_TOOLS.some((t) => /approve|trust|policy/.test(t.name)), 'and there is no tool that approves or trusts');
});
