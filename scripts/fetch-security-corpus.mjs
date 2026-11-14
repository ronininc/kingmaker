#!/usr/bin/env node
// Fetch the security-diagnostics corpus into Kingmaker's knowledge sources.
//
//   node scripts/fetch-security-corpus.mjs --list        show what would be fetched, download nothing
//   HF_TOKEN=... node scripts/fetch-security-corpus.mjs  fetch and convert
//   --sources=<folder>                                   write somewhere other than Kingmaker's own sources folder
//   --build-only                                         skip the fetch; build the index shard from what is already there
//
// After a fetch the security-diagnostics.db index shard is built straight away (extract, then index,
// for this one field), because the background knowledge build does nothing once the library is complete.
import { buildShard, corpusInstalled, defaultSourcesDir, fetchCorpus, listTree, loadManifest, planFetch } from '../lib/security-corpus.mjs';

const args = process.argv.slice(2);
const sourcesArg = args.find((a) => a.startsWith('--sources='));
const sourcesDir = sourcesArg ? sourcesArg.slice('--sources='.length) : defaultSourcesDir();
const manifest = loadManifest();
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

console.log(`${manifest.title}\n  from   ${manifest.source.repo} @ ${manifest.source.revision.slice(0, 12)}\n  into   ${sourcesDir}/${manifest.field}/${manifest.id}\n  rights ${manifest.license.confirmed ? 'confirmed' : 'NOT confirmed'}: ${manifest.license.use}\n`);

if (args.includes('--list')) {
  const plan = planFetch(await listTree(manifest), manifest);
  for (const f of plan.take) console.log(`  take  ${f.path}  ${mb(f.size)}`);
  for (const s of plan.skipped) console.log(`  skip  ${s.path}  (${s.reason})`);
  console.log(`\n${plan.take.length} files, ${mb(plan.bytes)} to fetch; ${plan.skipped.length} skipped.`);
} else {
  let ok = true;
  if (!args.includes('--build-only')) {
    const r = await fetchCorpus({ manifest, sourcesDir, log: console.log });
    if (r.reason) console.log(r.reason);
    else console.log(`\n${r.state}: ${r.written.length} files written, ${r.failed.length} failed.`);
    ok = r.state === 'complete';
    if (!r.written?.length) process.exit(1);
  } else if (!corpusInstalled(manifest, sourcesDir)) {
    console.log('Nothing to build: the corpus has not been fetched into this folder.');
    process.exit(1);
  }
  const b = buildShard({ manifest, sourcesDir });
  console.log(b.state === 'built' ? `Index built: ${b.shard}` : `Index NOT built (${b.stage}): ${b.reason}`);
  process.exitCode = ok && b.state === 'built' ? 0 : 1;
}
