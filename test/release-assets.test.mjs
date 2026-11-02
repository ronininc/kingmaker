import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ARMOR_RELEASE_ASSETS, releaseAssetProblems, verifyPhysicalReleaseAssets } from '../lib/release-assets.mjs';

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

test('physical gate hashes every required asset and requires real signature and Armor verifiers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kingmaker-release-assets-'));
  const part = Buffer.from('part-bytes!!'), launcher = Buffer.from('launcher!!!');
  const m = { ...manifest, app: { ...manifest.app, size: part.length, sha256: (await import('node:crypto')).createHash('sha256').update(part).digest('hex') }, parts: [{ name: manifest.parts[0].name, size: part.length, sha256: (await import('node:crypto')).createHash('sha256').update(part).digest('hex') }], launcher: { ...manifest.launcher, size: launcher.length, sha256: (await import('node:crypto')).createHash('sha256').update(launcher).digest('hex') } };
  const mp = join(dir, 'kingmaker-manifest.json'), dmg = join(dir, 'Kingmaker-Installer-v4.4.2.dmg');
  writeFileSync(mp, JSON.stringify(m)); writeFileSync(`${mp}.sig`, 'fixture-signature');
  writeFileSync(join(dir, m.parts[0].name), part); writeFileSync(join(dir, m.launcher.archive), launcher); writeFileSync(dmg, 'dmg');
  for (const name of ARMOR_RELEASE_ASSETS) writeFileSync(join(dir, name), `fixture:${name}`);
  assert.equal((await verifyPhysicalReleaseAssets({ manifestPath: mp, assetsDir: dir, installerDmg: dmg, verifySignature: () => true, verifyArmor: async () => true })).ok, true);
  writeFileSync(join(dir, m.parts[0].name), 'tampered');
  assert.match((await verifyPhysicalReleaseAssets({ manifestPath: mp, assetsDir: dir, installerDmg: dmg, verifySignature: () => true, verifyArmor: async () => true })).problems.join('\n'), /bytes do not match/);
  writeFileSync(join(dir, m.parts[0].name), part); writeFileSync(join(dir, ARMOR_RELEASE_ASSETS[0]), 'changed');
  assert.match((await verifyPhysicalReleaseAssets({ manifestPath: mp, assetsDir: dir, installerDmg: dmg, verifySignature: () => false, verifyArmor: async () => false })).problems.join('\n'), /signature does not verify|cryptographic verification failed/);
  assert.match((await verifyPhysicalReleaseAssets({ manifestPath: mp, assetsDir: dir, installerDmg: dmg, verifySignature: () => true })).problems.join('\n'), /governed verifier unavailable/);
  writeFileSync(join(dir, ARMOR_RELEASE_ASSETS[0]), 'real');
  unlinkSync(join(dir, m.parts[0].name)); symlinkSync(mp, join(dir, m.parts[0].name));
  assert.match((await verifyPhysicalReleaseAssets({ manifestPath: mp, assetsDir: dir, installerDmg: dmg, verifySignature: () => true, verifyArmor: async () => true })).problems.join('\n'), /not a regular non-symlink file/);
});
