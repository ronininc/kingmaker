import './_bind.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  codeDialogScript, ensureInstallId, GRANT_SLOTS, markNeedsRepair, markPairingWanted, PAIR_PAGE, pairingDockEnv, pairingReason,
  pairingStatePath, PairingEnded, pairWithRonin, readPairingState, runPairing, showCodeOnMac, storeCredentials, storeDeskKey,
  validateHandover, waitForApproval, writePairingState,
} from '../ronin-pairing.mjs';
import { maintainRoninDeskDock, readRoninDeskConfig, setRoninDeskEnabled } from '../ronin-desk-dock.mjs';
import { ownerCallCommand } from '../owner-call.mjs';

const hex = (n, c = 'a') => c.repeat(n);
const tempPaths = () => ({ state: join(mkdtempSync(join(tmpdir(), 'kingmaker-pairing-')), 'profile') });

/** A fake login Keychain behind /usr/bin/security: find by service/account, add through `-i` on stdin. */
function fakeKeychain(items = {}) {
  const store = new Map(Object.entries(items));
  const calls = [];
  const run = (args, input) => {
    calls.push({ args, input });
    if (args[0] === 'find-generic-password') {
      const key = `${args[args.indexOf('-s') + 1]}|${args[args.indexOf('-a') + 1]}`;
      return store.has(key) ? { status: 0, stdout: args.includes('-w') ? `${store.get(key)}\n` : '' } : { status: 44, stdout: '' };
    }
    if (args[0] === '-i') {
      const m = /add-generic-password -U -s "([^"]*)" -a "([^"]*)" -l "([^"]*)" -w "([^"]*)"/.exec(input);
      if (!m) return { status: 1, stdout: '' };
      store.set(`${m[1]}|${m[2]}`, m[4]);
      return { status: 0, stdout: '' };
    }
    return { status: 1, stdout: '' };
  };
  return { run, store, calls };
}

const slotKey = (grant) => `${GRANT_SLOTS[grant].service}|${GRANT_SLOTS[grant].account}`;

/** A fake CRM pairing endpoint: start, then `pending` until approve(), then the keys once, then `used`. */
function fakeCrm({ grants = ['desk:kingmaker'], deny = false, installIdFor = (id) => id, script = [] } = {}) {
  const seen = [];
  let installId = null; let approved = false; let collected = false; let polls = 0;
  const reply = (status, body) => ({ status, json: async () => body });
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ url, method: init.method, body, headers: init.headers });
    if (url.endsWith('/api/kingmaker/pair/start')) { installId = body.install_id; return reply(200, { ok: true, device_code: `ronin_pairdev_${hex(64, 'd')}`, user_code: 'BCDF-GHJK', expires_in: 600, interval: 5, crm: 'ronininc' }); }
    if (url.endsWith('/api/kingmaker/pair/poll')) {
      polls += 1;
      const step = script.shift();
      if (step === 'throw') throw new Error('network down');
      if (step) return reply(step.status ?? 200, step.body);
      if (deny) return reply(403, { status: 'denied' });
      if (!approved) return reply(200, { status: 'pending', interval: 5 });
      if (collected) return reply(410, { status: 'used' });
      collected = true;
      return reply(200, { status: 'approved', crm: 'ronininc', pairing_id: 'pair-0000-1111-2222', install_id: installIdFor(installId), credentials: grants.map((grant, i) => ({ grant, token: `${GRANT_SLOTS[grant]?.prefix ?? 'ronin_x_'}${hex(64, String(i))}`, token_id: `t${i}`, expires_at: 1 })) });
    }
    return reply(404, {});
  };
  return { fetchImpl, seen, approve: () => { approved = true; }, polls: () => polls };
}

test('state lives in its own 0600 file, holds no secret, and the install id is stable', () => {
  const paths = tempPaths();
  const id = ensureInstallId(paths);
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.equal(ensureInstallId(paths), id);
  assert.equal(statSync(pairingStatePath(paths)).mode & 0o777, 0o600);
  writeFileSync(pairingStatePath(paths), JSON.stringify({ schema: 1, crm: 'orosolu', want: true }));
  assert.equal(readPairingState(paths), null, 'a pairing for another CRM is ignored');
});

test('only a Ronin install asks to pair, and it stays quiet once paired or declined', () => {
  const kc = fakeKeychain();
  const plain = tempPaths();
  assert.equal(pairingReason(plain, { run: kc.run }), null, 'a plain install (no office, no lock, nobody asked) never asks');
  markPairingWanted(plain);
  assert.match(pairingReason(plain, { run: kc.run }), /owner asked/);

  const office = tempPaths();
  setRoninDeskEnabled(office, true);
  assert.match(pairingReason(office, { run: kc.run }), /no Ronin key/);
  const handKeyed = fakeKeychain({ [slotKey('desk:kingmaker')]: `ronin_desk_${hex(64)}` });
  assert.equal(pairingReason(office, { run: handKeyed.run }), null, 'a Ronin install with a key saved by hand is left alone');

  writePairingState(office, { pairing_id: 'pair-0000-1111-2222', grants: ['desk:kingmaker', 'dnc-reader'] });
  assert.match(pairingReason(office, { run: handKeyed.run }), /missing/, 'a paired key missing from the Keychain asks again');
  const full = fakeKeychain({ [slotKey('desk:kingmaker')]: 'x', [slotKey('dnc-reader')]: 'y' });
  assert.equal(pairingReason(office, { run: full.run }), null);
  markNeedsRepair(office);
  assert.match(pairingReason(office, { run: full.run }), /stopped working/, 'a refused key asks again');
  writePairingState(office, { declined: true });
  assert.equal(pairingReason(office, { run: full.run }), null, 'after the owner tapped Deny it waits to be asked');
  markPairingWanted(office);
  assert.match(pairingReason(office, { run: full.run }), /stopped working/, 'asking again (the site link) clears the decline');
});

test('the hand-over is checked whole before anything is saved', () => {
  const ok = { status: 'approved', crm: 'ronininc', pairing_id: 'pair-0000-1111-2222', install_id: hex(32, 'b'), credentials: [{ grant: 'desk:kingmaker', token: `ronin_desk_${hex(64)}` }] };
  assert.equal(validateHandover(ok, hex(32, 'b')).credentials.length, 1);
  assert.throws(() => validateHandover(ok, hex(32, 'c')), /different Mac/);
  assert.throws(() => validateHandover({ ...ok, crm: 'orosolu' }, hex(32, 'b')), /Ronin pairing/);
  assert.throws(() => validateHandover({ ...ok, credentials: [{ grant: 'desk:kingmaker', token: `ronin_admin_${hex(64)}` }] }, hex(32, 'b')), /expected shape/, 'a master token can never land in a desk slot');
  assert.throws(() => validateHandover({ ...ok, credentials: [{ grant: 'kingmaker-admin', token: `ronin_admin_${hex(64)}` }] }, hex(32, 'b')), /no key this Mac can use/, 'a key with no slot is never written');
});

test('keys go to security(1) on stdin, never argv', () => {
  const kc = fakeKeychain();
  const token = `ronin_dnc_${hex(64, 'e')}`;
  storeCredentials([{ grant: 'dnc-reader', token }], kc.run);
  storeDeskKey('grok-bot', `ronin_desk_${hex(64, 'f')}`, kc.run);
  assert.equal(kc.store.get(slotKey('dnc-reader')), token);
  assert.equal(kc.store.get(slotKey('desk:grok-bot')), `ronin_desk_${hex(64, 'f')}`);
  for (const call of kc.calls) assert.ok(!call.args.join(' ').includes('ronin_'), 'no key on argv');
  assert.throws(() => storeCredentials([{ grant: 'dnc-reader', token }], () => ({ status: 1 })), /Keychain/);
});

test('polling follows pending, slow_down and a network blip until the tap', async () => {
  const gaps = [];
  const crm = fakeCrm({ script: [{ body: { status: 'pending' } }, 'throw', { status: 429, body: { status: 'slow_down', interval: 10 } }] });
  let t = 0;
  const pending = waitForApproval({ deviceCode: `ronin_pairdev_${hex(64, 'd')}`, fetchImpl: crm.fetchImpl, now: () => t, sleep: async (ms) => { gaps.push(ms); t += ms; if (gaps.length === 4) crm.approve(); } });
  const result = await pending;
  assert.equal(result.status, 'approved');
  assert.deepEqual(gaps.slice(0, 4), [5000, 5000, 5000, 10000], 'slow_down widens the interval');
  for (const call of crm.seen) assert.ok(!call.url.includes('ronin_pairdev_'), 'the device code is never in a URL');
});

test('a denied or expired pairing ends with a reason and no keys', async () => {
  await assert.rejects(waitForApproval({ deviceCode: 'x', fetchImpl: fakeCrm({ deny: true }).fetchImpl, sleep: async () => {} }), (e) => e instanceof PairingEnded && e.status === 'denied');
  let t = 0;
  await assert.rejects(waitForApproval({ deviceCode: 'x', expiresIn: 12, fetchImpl: fakeCrm().fetchImpl, now: () => t, sleep: async (ms) => { t += ms; } }), (e) => e.status === 'expired');
});

test('end to end: the Mac shows a code, the owner taps, keys land in the Keychain, the office turns on', async () => {
  const paths = tempPaths();
  const kc = fakeKeychain();
  const crm = fakeCrm({ grants: ['desk:kingmaker', 'dnc-reader', 'owner-call-transport'] });
  const shown = []; const lines = [];
  const result = await runPairing({
    paths, version: '0.2.3', deviceName: 'Ana MacBook Air', run: kc.run, fetchImpl: crm.fetchImpl, log: (l) => lines.push(l),
    ui: { code: (c) => { shown.push(c); crm.approve(); } }, sleep: async () => {},
  });
  assert.equal(shown[0].userCode, 'BCDF-GHJK');
  assert.deepEqual(result.grants, ['desk:kingmaker', 'dnc-reader', 'owner-call-transport']);
  assert.match(kc.store.get(slotKey('desk:kingmaker')), /^ronin_desk_[0-9a-f]{64}$/);
  assert.match(kc.store.get(slotKey('owner-call-transport')), /^ronin_ownercall_/);
  assert.equal(readRoninDeskConfig(paths).enabled, true, 'the Kingmaker desk key turns the Ronin office on');
  const state = readPairingState(paths);
  assert.equal(state.pairing_id, 'pair-0000-1111-2222');
  const stateText = readFileSync(pairingStatePath(paths), 'utf8');
  assert.ok(!/ronin_(desk|dnc|ownercall|pairdev)_|BCDF/.test(stateText), 'the state file holds no key and no code');
  assert.ok(!lines.join('\n').match(/ronin_(desk|dnc|ownercall|pairdev)_|BCDF/), 'the log holds no key and no code');
  const start = crm.seen[0];
  assert.deepEqual(Object.keys(start.body).sort(), ['app_version', 'device_name', 'install_id', 'platform']);
  assert.deepEqual(pairingDockEnv(paths, 'kingmaker'), { RONIN_PAIRING_ID: 'pair-0000-1111-2222', RONIN_DEVICE_ID: state.install_id });
  assert.deepEqual(pairingDockEnv(paths, 'grok-bot'), {}, 'a desk this pairing did not hand out keeps its own identity');
  assert.equal(pairingReason(paths, { run: kc.run }), null, 'once paired it does not ask again');
});

test('keys for a different Mac are refused and nothing is saved', async () => {
  const paths = tempPaths();
  const kc = fakeKeychain();
  const crm = fakeCrm({ installIdFor: () => hex(32, 'f') });
  await assert.rejects(runPairing({ paths, deviceName: 'Mac', run: kc.run, fetchImpl: crm.fetchImpl, ui: { code: () => crm.approve() }, sleep: async () => {} }), /different Mac/);
  assert.equal(kc.store.size, 0);
  assert.equal(readRoninDeskConfig(paths).enabled, false);
});

test('Deny on the site quiets this Mac until it is asked again', async () => {
  const paths = tempPaths();
  markPairingWanted(paths);
  await assert.rejects(runPairing({ paths, deviceName: 'Mac', run: fakeKeychain().run, fetchImpl: fakeCrm({ deny: true }).fetchImpl, ui: { code: () => {} }, sleep: async () => {} }), /declined/);
  assert.equal(readPairingState(paths).declined, true);
  assert.equal(pairingReason(paths, { run: fakeKeychain().run }), null);
});

test('one pairing at a time: a second request joins the first', async () => {
  const paths = tempPaths();
  const crm = fakeCrm();
  const opts = { paths, deviceName: 'Mac', run: fakeKeychain().run, fetchImpl: crm.fetchImpl, ui: { code: () => crm.approve() }, sleep: async () => {} };
  const [a, b] = await Promise.all([pairWithRonin(opts), pairWithRonin(opts)]);
  assert.equal(a, b);
  assert.equal(crm.seen.filter((c) => c.url.endsWith('/start')).length, 1);
});

test('the code dialog goes to osascript on stdin and opens the private page; the code is never on argv', () => {
  const spawned = [];
  const spawnImpl = (cmd, args) => { const s = { cmd, args, input: '', stdin: { end: (v) => { s.input = v; } }, unref() {} }; spawned.push(s); return s; };
  showCodeOnMac({ userCode: 'BCDF-GHJK', expiresIn: 600, spawnImpl });
  assert.equal(spawned[0].cmd, '/usr/bin/osascript');
  assert.deepEqual(spawned[0].args, ['-']);
  assert.match(spawned[0].input, /BCDF-GHJK/);
  assert.deepEqual(spawned[1].args, [PAIR_PAGE]);
  assert.ok(spawned.every((s) => !s.args.join(' ').includes('BCDF')), 'no code on argv or in the URL');
  assert.ok(!codeDialogScript('BC"; do shell script "x', 60).includes('do shell'), 'a code cannot inject AppleScript');
});

test('a refused desk key (401) stops the dock and asks to pair again instead of retrying', async () => {
  let asked = 0; let docks = 0;
  const result = await maintainRoninDeskDock({ retryDelays: [1], log: () => {}, onUnauthorized: () => { asked += 1; }, dock: async () => { docks += 1; throw Object.assign(new Error('Ronin desk HTTP 401.'), { status: 401 }); } });
  assert.deepEqual(result, { ok: false, unauthorized: true });
  assert.equal(docks, 1);
  assert.equal(asked, 1);
});

test('owner-call setup asks only for the handle when the Mac was paired with its token', async () => {
  const paths = tempPaths();
  let askedToken = false;
  const saved = [];
  const run = (args, input) => { if (args[0] === '-i') saved.push(input); return { status: 0, stdout: '' }; };
  const code = await ownerCallCommand(['setup'], {
    paths, roninLocked: () => true, out: () => {}, err: () => {}, runSec: run,
    secrets: { handle: '', token: `ronin_ownercall_${hex(64)}` },
    readAnswer: async () => '+16025550100', readHidden: async () => { askedToken = true; return Buffer.from(''); },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, requests: [] }), text: async () => '{"ok":true,"requests":[]}' }),
  });
  assert.equal(code, 0);
  assert.equal(askedToken, false);
  assert.equal(saved.length, 2);
});
