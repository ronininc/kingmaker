#!/usr/bin/env node
// scripts/render-node.mjs — one fleet render node.
//
//   node scripts/render-node.mjs --node-id <id> --conductor <url> \
//     --blender <path-to-blender> --work-dir <dir> [--mesh-token <t>] \
//     [--corrupt-on-claim <n>]
//
// Claims chunks from the conductor, pulls the scene assets pin-verified,
// renders with Blender, issues each created frame (metadata stripped, hash
// issued, provenance recorded), serves the frames from its own fleet
// endpoint, and submits the issuance. Exits 0 when the conductor reports
// the job done; prints its summary JSON on exit. --corrupt-on-claim is a
// proof hook: on that claim the node tampers with the chunk's first frame
// AFTER issuing it, so the served bytes fail their own issued hash.
import { runRenderWorker } from '../lib/render-carriage.mjs';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const nodeId = arg('node-id');
const conductorUrl = arg('conductor');
const blenderBin = arg('blender');
const workDir = arg('work-dir');
if (!nodeId || !conductorUrl || !blenderBin || !workDir) {
  console.error('usage: render-node.mjs --node-id <id> --conductor <url> --blender <path> --work-dir <dir> [--mesh-token <t>] [--corrupt-on-claim <n>]');
  process.exit(2);
}

try {
  const summary = await runRenderWorker({
    nodeId, conductorUrl, blenderBin, workDir,
    meshToken: arg('mesh-token'),
    corruptOnClaim: Number(arg('corrupt-on-claim', '0')),
  });
  console.log(JSON.stringify({ ok: summary.done === true, summary }));
  process.exit(summary.done ? 0 : 1);
} catch (e) {
  console.error(JSON.stringify({ ok: false, nodeId, error: String(e?.message ?? e), code: e?.code ?? null }));
  process.exit(1);
}
