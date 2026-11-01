#!/usr/bin/env node
// Make the collective's signing key pair (Ed25519), once, before the first deploy of fleet-host (kingmaker-fleet).
//   node scripts/fleet-keygen.mjs <out-dir>
// Writes <out-dir>/fleet-signing-key.pem (0600: the PRIVATE key, for `wrangler secret put FLEET_SIGNING_KEY < it`, then
// keep it offline) and prints the PUBLIC key and keyId: put the public key in fleet-host/wrangler.jsonc FLEET_PUBLIC_KEY
// and in each Kingmaker's fleet.json, where it is pinned. Never commit the private key; it is not printed.
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dir = resolve(process.argv[2] || '');
if (!process.argv[2]) { console.error('usage: node scripts/fleet-keygen.mjs <out-dir outside the repo>'); process.exit(2); }
const file = join(dir, 'fleet-signing-key.pem');
if (existsSync(file)) { console.error(`${file} exists: refusing to replace a signing key (installs pin its public key).`); process.exit(1); }
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
mkdirSync(dir, { recursive: true, mode: 0o700 });
writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
const pub = publicKey.export({ type: 'spki', format: 'pem' });
console.log(pub.trim());
console.log(`keyId km_${createHash('sha256').update(String(pub).trim()).digest('hex').slice(0, 16)}`);
console.log(`private key: ${file} (0600)`);
