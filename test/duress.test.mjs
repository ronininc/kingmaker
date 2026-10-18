import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDuress, defaultDuressState, footprintPaths, KEYCHAIN_ITEMS, BUNDLE_ID, safeToShred, liveDuressDeps } from '../lib/duress.mjs';

function place() {
  const state = mkdtempSync(join(tmpdir(), 'km-duress-'));
  return { state, audit: () => (existsSync(join(state, 'duress-audit.jsonl')) ? readFileSync(join(state, 'duress-audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []), done: () => rmSync(state, { recursive: true, force: true }) };
}
// A supervisor whose every REAL effect is a recording stub — nothing is ever deleted. `calls` logs the order.
function make(p, over = {}) {
  const calls = [];
  const d = createDuress({
    state: p.state, home: '/Users/nobody', app: '/Applications/Kingmaker.app',
    exportCsv: async (x) => { calls.push('export'); return { ok: true, where: x.cloud }; },
    destroyKeys: async (items) => { calls.push('keys'); return { ok: true, removed: items.length }; },
    shred: async (paths) => { calls.push('shred'); return { ok: true, count: paths.length }; },
    removeApp: async (path) => { calls.push('app'); return { ok: true, path }; },
    makeCsv: () => 'a,b\n1,2\n',
    ...over,
  });
  return { d, calls };
}

test('ships DISARMED and safe: off, no credential', () => {
  const s = defaultDuressState();
  assert.equal(s.armed, false);
  assert.equal(s.hash, null);
  assert.equal(s.salt, null);
});

test('panic does nothing while disarmed', async () => {
  const p = place();
  try {
    const { d, calls } = make(p);
    const r = await d.panic({ password: 'anything' });
    assert.equal(r.fired, false);
    assert.equal(r.reason, 'disarmed');
    assert.deepEqual(calls, [], 'no wipe step ran');
  } finally { p.done(); }
});

test('arming needs the literal WIPE confirm and a distinct 10+ char password', () => {
  const p = place();
  try {
    const { d } = make(p);
    assert.match(d.arm({ password: 'longenough' }).reason, /WIPE/);
    assert.match(d.arm({ password: 'short', confirm: 'WIPE' }).reason, /10\+/);
    assert.match(d.arm({ password: 'ninechars', confirm: 'WIPE' }).reason, /10\+/, '9 characters is refused');
    assert.equal(d.arm({ password: 'tencharsok', confirm: 'WIPE' }).ok, true, '10 characters is accepted');
    assert.equal(d.arm({ password: 'duress-pass', confirm: 'WIPE' }).ok, true);
    assert.equal(d.status().armed, true);
  } finally { p.done(); }
});

test('the panic fires ONLY on the exact duress credential (a mistyped/normal password never fires)', async () => {
  const p = place();
  try {
    const { d, calls } = make(p);
    d.arm({ password: 'the-duress-one', cloud: 'drive', confirm: 'WIPE' });
    assert.equal((await d.panic({ password: 'wrong' })).reason, 'not-the-duress-credential');
    assert.equal((await d.panic({ password: 'the-duress-on' })).reason, 'not-the-duress-credential'); // near miss
    assert.deepEqual(calls, [], 'nothing wiped on a wrong credential');
    assert.equal(d.isDuress('the-duress-one'), true);
    assert.equal(d.isDuress('wrong'), false);
    const r = await d.panic({ password: 'the-duress-one' });
    assert.equal(r.fired, true);
  } finally { p.done(); }
});

test('the sequence is export → keys → shred → app, with the crypto keys destroyed BEFORE the files', async () => {
  const p = place();
  try {
    const { d, calls } = make(p);
    d.arm({ password: 'duress-pass', cloud: 'icloud', confirm: 'WIPE' });
    const r = await d.panic({ password: 'duress-pass' });
    assert.equal(r.fired, true);
    assert.deepEqual(calls, ['export', 'keys', 'shred', 'app']);
    assert.ok(calls.indexOf('keys') < calls.indexOf('shred'), 'keys crypto-erased before the files, so sealed data is already unrecoverable');
    assert.equal(r.steps.export.ok, true);
    assert.equal(r.steps.keys.removed, KEYCHAIN_ITEMS.length);
  } finally { p.done(); }
});

test('the wipe proceeds even if the CSV export fails (the export is best-effort, the wipe is the point)', async () => {
  const p = place();
  try {
    const { d, calls } = make(p, { exportCsv: async () => { throw new Error('offline'); } });
    d.arm({ password: 'duress-pass', confirm: 'WIPE' });
    const r = await d.panic({ password: 'duress-pass' });
    assert.equal(r.fired, true);
    assert.equal(r.steps.export.ok, false);
    assert.deepEqual(calls, ['keys', 'shred', 'app'], 'export threw but the keys, files and app were still wiped');
  } finally { p.done(); }
});

test('a required Touch-ID gate blocks the panic until it passes', async () => {
  const p = place();
  try {
    let allow = false;
    const { d, calls } = make(p, { touchId: async () => allow });
    d.arm({ password: 'duress-pass', requireTouchId: true, confirm: 'WIPE' });
    assert.equal((await d.panic({ password: 'duress-pass' })).reason, 'touch-id-required');
    assert.deepEqual(calls, []);
    // viaFingerprint short-circuits the gate (the phone/Touch-ID path already authenticated).
    assert.equal((await d.panic({ password: 'duress-pass', viaFingerprint: true })).fired, true);
    allow = true; // and once Touch ID allows, the gate passes on the password alone
    assert.equal((await d.panic({ password: 'duress-pass' })).fired, true);
  } finally { p.done(); }
});

test('footprintPaths covers the data home, prefs and the app bundle', () => {
  const fp = footprintPaths({ home: '/Users/x', app: '/Applications/Kingmaker.app' });
  assert.ok(fp.data.some((p) => p.endsWith('Application Support/sol-ghost')));
  assert.ok(fp.data.some((p) => p.includes(`Preferences/${BUNDLE_ID}.plist`)));
  assert.equal(fp.app, '/Applications/Kingmaker.app');
});

test('safeToShred refuses dangerous roots and unmarked paths, allows only Kingmaker-marked ones', () => {
  const home = '/Users/x';
  for (const bad of ['/', '/Users', '/Applications', '/System', '/Library', home, `${home}/Library`, `${home}/Documents`, `${home}/Pictures`, `${home}/Documents/taxes`, `${home}/Desktop/photo.jpg`, '']) {
    assert.equal(safeToShred(bad, { home }), false, `must refuse ${bad}`);
  }
  for (const ok of [`${home}/Library/Application Support/sol-ghost`, `${home}/Library/Preferences/${BUNDLE_ID}.plist`, `${home}/Library/Caches/${BUNDLE_ID}`, `${home}/Documents/Kingmaker`, '/Applications/Kingmaker.app']) {
    assert.equal(safeToShred(ok, { home }), true, `must allow ${ok}`);
  }
  // every real footprint entry is shred-safe
  for (const p of footprintPaths({ home, app: '/Applications/Kingmaker.app' }).data) assert.equal(safeToShred(p, { home }), true, p);
});

test('the live wipe REFUSES to run from a source checkout (no installed bundle): nothing can delete in dev/CI', async () => {
  // Tests run from the repo, not an installed Kingmaker.app, so appBundleOf() is null → every live wiper throws.
  const live = liveDuressDeps({ home: '/Users/nobody' });
  await assert.rejects(() => live.destroyKeys(KEYCHAIN_ITEMS), /source checkout/);
  await assert.rejects(() => live.shred(['/Users/nobody/Library/Application Support/sol-ghost']), /source checkout/);
  await assert.rejects(() => live.removeApp('/Applications/Kingmaker.app'), /source checkout/);
  assert.equal((await live.exportCsv({ csv: 'x', cloud: null })).ok, false); // export has no cloud wired → no-op
});

test('disarm clears the credential; then the panic is inert again', async () => {
  const p = place();
  try {
    const { d, calls } = make(p);
    d.arm({ password: 'duress-pass', confirm: 'WIPE' });
    d.disarm();
    assert.equal(d.status().armed, false);
    assert.equal(d.isDuress('duress-pass'), false);
    assert.equal((await d.panic({ password: 'duress-pass' })).reason, 'disarmed');
    assert.deepEqual(calls, []);
  } finally { p.done(); }
});

test('drill mode runs the whole sequence (against the caller\'s stubs) and is tagged, so a rehearsal proves the wiring', async () => {
  const p = place();
  try {
    const { d, calls } = make(p);
    d.arm({ password: 'duress-pass', mode: 'drill', confirm: 'WIPE' });
    const r = await d.panic({ password: 'duress-pass' });
    assert.equal(r.fired, true);
    assert.equal(r.mode, 'drill');
    assert.deepEqual(calls, ['export', 'keys', 'shred', 'app']);
    const events = p.audit().map((e) => e.event);
    for (const w of ['arm', 'panic_start', 'export', 'keys_destroyed', 'shred', 'app_removed', 'panic_done']) assert.ok(events.includes(w), `audit has ${w}`);
  } finally { p.done(); }
});

test('the wipe takes the credentials vault too, and a live wipe writes nothing after the shred', async () => {
  const fp = footprintPaths({ home: '/Users/nobody' });
  assert.ok(fp.data.includes('/Users/nobody/.solomon-secure'));
  assert.equal(safeToShred('/Users/nobody/.solomon-secure', { home: '/Users/nobody' }), true);
  assert.equal(safeToShred('/Users/nobody/.ssh', { home: '/Users/nobody' }), false);
  const p = place();
  try {
    const { d } = make(p, { shred: async () => { rmSync(p.state, { recursive: true, force: true }); return { ok: true }; } });
    d.arm({ password: 'duress pass 1', confirm: 'WIPE' });
    const r = await d.panic({ password: 'duress pass 1' });
    assert.equal(r.fired, true);
    assert.equal(existsSync(p.state), false, 'nothing recreated the state folder after the shred');
  } finally { p.done(); }
});

test('the bar\'s :duress arm keeps a password with spaces whole', async () => {
  const { createBarGuard } = await import('../lib/bar-guard.mjs');
  const p = place();
  try {
    const d = createDuress({ state: p.state });
    const g = createBarGuard({ duress: d, isStopApproving: () => false, isStopForwarding: () => false });
    await g.handle(':duress arm my secret phrase WIPE');
    assert.equal(d.isDuress('my secret phrase'), true);
    assert.equal(d.isDuress('my secret'), false);
  } finally { p.done(); }
});
