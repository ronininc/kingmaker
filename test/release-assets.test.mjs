import test from 'node:test';
import assert from 'node:assert/strict';
import { ARMOR_RELEASE_ASSETS, releaseAssetProblems } from '../lib/release-assets.mjs';

const h = 'a'.repeat(64);
const manifest = {
  schema: 'kingmaker.release/1', product: 'Kingmaker', repo: 'ronininc/kingmaker', tag: 'v4.4.2', version: '4.4.2',
  app: { name: 'Kingmaker.app', bundleId: 'com.ronininc.solghost', size: 12, sha256: h },
  parts: [{ name: 'Kingmaker-v4.4.2.part01', size: 12, sha256: h }],
  launcher: { name: 'Ronin Launcher.app', archive: 'Ronin-Launcher.zip', format: 'zip', sha256: h, size: 12, required: true, url: null },
};
const complete = ['kingmaker-manifest.json', 'kingmaker-manifest.json.sig', 'Kingmaker-v4.4.2.part01', ...ARMOR_RELEASE_ASSETS];

test('production release requires archive pin, signature and complete Armor envelope', () => {
  assert.deepEqual(releaseAssetProblems({ manifest, assets: complete }), []);
  const legacy = { ...manifest, app: undefined, units: { macos: { sha256: h } } };
  assert.match(releaseAssetProblems({ manifest: legacy, assets: complete }).join('\n'), /app\.sha256/);
  assert.match(releaseAssetProblems({ manifest, assets: complete.filter((n) => n !== 'kingmaker-manifest.json.sig') }).join('\n'), /missing kingmaker-manifest\.json\.sig/);
});

test('partial Armor envelope is fatal and transitional absence is only explicit opt-in', () => {
  const partial = complete.filter((n) => !ARMOR_RELEASE_ASSETS.includes(n)).concat(ARMOR_RELEASE_ASSETS[0]);
  assert.match(releaseAssetProblems({ manifest, assets: partial }).join('\n'), /partial Scripture Armor envelope/);
  const unsealed = complete.filter((n) => !ARMOR_RELEASE_ASSETS.includes(n));
  assert.match(releaseAssetProblems({ manifest, assets: unsealed }).join('\n'), /missing mandatory Scripture Armor envelope/);
  assert.deepEqual(releaseAssetProblems({ manifest, assets: unsealed, requireArmor: false }), []);
});
