#!/usr/bin/env node
// Compose already-reviewed metadata. This command neither reads the source repos nor publishes anything.
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { createPrivateKey, sign } from 'node:crypto';
import { canonicalJson } from '../vendor/fleet/fleet-packet.mjs';
import { FLEET_INDEX_DOMAIN, FLEET_INDEX_SCHEMA, fleetIndexProblems } from '../lib/fleet-skills.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'published-at': { type: 'string' },
    out: { type: 'string' },
    'sign-key': { type: 'string' },
  },
});
if (!values.out || !values['published-at'] || !positionals.length) {
  throw new Error('Usage: node scripts/build-fleet-index.mjs --published-at <ISO UTC> --out <file> [--sign-key <offline Ed25519 PEM>] <reviewed-entry-array.json>...');
}
const entries = positionals.flatMap(file => {
  const reviewed = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(reviewed)) throw new Error(`${file} must contain an array of reviewed index entries.`);
  return reviewed;
});
const index = { schema: FLEET_INDEX_SCHEMA, publishedAt: values['published-at'], entries };
const problems = fleetIndexProblems(index);
if (problems.length) throw new Error(problems.join('\n'));
const counts = Object.fromEntries(['brain', 'weights', 'skill', 'tool'].map(type =>
  [type, entries.filter(entry => entry.type === type).length]));
let document = index;
if (values['sign-key']) {
  const key = createPrivateKey(readFileSync(values['sign-key']));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Fleet index signing requires an Ed25519 private key.');
  const signature = sign(null, Buffer.from(`${FLEET_INDEX_DOMAIN}:${canonicalJson(index)}`), key).toString('base64');
  document = { ...index, signature };
}
writeFileSync(values.out, JSON.stringify(document, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(`${values['sign-key'] ? 'Signed' : 'Unsigned'} local Fleet index: ${JSON.stringify(counts)}`);
