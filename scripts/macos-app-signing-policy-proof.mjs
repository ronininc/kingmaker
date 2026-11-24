#!/usr/bin/env node
// Read-only proof command, never signs, modifies, installs, or publishes an app.
import { resolve } from 'node:path';
import { preflightAppSigner } from '../lib/macos-app-signing-policy.mjs';

const [lane, expectedVersion, appleTeamOrLegacyLeaf, app, ...extra] = process.argv.slice(2);
try {
  if (!app || extra.length) throw new Error('Usage: node scripts/macos-app-signing-policy-proof.mjs <developer-id|legacy> <exact version> <Team ID|legacy leaf SHA1> <Kingmaker.app>');
  const opts = { lane, expectedVersion, ...(lane === 'developer-id' ? { expectedTeam: appleTeamOrLegacyLeaf } : { legacyLeaf: appleTeamOrLegacyLeaf }) };
  const result = preflightAppSigner(resolve(app), opts);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
} catch (e) {
  console.error(e.message);
  process.exitCode = 2;
}
