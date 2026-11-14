#!/usr/bin/env node
// scripts/render-conductor.mjs — run one render job's conductor.
//
// Reads a job spec JSON:
//   { jobId, assetsDir, assetFiles: ["scene.py", ...], frameStart, frameEnd,
//     chunkFrames, fps, width, height, framesDir, outPath, receiptsPath,
//     meshToken? }
// Publishes the assets pin-verified on a fleet node, leases chunks to render
// nodes (scripts/render-node.mjs), records every created frame's issued hash
// + provenance (frames are creations — accepted on issuance, checked only
// against their own issued hash for tamper-evidence), assembles the sequence
// with ffmpeg, writes the receipts JSON, and prints the verdict. Exit 0 only
// when the job completed and the assembled frame count matches the plan.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileSource } from '../lib/brain-library-access.mjs';
import { assetItemId, createRenderConductor } from '../lib/render-carriage.mjs';

const specPath = process.argv[2];
if (!specPath) { console.error('usage: render-conductor.mjs <job-spec.json>'); process.exit(2); }
const spec = JSON.parse(await readFile(specPath, 'utf8'));

const conductor = createRenderConductor({
  jobId: spec.jobId, framesDir: spec.framesDir,
  meshToken: spec.meshToken ?? null,
});
conductor.plan({ frameStart: spec.frameStart, frameEnd: spec.frameEnd, chunkFrames: spec.chunkFrames });

const assetSources = new Map();
for (const name of spec.assetFiles) {
  assetSources.set(assetItemId(spec.jobId, name), await fileSource({
    id: assetItemId(spec.jobId, name), kind: 'render-asset', name,
    path: path.join(spec.assetsDir, name),
  }));
}
await conductor.publishAssets(assetSources);
const { url } = await conductor.listen(0, '127.0.0.1');
console.log(JSON.stringify({ ready: true, url, jobId: spec.jobId }));

const deadline = Date.now() + (spec.timeoutMs ?? 600_000);
while (!conductor.jobDone()) {
  if (Date.now() > deadline) {
    console.error(JSON.stringify({ ok: false, error: 'job timed out', receipts: conductor.receipts }));
    await conductor.close();
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 250));
}

await mkdir(path.dirname(spec.outPath), { recursive: true });
const assembled = await conductor.assemble({ outPath: spec.outPath, fps: spec.fps ?? 24, frameStart: spec.frameStart });
if (spec.receiptsPath) {
  await mkdir(path.dirname(spec.receiptsPath), { recursive: true });
  await writeFile(spec.receiptsPath, JSON.stringify({ jobId: spec.jobId, assembled, receipts: conductor.receipts }, null, 2));
}
console.log(JSON.stringify({ ok: true, assembled }));
await conductor.close();
process.exit(0);
