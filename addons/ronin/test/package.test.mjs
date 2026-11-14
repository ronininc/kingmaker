// The Ronin office add-on as Ronin Launcher delivers it: packed by addons/build-addon.mjs, installed by Kingmaker's own
// `addons install` path (lib/addons.mjs installAddon) and loaded by loadAddons → register(host). Signature and
// entitlement verifiers are stand-ins here (lib/addons.mjs and its tests own those gates).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAddon } from '../../build-addon.mjs';
import * as core from '../../../lib/addons.mjs';
import { ADDON_CORE } from '../../../lib/addon-core.mjs';

const yes = async () => true;
const REQ = { kingmaker: '0.2.6', launcher: '0.3.0', arch: 'arm64' };

test('packed, installed and loaded the way a customer gets it, the add-on runs without one core import by path', async () => {
  const out = mkdtempSync(join(tmpdir(), 'km-ronin-pack-'));
  const { manifest, archivePath } = buildAddon('ronin', { out, version: '0.2.6' });
  assert.equal(manifest.id, 'ronin-office'); assert.equal(manifest.paid, true); assert.equal(manifest.sku, 'addon.ronin-office');
  assert.ok(!manifest.files.some((f) => /^(test|docs|scripts)\/|README|addon\.json/.test(f.path)), 'no tests, docs, scripts or descriptor ship');
  // What the launcher hands over: the zip's files and the manifest, in one folder.
  const staged = mkdtempSync(join(tmpdir(), 'km-ronin-staged-'));
  execFileSync('unzip', ['-q', archivePath, '-d', staged]);
  writeFileSync(join(staged, 'manifest.json'), readFileSync(join(out, 'ronin-office', 'manifest.json')));
  for (const f of readdirSync(staged).filter((n) => n.endsWith('.mjs'))) assert.doesNotMatch(readFileSync(join(staged, f), 'utf8'), /from '\.\.\/\.\.\/lib\//, `${f} imports core by path`);

  const root = mkdtempSync(join(tmpdir(), 'km-addons-root-'));
  const r = await core.installAddon({ stagedDir: staged, root, entitlement: { payload: '{}', sig: 'x', alg: 'ES256' }, requires: REQ, verifyManifest: yes, verifyEntitlement: yes });
  assert.deepEqual(r, { id: 'ronin-office', version: '0.2.6' });

  core.forgetAddons();
  assert.equal(core.ronin, null, 'the free edition until it loads');
  const events = [];
  const host = core.makeHost({ version: '0.2.6', paths: join(root, 'data'), log: (e, d) => events.push([e, d]), services: { lib: ADDON_CORE } });
  await core.loadAddons(host, { root, requires: REQ, entitlementFor: () => ({}), verifyManifest: yes, verifyEntitlement: yes, log: (e, d) => events.push([e, d]) });
  assert.ok(core.ronin, `exposed itself as ronin (${JSON.stringify(events)})`);
  assert.equal(typeof core.ronin.roninCommand, 'function');
  assert.equal(core.ronin.isStopApproving('stop approving'), true, 'its kill switch is the core\'s, handed over');
  assert.equal(core.ronin.activeCrmLock({ state: join(root, 'nothing') }), null);
  core.forgetAddons();
});

test('without its core handed over, the add-on refuses to start rather than half-run', async () => {
  const { register } = await import('../index.mjs');
  await assert.rejects(register({ services: {}, expose: () => {} }), /did not hand this add-on/);
});
