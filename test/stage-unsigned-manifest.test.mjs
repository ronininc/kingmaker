import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyParts } from '../lib/release-manifest.mjs';

test('unsigned staging writes true archive pins and remains non-publishable', async () => {
  const d = mkdtempSync(join(tmpdir(), 'km-unsigned-stage-')), app = join(d, 'app.tar.gz'), launcher = join(d, 'launcher.zip'), manifestPath = join(d, 'kingmaker-manifest.json');
  writeFileSync(app, 'actual app archive bytes'); writeFileSync(launcher, 'actual launcher bytes');
  const r = spawnSync(process.execPath, ['scripts/stage-unsigned-manifest.mjs', app, launcher, manifestPath], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr); const manifest = JSON.parse(readFileSync(manifestPath));
  assert.equal((await verifyParts(manifest, d, { forRelease: true })).ok, true);
  assert.match(readFileSync(join(d, 'NON-PUBLISHABLE.txt'), 'utf8'), /UNSIGNED LOCAL STAGING ONLY/);
  writeFileSync(app, 'tampered'); assert.equal((await verifyParts(manifest, d, { forRelease: true })).ok, false);
  unlinkSync(app); assert.equal((await verifyParts(manifest, d, { forRelease: true })).ok, false);
});
