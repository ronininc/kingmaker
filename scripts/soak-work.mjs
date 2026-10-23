#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { runWorkSoak, hardwareIdentity } from '../lib/soak-work.mjs';
const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };
if (process.argv.includes('--help') || !arg('--config')) {
  console.log('node scripts/soak-work.mjs --config config.json --json report.json [--run] [--baseline catalog/bench/m5-pro-24gb.json]\nDefault: read-only preflight. --run requires an idle, exclusively reserved local endpoint and exclusive:true in config. No cloud, downloads or installed-app changes. See docs/SOAK-WORK.md.');
  process.exit(process.argv.includes('--help') ? 0 : 2);
}
try {
  if (process.argv.includes('--run') && !arg('--json')) throw new Error('REPORT_PATH_REQUIRED: --run needs --json to preserve receipts');
  const config = JSON.parse(readFileSync(arg('--config'), 'utf8'));
  const baseline = arg('--baseline') ? JSON.parse(readFileSync(arg('--baseline'), 'utf8')) : null;
  const identity = arg('--hardware-json') ? hardwareIdentity(JSON.parse(readFileSync(arg('--hardware-json'), 'utf8'))) : null;
  const report = await runWorkSoak(config, { baseline, identity, preflightOnly: !process.argv.includes('--run'), log: console.log });
  if (arg('--json')) writeFileSync(arg('--json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ runId: report.runId, status: report.status, ...report.result }, null, 2));
  process.exitCode = report.result?.ok ? 0 : 1; // Preflight can NEVER be mistaken for a successful soak.
} catch (e) { console.error(e.message); process.exitCode = 2; }
