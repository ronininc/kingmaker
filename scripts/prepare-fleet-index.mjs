#!/usr/bin/env node
// Local dry run only. Approvals must be supplied from the owner's private review record.
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { prepareFleetIndex } from '../lib/fleet-index-publisher.mjs';
import { FLEET_INDEX_SCHEMA, verifyFleetSkillCatalog } from '../lib/fleet-skills.mjs';

const { values } = parseArgs({ options: {
  review: { type: 'string' },
  out: { type: 'string' },
  approvals: { type: 'string' },
  previous: { type: 'string' },
  'public-key': { type: 'string' },
} });
if (!values.review || !values.out || Boolean(values.previous) !== Boolean(values['public-key'])) {
  throw new Error('Usage: node scripts/prepare-fleet-index.mjs --review <private JSON> --out <new file> [--approvals <owner-approved-entry-array.json>] [--previous <signed index> --public-key <PEM>]');
}
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
let previous = null;
if (values.previous) {
  const checked = verifyFleetSkillCatalog(readJson(values.previous), readFileSync(values['public-key'], 'utf8'));
  if (!checked.ok || checked.catalog.schema !== FLEET_INDEX_SCHEMA) throw new Error(checked.error || 'Previous document is not a signed Fleet index.');
  previous = checked.catalog;
}
const approvals = values.approvals ? readJson(values.approvals) : [];
const { index, omitted } = prepareFleetIndex({ ...readJson(values.review), approvals, previous });
writeFileSync(values.out, JSON.stringify(index, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ dryRun: true, entries: index.entries.length, omitted }));
