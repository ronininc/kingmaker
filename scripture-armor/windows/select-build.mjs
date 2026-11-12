#!/usr/bin/env node
// select-build.mjs — the device-match half of the Windows build template
// (windows/builds.json). Given a device's Windows build number, pick the
// build variant made for it:
//
//   1. a variant whose declared target range contains the build
//      (if several contain it, the one marked "current" wins, else the
//      one with the highest range floor — the newest knowledge);
//   2. else the nearest variant at or below the build (the closest known
//      command structure — Microsoft changes that structure between
//      versions, so the nearest lower variant is the honest fallback);
//   3. else null: no build claims this device, and the installer must
//      say so rather than guess.
//
// Adding a Windows version = adding a variant entry to builds.json.
// Nothing here, and nothing in the daemon core, changes per version.
//
// CLI: node select-build.mjs [--manifest <path>] [--os-build <n>] [--json]
// Without --os-build it reads the running OS (win32 only: os.release()).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function selectBuild(manifest, osBuild) {
  const build = Number(osBuild);
  if (!Number.isInteger(build) || build <= 0) return null;
  const variants = (manifest && Array.isArray(manifest.variants) ? manifest.variants : [])
    .filter((v) => v && v.status !== 'retired');
  let containing = null; // { variant, floor }
  let below = null;      // { variant, floor }
  for (const variant of variants) {
    for (const target of variant.targets || []) {
      const min = target.minBuild == null ? 0 : Number(target.minBuild);
      const max = target.maxBuild == null ? Infinity : Number(target.maxBuild);
      if (build >= min && build <= max) {
        if (!containing || min > containing.floor
          || (min === containing.floor && variant.status === 'current' && containing.variant.status !== 'current')) {
          containing = { variant, floor: min };
        }
      } else if (min <= build) {
        if (!below || min > below.floor) below = { variant, floor: min };
      }
    }
  }
  if (containing) return { variant: containing.variant, matched: 'in-range' };
  if (below) return { variant: below.variant, matched: 'nearest-below' };
  return null;
}

function osBuildNumber() {
  if (process.platform !== 'win32') return null;
  const parts = String(os.release()).split('.');
  const n = Number(parts[2]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
  const manifestPath = option('--manifest') || path.join(HERE, 'builds.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const build = option('--os-build') ? Number(option('--os-build')) : osBuildNumber();
  const pick = selectBuild(manifest, build);
  if (args.includes('--json')) {
    console.log(JSON.stringify({ osBuild: build, pick: pick ? { variant: pick.variant.id, matched: pick.matched } : null }));
  } else if (!build) {
    console.log('no Windows build number available (not running on Windows) — pass --os-build <n>');
    process.exit(2);
  } else if (!pick) {
    console.log(`no Scripture Armor Windows build claims this device (Windows build ${build})`);
    process.exit(1);
  } else {
    console.log(`Windows build ${build} -> variant ${pick.variant.id} (${pick.variant.label}), matched: ${pick.matched}`);
  }
}
