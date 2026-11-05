import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLatest, macosEntryFromManifest, platformObjects, platformsProblems } from '../lib/release-platforms.mjs';

const macPart = { name: 'Kingmaker-v5.tar.gz.part01', size: 101, sha256: 'a'.repeat(64) };
const linux = { status: 'ready', artifacts: [{ name: 'Ronin-Launcher.AppImage', size: 202, sha256: 'b'.repeat(64) }], signature: 'v5/linux.sig' };
const windows = { status: 'ready', artifacts: [{ name: 'Ronin-Launcher.msi', size: 303, sha256: 'c'.repeat(64) }], signature: 'v5/windows.sig' };
const manifest = { version: '5.0.0', tag: 'v5.0.0', parts: [macPart], app: { archive: 'Kingmaker-v5.tar.gz' }, engine: { sha256: 'd'.repeat(64) } };

test('adding Linux and Windows preserves the exact macOS artifact set', () => {
  const platforms = { macos: macosEntryFromManifest(manifest), linux, windows };
  assert.deepEqual(platformsProblems(platforms), []);
  assert.deepEqual(platforms.macos.artifacts, [macPart]);
  const latest = buildLatest({ manifest, platforms });
  assert.deepEqual(latest.platforms.macos.artifacts, [macPart]);
  assert.equal(latest.platforms.linux.artifacts[0].sha256, 'b'.repeat(64));
  assert.equal(latest.platforms.windows.artifacts[0].sha256, 'c'.repeat(64));
});

test('publication inputs add ready non-Mac files without duplicating or replacing Mac parts', () => {
  const objects = platformObjects({ version: manifest.version, platforms: { macos: macosEntryFromManifest(manifest), linux, windows }, dir: '/release' });
  assert.deepEqual(objects.map((x) => x.file), ['/release/linux/Ronin-Launcher.AppImage', '/release/windows/Ronin-Launcher.msi']);
  assert.equal(objects.some((x) => x.file.includes(macPart.name)), false);
  assert.deepEqual(objects.map(({ platform, sha256, size }) => ({ platform, sha256, size })), [
    { platform: 'linux', sha256: 'b'.repeat(64), size: 202 },
    { platform: 'windows', sha256: 'c'.repeat(64), size: 303 },
  ]);
});

test('a platform cannot claim readiness without a signed, hashed, sized artifact', () => {
  for (const bad of [
    { status: 'ready', artifacts: [], signature: 'x.sig' },
    { status: 'ready', artifacts: [{ name: 'x', size: 1, sha256: 'bad' }], signature: 'x.sig' },
    { status: 'ready', artifacts: [{ name: 'x', size: 0, sha256: 'e'.repeat(64) }], signature: 'x.sig' },
    { status: 'ready', artifacts: [{ name: 'x', size: 1, sha256: 'e'.repeat(64) }], signature: null },
  ]) assert.notDeepEqual(platformsProblems({ macos: macosEntryFromManifest(manifest), linux: bad, windows: { status: 'placeholder', artifacts: [], signature: null } }), []);
});
