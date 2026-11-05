#!/usr/bin/env node
// Offline pre-publication check. This never signs or uploads anything.

import { dirname, resolve } from 'node:path';
import { verifyPhysicalReleaseAssets } from '../lib/release-assets.mjs';

const manifestPath = process.argv[2], installerDmg = process.argv[3];
if (!manifestPath || !installerDmg) {
  console.error('usage: check-release-assets.mjs <kingmaker-manifest.json> <Kingmaker-Installer-*.dmg>');
  process.exit(2);
}
const verdict = await verifyPhysicalReleaseAssets({ manifestPath: resolve(manifestPath), assetsDir: dirname(resolve(manifestPath)), installerDmg: resolve(installerDmg) });
if (!verdict.ok) { for (const p of verdict.problems) console.error(`✗ ${p}`); process.exit(1); }
console.log('release asset contract OK');
