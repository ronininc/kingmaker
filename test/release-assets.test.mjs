import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ARMOR_RELEASE_ASSETS, releaseAssetProblems, verifyPhysicalReleaseAssets } from '../lib/release-assets.mjs';
import { finalizeInstallerRelease } from '../lib/installer-finalize.mjs';

const h = 'a'.repeat(64);
const manifest = {
  schema: 'kingmaker.release/1', product: 'Kingmaker', repo: 'ronininc/kingmaker', tag: 'v4.4.2', version: '4.4.2',
  app: { name: 'Kingmaker.app', bundleId: 'com.ronininc.solghost', size: 12, sha256: h },
  parts: [{ name: 'Kingmaker-v4.4.2.part01', size: 12, sha256: h }],
  launcher: { name: 'Ronin Launcher.app', archive: 'Ronin-Launcher.zip', format: 'zip', sha256: h, size: 12, required: true, url: null, sourceRepo: 'ronininc/ronin-launcher', sourceCommit: 'b'.repeat(40) },
};
const complete = ['kingmaker-manifest.json', 'kingmaker-manifest.json.sig', 'Kingmaker-v4.4.2.part01', ...ARMOR_RELEASE_ASSETS];

test('free release requires archive pin and signature while complete Armor remains valid', () => {
  assert.deepEqual(releaseAssetProblems({ manifest, assets: complete }), []);
  const legacy = { ...manifest, app: undefined, units: { macos: { sha256: h } } };
  assert.match(releaseAssetProblems({ manifest: legacy, assets: complete }).join('\n'), /app\.sha256/);
  assert.match(releaseAssetProblems({ manifest, assets: complete.filter((n) => n !== 'kingmaker-manifest.json.sig') }).join('\n'), /missing kingmaker-manifest\.json\.sig/);
});

test('free release may omit Armor but partial or explicitly-required Armor is fatal', () => {
  const partial = complete.filter((n) => !ARMOR_RELEASE_ASSETS.includes(n)).concat(ARMOR_RELEASE_ASSETS[0]);
  assert.match(releaseAssetProblems({ manifest, assets: partial }).join('\n'), /partial Scripture Armor envelope/);
  const unsealed = complete.filter((n) => !ARMOR_RELEASE_ASSETS.includes(n));
  assert.deepEqual(releaseAssetProblems({ manifest, assets: unsealed }), []);
  assert.match(releaseAssetProblems({ manifest, assets: unsealed, requireArmor: true }).join('\n'), /missing mandatory Scripture Armor envelope/);
});

test('physical gate hashes every required asset and requires real signature and Armor verifiers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kingmaker-release-assets-'));
  const part = Buffer.from('part-bytes!!'), launcher = Buffer.from('launcher!!!');
  const m = { ...manifest, app: { ...manifest.app, size: part.length, sha256: (await import('node:crypto')).createHash('sha256').update(part).digest('hex') }, parts: [{ name: manifest.parts[0].name, size: part.length, sha256: (await import('node:crypto')).createHash('sha256').update(part).digest('hex') }], launcher: { ...manifest.launcher, size: launcher.length, sha256: (await import('node:crypto')).createHash('sha256').update(launcher).digest('hex') } };
  const mp = join(dir, 'kingmaker-manifest.json'), dmg = join(dir, 'Kingmaker-Installer-v4.4.2.dmg');
  writeFileSync(mp, JSON.stringify(m)); writeFileSync(`${mp}.sig`, 'fixture-signature');
  writeFileSync(join(dir, m.parts[0].name), part); writeFileSync(join(dir, m.launcher.archive), launcher); writeFileSync(dmg, 'dmg');
  assert.equal((await verifyPhysicalReleaseAssets({ manifestPath: mp, assetsDir: dir, installerDmg: dmg, verifySignature: () => true })).ok, true);
  assert.match((await verifyPhysicalReleaseAssets({ manifestPath: mp, assetsDir: dir, installerDmg: dmg, requireArmor: true, verifySignature: () => true })).problems.join('\n'), /missing mandatory Scripture Armor envelope/);
  for (const name of ARMOR_RELEASE_ASSETS) writeFileSync(join(dir, name), `fixture:${name}`);
  assert.equal((await verifyPhysicalReleaseAssets({ manifestPath: mp, assetsDir: dir, installerDmg: dmg, verifySignature: () => true, verifyArmor: async () => true })).ok, true);
  writeFileSync(join(dir, m.parts[0].name), 'tampered');
  assert.match((await verifyPhysicalReleaseAssets({ manifestPath: mp, assetsDir: dir, installerDmg: dmg, verifySignature: () => true, verifyArmor: async () => true })).problems.join('\n'), /bytes do not match/);
  writeFileSync(join(dir, m.parts[0].name), part); writeFileSync(join(dir, ARMOR_RELEASE_ASSETS[0]), 'changed');
  assert.match((await verifyPhysicalReleaseAssets({ manifestPath: mp, assetsDir: dir, installerDmg: dmg, verifySignature: () => false, verifyArmor: async () => false })).problems.join('\n'), /signature does not verify|cryptographic verification failed/);
  assert.match((await verifyPhysicalReleaseAssets({ manifestPath: mp, assetsDir: dir, installerDmg: dmg, verifySignature: () => true })).problems.join('\n'), /governed verifier unavailable/);
  const wrongDmg = join(dir, 'Kingmaker-Installer-v9.9.9.dmg'); writeFileSync(wrongDmg, 'dmg');
  assert.match((await verifyPhysicalReleaseAssets({ manifestPath: mp, assetsDir: dir, installerDmg: wrongDmg, verifySignature: () => true, verifyArmor: async () => true })).problems.join('\n'), /expected Kingmaker-Installer-v4\.4\.2\.dmg/);
  writeFileSync(join(dir, ARMOR_RELEASE_ASSETS[0]), 'real');
  unlinkSync(join(dir, m.parts[0].name)); symlinkSync(mp, join(dir, m.parts[0].name));
  assert.match((await verifyPhysicalReleaseAssets({ manifestPath: mp, assetsDir: dir, installerDmg: dmg, verifySignature: () => true, verifyArmor: async () => true })).problems.join('\n'), /not a regular non-symlink file/);
});

test('mounted CLI and installer build entrypoints fail closed on unverified release assets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kingmaker-release-cli-')), mp = join(dir, 'kingmaker-manifest.json'), dmg = join(dir, 'Kingmaker-Installer-v4.4.2.dmg');
  writeFileSync(mp, JSON.stringify(manifest)); writeFileSync(dmg, 'dmg');
  const cli = spawnSync(process.execPath, ['scripts/check-release-assets.mjs', mp, dmg], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.notEqual(cli.status, 0); assert.match(`${cli.stdout}${cli.stderr}`, /governed verifier unavailable|missing/);
  const build = spawnSync('/bin/sh', ['scripts/build-installer.sh', '--manifest', mp, '--no-dmg'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.notEqual(build.status, 0); assert.match(`${build.stdout}${build.stderr}`, /not sound|detached signature|manifest/);
});

test('fixture finalizer staples before checking final bytes and exposes missing Armor verifier', async () => {
  const calls = [];
  await assert.rejects(() => finalizeInstallerRelease({
    image: '/fixture/Kingmaker-Installer-v4.4.2.dmg', identity: 'Developer ID Application: Fixture', notaryProfile: 'fixture-profile',
    notarize: async () => { calls.push('notarytool'); calls.push('stapler'); },
    verify: async () => { calls.push('verify'); throw new Error('Scripture Armor envelope: governed verifier unavailable; refusing publication'); },
  }), /governed verifier unavailable/);
  assert.deepEqual(calls, ['notarytool', 'stapler', 'verify']);
});
