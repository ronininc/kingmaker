#!/usr/bin/env node
// Build THE Kingmaker payload: one file, kingmaker-payload.tar, holding Resources/sol-ghost whole (lib/payload.mjs
// PAYLOAD_PARTS) with payload.json, the list of every file and its SHA-256. Any builder of Kingmaker.app (the
// engine build, scripts/build-app.sh) unpacks this one file into Contents/Resources and copies nothing else of
// Kingmaker's, so it can't leave a folder behind.
//
//   node scripts/build-payload.mjs [--out <dir>]          → <dir>/kingmaker-payload.tar (+ .sha256), default dist/payload
//
// Before it says done it unpacks its own tar into a scratch folder, checks every file against the list, and runs the
// unpacked `kingmaker version`: a payload that doesn't start is never handed on.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifest, checkPayload, PAYLOAD_FILE, PAYLOAD_PARTS, payloadFiles, payloadProblem } from '../lib/payload.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PAYLOAD_TAR = 'kingmaker-payload.tar';

export function buildPayload({ root = ROOT, out = join(ROOT, 'dist', 'payload') } = {}) {
  const files = payloadFiles(root);
  rmSync(out, { recursive: true, force: true });
  const stage = join(out, 'stage', 'sol-ghost');
  for (const f of files) { mkdirSync(dirname(join(stage, f)), { recursive: true }); cpSync(join(root, f), join(stage, f), { preserveTimestamps: true, verbatimSymlinks: true }); }
  writeFileSync(join(stage, PAYLOAD_FILE), buildManifest(stage, { files }));
  const tar = join(out, PAYLOAD_TAR);
  execFileSync('tar', ['-cf', tar, '-C', join(out, 'stage'), 'sol-ghost'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  rmSync(join(out, 'stage'), { recursive: true, force: true });
  const sha = createHash('sha256').update(readFileSync(tar)).digest('hex');
  writeFileSync(`${tar}.sha256`, `${sha}  ${PAYLOAD_TAR}\n`);
  const proof = provePayload(tar);
  return { tar, sha256: sha, files: files.length + 1, version: proof.version };
}

/** Unpack a payload tar into scratch, check every file, and run its `kingmaker version`. Throws on anything short. */
export function provePayload(tar) {
  const scratch = mkdtempSync(join(tmpdir(), 'km-payload-proof-'));
  try {
    execFileSync('tar', ['-xf', tar, '-C', scratch]);
    const dir = join(scratch, 'sol-ghost');
    const r = checkPayload(dir, { deep: true });
    if (!r.ok || !r.listed) throw new Error(payloadProblem(r) || 'the payload carries no file list');
    const version = execFileSync(process.execPath, [join(dir, 'lib', 'kingmaker.mjs'), 'version'], { encoding: 'utf8', env: { ...process.env, KINGMAKER_ADDONS: 'off' } }).trim();
    if (version !== r.version) throw new Error(`the unpacked Kingmaker says ${version || 'nothing'}, the list says ${r.version}`);
    return { version, files: r.checked };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--out');
  const r = buildPayload(i > 0 ? { out: resolve(process.argv[i + 1]) } : {});
  console.log(`✓ ${r.tar}: Kingmaker ${r.version}, ${r.files} files (${PAYLOAD_PARTS.join(', ')}), sha256 ${r.sha256.slice(0, 16)}…; unpacked, checked and started.`);
  console.log(`  Builders: tar -xf ${PAYLOAD_TAR} -C <Kingmaker.app>/Contents/Resources   (then sign the app)`);
}
