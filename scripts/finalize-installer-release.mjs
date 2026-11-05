#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { finalizeInstallerRelease } from '../lib/installer-finalize.mjs';
import { verifyPhysicalReleaseAssets } from '../lib/release-assets.mjs';

const [manifestPath, image] = process.argv.slice(2).map((p) => p && resolve(p));
if (!manifestPath || !image) { console.error('usage: finalize-installer-release.mjs <manifest> <dmg>'); process.exit(2); }
const run = (args) => { const r = spawnSync('/usr/bin/xcrun', args, { stdio: 'inherit', env: { PATH: '/usr/bin:/bin' } }); if (r.status !== 0) throw new Error(`xcrun ${args[0]} failed (${r.status})`); };
try {
  await finalizeInstallerRelease({
    image, identity: process.env.KINGMAKER_SIGN_IDENTITY ?? '-', notaryProfile: process.env.KINGMAKER_NOTARY_PROFILE,
    notarize: async (file, profile) => { run(['notarytool', 'submit', file, '--keychain-profile', profile, '--wait']); run(['stapler', 'staple', file]); },
    verify: async (file) => { const v = await verifyPhysicalReleaseAssets({ manifestPath, assetsDir: dirname(manifestPath), installerDmg: file }); if (!v.ok) throw new Error(v.problems.join('; ')); },
  });
} catch (e) { console.error(`final release gate refused: ${e.message}`); process.exit(1); }
