// The issued-launcher ledger (lib/launcher-ledger.mjs): Kingmaker docks with any Ronin Launcher build that was issued,
// tells an older issued build from an altered one, and runs on its own when there is none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bundleFingerprint, classifyLauncher, currentEntry, dockStatus, isAppStoreCopy, LEDGER_SCHEMA, ledgerExtends,
  ledgerProblems, mayDock, readLedger,
} from '../lib/launcher-ledger.mjs';
import { launcherProblems } from '../lib/release-manifest.mjs';
import { main as ledgerTool } from '../scripts/launcher-ledger.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'km-ledger-'));
const hex = (c) => c.repeat(64);

/** A stand-in Ronin Launcher.app: the three things the fingerprint reads, plus a resource. */
function fakeApp(dir, { code = 'launcher code v1', resources = 'seal of resources v1', appStore = false } = {}) {
  const app = join(dir, 'Ronin Launcher.app');
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
  mkdirSync(join(app, 'Contents', '_CodeSignature'), { recursive: true });
  writeFileSync(join(app, 'Contents', 'Info.plist'), '<plist><dict><key>CFBundleIdentifier</key><string>com.ronininc.ronin-launcher</string></dict></plist>');
  writeFileSync(join(app, 'Contents', '_CodeSignature', 'CodeResources'), resources);
  writeFileSync(join(app, 'Contents', 'MacOS', 'Ronin Launcher'), code);
  if (appStore) { mkdirSync(join(app, 'Contents', '_MASReceipt'), { recursive: true }); writeFileSync(join(app, 'Contents', '_MASReceipt', 'receipt'), 'r'); }
  return app;
}
const entry = (over) => ({ version: '0.3.15', channel: 'direct', issuedAt: '2026-11-06T00:00:00Z', ...over });
const ledgerOf = (...entries) => ({ schema: LEDGER_SCHEMA, entries });

test('an issued build is told apart from an altered one: current, issued, revoked, unknown', () => {
  const ledger = ledgerOf(
    entry({ version: '0.3.14', archiveSha256: hex('a'), bundleSha256: hex('1') }),
    entry({ version: '0.3.15', archiveSha256: hex('b'), bundleSha256: hex('2') }),
    entry({ version: '0.3.13', archiveSha256: hex('c'), revoked: { at: '2026-11-08T00:00:00Z', reason: 'shipped the old verifier' } }),
  );
  assert.deepEqual(ledgerProblems(ledger), []);
  assert.equal(currentEntry(ledger).version, '0.3.15', 'current is the newest build that is not revoked');
  assert.equal(classifyLauncher(ledger, { archiveSha256: hex('b') }).verdict, 'current');
  const old = classifyLauncher(ledger, { bundleSha256: hex('1') });
  assert.equal(old.verdict, 'issued', 'an older listed build is issued, not unknown');
  assert.match(old.why, /earlier issued build \(current is 0\.3\.15\)/);
  assert.equal(classifyLauncher(ledger, { archiveSha256: hex('c') }).verdict, 'revoked');
  const altered = classifyLauncher(ledger, { bundleSha256: hex('9') });
  assert.equal(altered.verdict, 'unknown', 'a fingerprint not on the list is never called old');
  assert.equal(altered.entry, null);
  assert.equal(classifyLauncher(ledger, {}).verdict, 'unknown', 'no fingerprint is not a pass');
  assert.equal(classifyLauncher(ledger, { archiveSha256: 'not-a-hash' }).verdict, 'unknown');
  assert.equal(classifyLauncher(ledger, { archiveSha256: hex('B') }).verdict, 'current', 'hex case does not matter');
  assert.equal(classifyLauncher(ledger, { archiveSha256: hex('a'), bundleSha256: hex('2') }).verdict, 'unknown', 'an archive of one build with the bundle of another is not one build');
  assert.deepEqual(['current', 'issued', 'revoked', 'unknown'].map(mayDock), [true, true, false, false]);
  assert.equal(classifyLauncher(ledgerOf(), { archiveSha256: hex('a') }).verdict, 'unknown', 'an empty list vouches for nothing');
});

test('the ledger only grows: an entry is never edited or removed, and a revocation is never lifted', () => {
  const a = entry({ version: '0.3.14', archiveSha256: hex('a') });
  const b = entry({ version: '0.3.15', archiveSha256: hex('b') });
  const before = ledgerOf(a);
  assert.equal(ledgerExtends(before, ledgerOf(a, b)).ok, true, 'appending is growth');
  const revoked = { ...a, revoked: { at: '2026-11-09T00:00:00Z', reason: 'withdrawn' } };
  assert.equal(ledgerExtends(before, ledgerOf(revoked, b)).ok, true, 'marking an entry revoked is allowed');
  assert.match(ledgerExtends(before, ledgerOf(b)).problems.join(' '), /edited/, 'replacing an entry');
  assert.match(ledgerExtends(ledgerOf(a, b), ledgerOf(a)).problems.join(' '), /never removed/);
  assert.match(ledgerExtends(before, ledgerOf({ ...a, archiveSha256: hex('f') })).problems.join(' '), /edited/, 'swapping the fingerprint of an issued build');
  assert.match(ledgerExtends(ledgerOf(revoked), ledgerOf(a)).problems.join(' '), /revocation was lifted/);
  assert.match(ledgerExtends(ledgerOf(revoked), ledgerOf({ ...a, revoked: { at: revoked.revoked.at, reason: 'never mind' } })).problems.join(' '), /lifted or reworded/);
});

test('an unsound ledger is refused by name', () => {
  const bad = (e) => ledgerProblems(ledgerOf(e)).join(' ');
  assert.match(ledgerProblems({ schema: 'other', entries: [] }).join(' '), /schema must be/);
  assert.match(bad(entry({})), /carries no fingerprint/);
  assert.match(bad(entry({ archiveSha256: 'ABC' })), /not a lowercase sha256/);
  assert.match(bad(entry({ archiveSha256: hex('a'), channel: 'sideload' })), /channel must be/);
  assert.match(bad(entry({ archiveSha256: hex('a'), issuedAt: 'yesterday' })), /issuedAt is not a date/);
  assert.match(bad(entry({ channel: 'app-store', archiveSha256: hex('a'), bundleSha256: hex('b') })), /App Store copy has no release archive/);
  assert.match(bad(entry({ archiveSha256: hex('a'), revoked: true })), /revoked must be/);
  assert.match(ledgerProblems(ledgerOf(entry({ archiveSha256: hex('a') }), entry({ version: '0.3.16', bundleSha256: hex('a') }))).join(' '), /repeats entry 1/, 'one fingerprint, one build');
});

test('an installed launcher is fingerprinted by its code and its resource seal; any change is a different build', () => {
  const d = tmp();
  const app = fakeApp(d);
  const fp = bundleFingerprint(app);
  assert.match(fp, /^[0-9a-f]{64}$/);
  const copy = join(tmp(), 'Ronin Launcher.app'); cpSync(app, copy, { recursive: true });
  assert.equal(bundleFingerprint(copy), fp, 'the same bundle elsewhere has the same fingerprint');
  assert.notEqual(bundleFingerprint(fakeApp(tmp(), { code: 'launcher code v1 + injected' })), fp, 'changed code');
  assert.notEqual(bundleFingerprint(fakeApp(tmp(), { resources: 'seal of resources v2' })), fp, 'changed resource seal');
  const extra = fakeApp(tmp()); writeFileSync(join(extra, 'Contents', 'MacOS', 'helper'), 'dropped in');
  assert.notEqual(bundleFingerprint(extra), fp, 'an executable added beside the real one');
  assert.equal(bundleFingerprint(tmp()), null, 'not an app bundle');
  // A resource changed while the signature's own list of hashes is left as it was is still a different build.
  const withRes = (text) => { const a2 = fakeApp(tmp()); mkdirSync(join(a2, 'Contents', 'Resources'), { recursive: true }); writeFileSync(join(a2, 'Contents', 'Resources', 'config.json'), text); return a2; };
  const sealed = withRes('{"server":"real"}');
  assert.notEqual(bundleFingerprint(sealed), fp, 'a resource is part of the fingerprint');
  assert.notEqual(bundleFingerprint(withRes('{"server":"changed"}')), bundleFingerprint(sealed), 'an altered resource under an untouched seal');
  assert.equal(bundleFingerprint(withRes('{"server":"real"}')), bundleFingerprint(sealed));
  // The Mac App Store receipt differs for every buyer, so it is not part of the build's fingerprint.
  assert.equal(bundleFingerprint(fakeApp(tmp(), { appStore: true })), fp);
  assert.equal(isAppStoreCopy(app), false);
  assert.equal(isAppStoreCopy(fakeApp(tmp(), { appStore: true })), true);
});

test('docking: none, issued, older issued, altered, revoked, and a channel that does not match its listing', () => {
  const genuine = fakeApp(tmp());
  const older = fakeApp(tmp(), { code: 'launcher code v0' });
  const store = fakeApp(tmp(), { code: 'launcher code as Apple re-signed it', appStore: true });
  const ledger = ledgerOf(
    entry({ version: '0.3.14', bundleSha256: bundleFingerprint(older) }),
    entry({ version: '0.3.15', channel: 'app-store', issuedAt: '2026-11-07T00:00:00Z', bundleSha256: bundleFingerprint(store) }),
    entry({ version: '0.3.15', issuedAt: '2026-11-08T00:00:00Z', bundleSha256: bundleFingerprint(genuine) }),
  );
  const none = dockStatus(join(tmp(), 'Ronin Launcher.app'), ledger);
  assert.deepEqual([none.present, none.docked], [false, false]);
  assert.match(none.why, /runs on its own/);
  assert.deepEqual([dockStatus(genuine, ledger).verdict, dockStatus(genuine, ledger).docked], ['current', true]);
  assert.deepEqual([dockStatus(older, ledger).verdict, dockStatus(older, ledger).docked], ['issued', true], 'an older issued build still docks');
  const viaStore = dockStatus(store, ledger);
  assert.deepEqual([viaStore.verdict, viaStore.channel, viaStore.docked], ['issued', 'app-store', true], 'the App Store copy docks by its own fingerprint');
  const injected = fakeApp(tmp(), { code: 'launcher code v1\nfetch("https://evil.example/x")' });
  const alt = dockStatus(injected, ledger);
  assert.deepEqual([alt.present, alt.verdict, alt.docked], [true, 'unknown', false], 'an altered build is unknown, never "old"');
  assert.match(alt.why, /not on the list of issued Ronin Launcher builds.*stays undocked/);
  // The genuine direct build with a receipt dropped into it: the fingerprint is listed, but not for this channel.
  const dressed = join(tmp(), 'Ronin Launcher.app'); cpSync(genuine, dressed, { recursive: true });
  mkdirSync(join(dressed, 'Contents', '_MASReceipt'), { recursive: true }); writeFileSync(join(dressed, 'Contents', '_MASReceipt', 'receipt'), 'r');
  assert.deepEqual([dockStatus(dressed, ledger).verdict, dockStatus(dressed, ledger).docked], ['unknown', false]);
  const withdrawn = ledgerOf({ ...ledger.entries[2], revoked: { at: '2026-11-09T00:00:00Z', reason: 'withdrawn' } });
  assert.deepEqual([dockStatus(genuine, withdrawn).verdict, dockStatus(genuine, withdrawn).docked], ['revoked', false]);
});

test('a release manifest may carry the list, and then it must list its own launcher', () => {
  const pin = { name: 'Ronin Launcher.app', archive: 'Ronin-Launcher-0.3.15.zip', format: 'zip', sha256: hex('b'), size: 1000, url: null, required: true };
  assert.deepEqual(launcherProblems(pin, { required: true }), [], 'a manifest without the list reads as before');
  const listed = [entry({ version: '0.3.14', archiveSha256: hex('a') }), entry({ archiveSha256: hex('b') })];
  assert.deepEqual(launcherProblems({ ...pin, issued: listed }, { required: true }), []);
  assert.match(launcherProblems({ ...pin, issued: [listed[0]] }, { required: true }).join(' '), /does not list this release's own launcher archive/);
  assert.match(launcherProblems({ ...pin, issued: [{ ...listed[1], revoked: { at: '2026-11-09T00:00:00Z', reason: 'x' } }] }, { required: true }).join(' '), /own launcher as revoked/);
  assert.match(launcherProblems({ ...pin, issued: [entry({})] }, { required: true }).join(' '), /launcher\.issued: entry 1 carries no fingerprint/);
});

test('the owner tool appends and revokes, and refuses anything else', () => {
  const d = tmp();
  const file = join(d, 'launcher-issued.json');
  writeFileSync(file, JSON.stringify(ledgerOf()));
  const out = []; const io = { file, print: (l) => out.push(l), now: () => '2026-11-10T00:00:00.000Z' };
  const zip = join(d, 'Ronin-Launcher.zip'); writeFileSync(zip, 'zip bytes');
  const app = fakeApp(d);
  assert.equal(ledgerTool(['add', '--version', '0.3.15', '--zip', zip, '--app', app], io), 0, out.join('\n'));
  const store = fakeApp(tmp(), { code: 'as delivered by the store', appStore: true });
  assert.equal(ledgerTool(['add', '--version', '0.3.15', '--app', store, '--note', 'the copy the App Store delivers'], io), 0, out.join('\n'));
  let now = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(now.entries.map((e) => e.channel), ['direct', 'app-store'], 'the App Store channel is read from the receipt');
  assert.equal(now.entries[0].bundleSha256, bundleFingerprint(app));
  assert.equal(ledgerTool(['add', '--version', '0.3.15', '--zip', zip], io), 1, 'the same archive cannot be listed twice');
  assert.equal(ledgerTool(['check', '--app', app], io), 0);
  assert.equal(ledgerTool(['check', '--app', fakeApp(tmp(), { code: 'altered' })], io), 1, 'an unlisted launcher fails the check');
  assert.equal(ledgerTool(['revoke', '--fingerprint', now.entries[0].archiveSha256, '--reason', 'withdrawn'], io), 0);
  assert.equal(ledgerTool(['revoke', '--fingerprint', now.entries[0].archiveSha256, '--reason', 'again'], io), 1, 'a revocation is not reworded');
  now = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(now.entries.length, 2, 'revoking removes nothing');
  assert.equal(ledgerTool(['check', '--app', app], io), 1, 'a revoked build no longer docks');
  assert.equal(ledgerTool(['add', '--version', '1', '--app', d], io), 1, 'a folder that is not an app bundle is refused');
});

test('the committed ledger is sound and only ever grew from what main has', () => {
  const ledger = readLedger();
  assert.deepEqual(ledgerProblems(ledger), []);
  // Against the base branch when git can show it (a fresh checkout, CI); skipped where it cannot.
  let base;
  try { base = JSON.parse(execFileSync('git', ['show', 'origin/main:lib/launcher-issued.json'], { cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'ignore'] }).toString()); } catch { return; }
  const grown = ledgerExtends(base, ledger);
  assert.equal(grown.ok, true, grown.problems.join('; '));
});

test('`kingmaker launcher` reports docking and never needs a launcher to run', () => {
  const bin = new URL('../bin/kingmaker', import.meta.url).pathname;
  const run = (app) => { try { return { code: 0, out: execFileSync(bin, ['launcher', '--json'], { env: { ...process.env, KINGMAKER_LAUNCHER_APP: app }, stdio: ['ignore', 'pipe', 'pipe'] }).toString() }; } catch (e) { return { code: e.status, out: String(e.stdout) }; } };
  const none = run(join(tmp(), 'Ronin Launcher.app'));
  assert.equal(none.code, 0, 'no launcher is not an error');
  assert.equal(JSON.parse(none.out).present, false);
  const unlisted = run(fakeApp(tmp()));
  assert.equal(unlisted.code, 1, 'a launcher that is not on the list is reported, exit 1');
  assert.deepEqual([JSON.parse(unlisted.out).verdict, JSON.parse(unlisted.out).docked], ['unknown', false]);
});

test('an install made without the launcher stays that way across an update', async () => {
  const { launcherChoiceArgs, LAUNCHER_CHOICE_FILE } = await import('../lib/update.mjs');
  const d = tmp();
  assert.deepEqual(launcherChoiceArgs(d), [], 'no recorded choice: the update installs as the release says');
  writeFileSync(join(d, LAUNCHER_CHOICE_FILE), 'without\n');
  assert.deepEqual(launcherChoiceArgs(d), ['--without-launcher']);
  writeFileSync(join(d, LAUNCHER_CHOICE_FILE), 'something else');
  assert.deepEqual(launcherChoiceArgs(d), []);
  const engine = readFileSync(new URL('../installer/engine.sh', import.meta.url), 'utf8');
  assert.match(engine, /LAUNCHER_CHOICE="\$DATA\/launcher-choice"/, 'the installer writes the same file the update reads');
  assert.match(engine, /printf 'without\\n' > "\$LAUNCHER_CHOICE"/);
});
