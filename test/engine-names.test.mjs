// Kingmaker's names inside its own app from 0.3.0 (Contents/MacOS/KingmakerEngine, Resources/kingmaker-runtime), with an
// app built before 0.3.0 (the older names) still run; and the release refuses an app that still carries the older names,
// web files Kingmaker never serves, or source maps of the engine's own code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LEGACY_RUNTIME_BINARY, LEGACY_RUNTIME_DIR, RUNTIME_BINARY, RUNTIME_DIR, resolvePaths, runtimeBinaryOf, runtimeDirOf } from '../lib/paths.mjs';
import { runtimesFor } from '../lib/extensions.mjs';
import { engineSourceMaps, inspectApp, searxngPin } from '../scripts/release-parts.mjs';
import { makeFixtureApp } from './fixtures/installer-fixtures.mjs';

const APP = '/Applications/Kingmaker.app';
const inApp = (names) => (p) => names.some((n) => p === join(APP, n));
const modulePath = join(APP, 'Contents', 'Resources', 'sol-ghost', 'lib', 'paths.mjs');

test('the new names first, the older ones still run (an app built before 0.3.0)', () => {
  assert.equal(RUNTIME_BINARY, 'KingmakerEngine'); assert.equal(RUNTIME_DIR, 'kingmaker-runtime');
  const fresh = resolvePaths({ SOL_GHOST_HOME: '/tmp/sg' }, '/Users/o', { modulePath, exists: inApp(['Contents/MacOS/KingmakerEngine', 'Contents/Resources/kingmaker-runtime']) });
  assert.equal(fresh.runtimeSource, 'bundle'); assert.equal(fresh.binary, join(APP, 'Contents/MacOS/KingmakerEngine'));
  assert.equal(fresh.runtimeDir, join(APP, 'Contents/Resources/kingmaker-runtime'));
  assert.equal(fresh.buildStamp, join(APP, 'Contents/Resources/kingmaker-runtime/solomon-build.json'));
  const older = resolvePaths({ SOL_GHOST_HOME: '/tmp/sg' }, '/Users/o', { modulePath, exists: inApp([`Contents/MacOS/${LEGACY_RUNTIME_BINARY}`, `Contents/Resources/${LEGACY_RUNTIME_DIR}`]) });
  assert.equal(older.runtimeSource, 'bundle', 'an older app still runs its own engine');
  assert.equal(older.binary, join(APP, 'Contents/MacOS', LEGACY_RUNTIME_BINARY)); assert.equal(older.runtimeDir, join(APP, 'Contents/Resources', LEGACY_RUNTIME_DIR));
  assert.equal(runtimeBinaryOf(APP, () => false), join(APP, 'Contents/MacOS/KingmakerEngine'), 'neither there: the new name');
  assert.equal(runtimeDirOf(join(APP, 'Contents/Resources'), () => false), join(APP, 'Contents/Resources/kingmaker-runtime'));
  assert.equal(runtimesFor({ appRoot: APP, env: {}, exists: inApp(['Contents/MacOS/KingmakerEngine']) }).node, join(APP, 'Contents/MacOS/KingmakerEngine'));
  assert.equal(runtimesFor({ appRoot: APP, env: {}, exists: inApp([`Contents/MacOS/${LEGACY_RUNTIME_BINARY}`]) }).node, join(APP, 'Contents/MacOS', LEGACY_RUNTIME_BINARY));
});

test('the SearXNG pin is read from the setup script, plain or minified', () => {
  const pin = '12f8b6515ca77c3c3bc1498584950ef5daca1433';
  assert.equal(searxngPin(`export const SEARXNG_PIN = '${pin}';`), pin);
  assert.equal(searxngPin(`var a=1;const x$="${pin}";export{x$ as SEARXNG_PIN,a as other};`), pin);
  assert.equal(searxngPin('export const OTHER = 1;'), null);
});

test('a release refuses older names, web files and source maps inside the app; node_modules maps are fine', { timeout: 60_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'km-names-'));
  try {
    const app = makeFixtureApp(dir, { version: '0.3.0' });
    const rt = join(app, 'Contents', 'Resources', 'kingmaker-runtime');
    mkdirSync(join(rt, 'server', 'node_modules', 'dep'), { recursive: true }); writeFileSync(join(rt, 'server', 'node_modules', 'dep', 'x.js.map'), '{}');
    assert.equal(inspectApp(app, { skipCodesign: true }).solomonBuild, 'fixture', 'clean: released, its engine build read from KingmakerEngineBuild');
    writeFileSync(join(rt, 'scripts', 'tool.mjs.map'), '{}');
    assert.deepEqual(engineSourceMaps(rt), ['scripts/tool.mjs.map']);
    assert.throws(() => inspectApp(app, { skipCodesign: true }), /scripts\/tool\.mjs\.map \(a source map\)/);
    rmSync(join(rt, 'scripts', 'tool.mjs.map'));
    mkdirSync(join(rt, 'app', 'dist'), { recursive: true });
    assert.throws(() => inspectApp(app, { skipCodesign: true }), /kingmaker-runtime\/app \(web files Kingmaker never serves\)/);
    rmSync(join(rt, 'app'), { recursive: true });
    mkdirSync(join(app, 'Contents', 'Resources', LEGACY_RUNTIME_DIR));
    writeFileSync(join(app, 'Contents', 'MacOS', LEGACY_RUNTIME_BINARY), '');
    assert.throws(() => inspectApp(app, { skipCodesign: true }), (e) => /the runtime folder is kingmaker-runtime/.test(e.message) && /the engine binary is KingmakerEngine/.test(e.message));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
