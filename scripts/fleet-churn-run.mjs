#!/usr/bin/env node
// One fleet churn cycle, as a standalone job — the command the systemd
// timer (deploy/systemd/kingmaker-fleet-churn.service) runs daily.
//
//   node scripts/fleet-churn-run.mjs --root <state-dir>
//        [--catalog <fleet.json>] [--max-bytes <n>] [--stale-after-ms <n>]
//
// Layout under --root (the install's brain-library state):
//   store/        residents          cache/        stream cache
//   state/        access mode store  churn-state/  the churn ledger
//   churn-log/    one JSON record per cycle — the cycle's receipt
//
// The cycle itself is lib/brain-library-fleet-churn.mjs's runCycle:
// verify every resident against its receipt pin (TAMPERED is a loud
// verdict, bytes never touched), refresh superseded residents through the
// pin-checked download, evict orphaned / stale / over-budget holdings.
// This script only wires the real dirs and the published catalog into it
// and prints the outcome. A cycle that FINDS a tampered resident has done
// its job: verdicts are printed, the exit code is 0, and the record in
// churn-log/ is the receipt. A cycle that cannot run exits nonzero.
//
// Sources: buildCatalogSources() over this tree's bundled catalog — the
// install's offline floor, the same construction the access layer serves
// from. A ledger holding whose id has no source here is reported by the
// cycle as LEDGER-ORPHAN, never silently skipped.
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { buildCatalogSources, createBrainLibraryAccess } from '../lib/brain-library-access.mjs';
import { loadFleetCatalog } from '../lib/brain-library-fleet-catalog.mjs';
import { createFleetChurn } from '../lib/brain-library-fleet-churn.mjs';

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const root = flag('--root');
if (!root) { console.error('fleet-churn-run: --root <state-dir> is required'); process.exit(2); }
const catalogPath = flag('--catalog') ?? fileURLToPath(new URL('../catalog/fleet.json', import.meta.url));
const budgetBytes = flag('--max-bytes') != null ? Number(flag('--max-bytes')) : Number.POSITIVE_INFINITY;
const staleAfterMs = flag('--stale-after-ms') != null ? Number(flag('--stale-after-ms')) : undefined;

const sources = await buildCatalogSources({});
const access = createBrainLibraryAccess({
  sources,
  storeDir: join(root, 'store'), cacheDir: join(root, 'cache'), stateDir: join(root, 'state'),
});
const { items } = await loadFleetCatalog(catalogPath);
const churn = createFleetChurn({ stateDir: join(root, 'churn-state'), logDir: join(root, 'churn-log') });
const record = await churn.runCycle({ access, catalog: items, budgetBytes, ...(staleAfterMs != null ? { staleAfterMs } : {}) });

console.log(`fleet churn cycle ${record.at}: held ${record.heldBytesBefore} → ${record.heldBytesAfter} bytes; verified ok: ${record.verifiedOk.length}; refreshed: ${record.refreshed.length}; evicted: ${record.evicted.length}; verdicts: ${record.verdicts.length}`);
for (const v of record.verdicts) console.log(`  VERDICT ${v.id}: ${v.verdict}${v.expected ? ` expected ${v.expected} actual ${v.actual}` : ''}${v.detail ? ` — ${v.detail}` : ''}`);
for (const e of record.evicted) console.log(`  evicted ${e.id} (${e.reason}, ${e.bytes} bytes)`);
console.log(`  record: ${record.logPath}`);
