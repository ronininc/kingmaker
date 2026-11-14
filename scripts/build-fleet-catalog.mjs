#!/usr/bin/env node
// Build catalog/fleet.json — the Brain Library catalog WITH portion pin
// manifests (Fleet Replication follow-on 1).
//   node scripts/build-fleet-catalog.mjs [--out <path>] [--portion-bytes <n>]
// Sources come from buildCatalogSources() over this tree's own catalog/ —
// the same production construction the access layer serves from — so every
// descriptor in the published file is built from the bytes the catalog
// actually carries. Model weights join the same file when a range fetcher
// is wired at publish time (buildCatalogSources({fetchModelRange, models}));
// this build runs without one, so no model entries are emitted and that
// absence is printed, never silent.
import { fileURLToPath } from 'node:url';
import { buildCatalogSources } from '../lib/brain-library-access.mjs';
import { buildFleetCatalog, loadFleetCatalog, writeFleetCatalog } from '../lib/brain-library-fleet-catalog.mjs';

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const out = flag('--out') ?? fileURLToPath(new URL('../catalog/fleet.json', import.meta.url));
const portionBytes = Number(flag('--portion-bytes') ?? 262_144);

const sources = await buildCatalogSources({});
if (sources.remoteError) { console.error(`repo lane unavailable, bundled catalog only: ${sources.remoteError.message}`); }
const catalog = await buildFleetCatalog({ sources, portionBytes });
await writeFleetCatalog(out, catalog);
const check = await loadFleetCatalog(out);
console.log(`✓ ${out}: ${catalog.items.length} fleet items, ${catalog.skipped.length} sources skipped, loader re-validated ${check.items.size} items, ${check.rejected.length} rejected`);
for (const s of catalog.skipped) console.log(`  skipped ${s.id} (${s.kind}): ${s.reason}`);
const kinds = {};
for (const d of catalog.items) kinds[d.kind] = (kinds[d.kind] ?? 0) + 1;
console.log(`  kinds: ${Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join(', ')}; no model entries (no range fetcher wired in this build)`);
