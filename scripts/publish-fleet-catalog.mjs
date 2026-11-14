#!/usr/bin/env node
// Publish catalog/fleet.json WITH model entries — the fetcher-wired
// composition scripts/build-fleet-catalog.mjs names but does not run.
//
//   node scripts/publish-fleet-catalog.mjs [--out <path>]
//        [--portion-bytes <n>] [--model-portion-bytes <n>]
//        [--models smallest|all|<slug> …]
//
// Local catalog sources are built exactly as in build-fleet-catalog.mjs
// (buildCatalogSources over this tree's catalog/, portion manifests at
// --portion-bytes). Model weights join through the door: the model list is
// read live from the public library.json, and each chosen model's bytes are
// range-fetched from the door's release assets by
// lib/brain-library-fleet-door.mjs's fetcher, wired into
// buildCatalogSources({ fetchModelRange, models }) — the composition the
// fleet catalog builder was written for. Model descriptors are built at
// --model-portion-bytes (default the access layer's 1 MiB portion bound:
// a 1.1 GB GGUF is 1,057 portions, not 4,225).
//
// The default model selection is `smallest` — the smallest weights-bearing
// release on the door — because a publish run reads every chosen model end
// to end. `--models all` composes every weights model the door publishes
// (tens of GB of range traffic; say so if you run it). Models NOT chosen
// are printed by name: the published file's silence about a model must
// never be mistaken for coverage.
//
// Acceptance is the builder's own: a model descriptor is emitted only when
// the whole-item hash computed from the door's bytes equals the door
// catalog's pinned sha256 (buildFleetDescriptor refuses otherwise), and the
// written file is re-loaded and re-validated before this script reports.
import { fileURLToPath } from 'node:url';
import { buildCatalogSources, MAX_PORTION_BYTES } from '../lib/brain-library-access.mjs';
import { buildFleetCatalog, buildFleetDescriptor, loadFleetCatalog, writeFleetCatalog } from '../lib/brain-library-fleet-catalog.mjs';
import { createDoorRangeFetcher, loadDoorModels, smallestWeightsModel } from '../lib/brain-library-fleet-door.mjs';

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const out = flag('--out') ?? fileURLToPath(new URL('../catalog/fleet.json', import.meta.url));
const portionBytes = Number(flag('--portion-bytes') ?? 262_144);
const modelPortionBytes = Number(flag('--model-portion-bytes') ?? MAX_PORTION_BYTES);
const modelsArg = flag('--models') ?? 'smallest';

const door = await loadDoorModels({});
console.log(`door: ${door.libraryUrl} (updatedAt ${door.updatedAt}) — ${door.models.length} weights-bearing models, ${door.withoutWeights.length} without weights`);
let chosen;
if (modelsArg === 'all') chosen = door.models;
else if (modelsArg === 'smallest') chosen = [smallestWeightsModel(door.models)].filter(Boolean);
else chosen = door.models.filter((m) => modelsArg.split(',').includes(m.slug) || modelsArg.split(',').includes(m.tag));
if (!chosen.length) { console.error(`no door model matched --models ${modelsArg}`); process.exit(1); }
const chosenSlugs = new Set(chosen.map((m) => m.slug));
for (const m of door.models) if (!chosenSlugs.has(m.slug)) console.log(`  not composed in this run: ${m.tag} (${m.weights.size} bytes) — pass --models all or --models ${m.slug}`);

let ranges = 0; let rangeBytes = 0;
const fetchModelRange = createDoorRangeFetcher({ prefetchRanges: 8, onRange: ({ bytes }) => { ranges++; rangeBytes += bytes; } });

// Local items first, from the bundled catalog alone — buildFleetCatalog
// must never see a model source here, or it would read the whole model at
// the catalog portion size before the model pass below reads it again at
// the model portion size.
const localSources = await buildCatalogSources({});
const catalog = await buildFleetCatalog({ sources: localSources, portionBytes });
const byId = new Map(catalog.items.map((d) => [d.id, d]));

// Then the model pass: sources built WITH the door fetcher wired in, and
// each chosen model's descriptor built at the model portion size.
const modelSources = await buildCatalogSources({ fetchModelRange, models: chosen });
for (const model of chosen) {
  const id = `model:${model.slug || model.tag}`;
  const source = modelSources.get(id);
  if (!source) { console.error(`door model ${model.tag} produced no source — refusing to publish a catalog that hides it`); process.exit(1); }
  const descriptor = await buildFleetDescriptor(source, { portionBytes: modelPortionBytes });
  if (descriptor.sha256 !== model.weights.sha256) { console.error(`door model ${model.tag}: computed pin does not match the door catalog pin — refusing`); process.exit(1); }
  byId.set(id, descriptor);
  console.log(`  model composed: ${id} — ${descriptor.size} bytes, ${descriptor.portionSha256.length} portions at ${modelPortionBytes} B, whole pin matches the door catalog`);
}
catalog.items = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
await writeFleetCatalog(out, catalog);
const check = await loadFleetCatalog(out);
if (check.rejected.length) { console.error(`published file failed re-validation: ${JSON.stringify(check.rejected)}`); process.exit(1); }
console.log(`✓ ${out}: ${catalog.items.length} fleet items (${check.items.size} re-validated), ${catalog.skipped.length} sources skipped`);
const kinds = {};
for (const d of catalog.items) kinds[d.kind] = (kinds[d.kind] ?? 0) + 1;
console.log(`  kinds: ${Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join(', ')}; door traffic: ${ranges} range reads, ${rangeBytes} bytes`);
