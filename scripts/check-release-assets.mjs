#!/usr/bin/env node
// Offline pre-publication check. This never signs or uploads anything.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { assertReleaseAssets } from '../lib/release-assets.mjs';

const manifestPath = process.argv[2];
const assetPaths = process.argv.slice(3);
if (!manifestPath || !assetPaths.length) {
  console.error('usage: check-release-assets.mjs <kingmaker-manifest.json> <asset>...');
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
assertReleaseAssets({ manifest, assets: assetPaths.map(basename) });
console.log(`release asset contract OK (${assetPaths.length} assets)`);
