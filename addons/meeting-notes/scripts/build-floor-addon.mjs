#!/usr/bin/env node
// scripts/build-floor-addon.mjs — package the meeting-notes participant as a Ronin Launcher add-on (ronin.addon/1).
//
// Emits dist/addon/meeting-notes-<version>.zip and dist/addon/manifest.json: the zip holds EXACTLY the add-on's four
// files at their own paths, and the manifest carries each file's size + SHA-256, the archive's size + SHA-256, and the
// install contract (entry register(host), command, permissions, requires). The manifest is left UNSIGNED — signing with
// the Kingmaker Release key (RSA-PSS SHA-256) is the release step, exactly like kingmaker-manifest.json. Developer-time
// only. Contract: ~/Projects/ronin-launcher/docs/addons.md (ronin.addon/1).
//   node scripts/build-floor-addon.mjs
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = '1.0.0';
// The add-on's files, at their add-on-relative paths (the same lib/ scripts/ vendor/ layout Kingmaker places them in).
const FILES = [
  'lib/floor-participant.mjs',
  'lib/floor-audio-webrtc.mjs',
  'scripts/floor-participant.mjs',
  'vendor/webrtc/webrtc-libs.mjs',
];
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function main() {
  const out = join(ROOT, 'dist', 'addon');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  // Stage exactly the add-on's files, preserving their relative paths, then zip that tree (and nothing else).
  const stage = join(out, 'stage');
  const files = FILES.map((rel) => {
    const src = join(ROOT, rel);
    const buf = readFileSync(src); // throws if a file is missing — the package must be complete
    mkdirSync(dirname(join(stage, rel)), { recursive: true });
    writeFileSync(join(stage, rel), buf);
    return { path: rel, size: buf.length, sha256: sha256(buf) };
  });
  const archiveName = `meeting-notes-${VERSION}.zip`;
  const archivePath = join(out, archiveName);
  // -X: no extra attributes, for a stable archive. Zip the top-level dirs so paths are exactly lib/… scripts/… vendor/…
  execFileSync('zip', ['-X', '-D', '-q', archivePath, ...FILES], { cwd: stage }); // -D: no directory entries, so the zip holds exactly the files
  const archiveBuf = readFileSync(archivePath);
  const manifest = {
    schema: 'ronin.addon/1',
    id: 'meeting-notes',
    name: 'Meeting notes',
    version: VERSION,
    summary: 'Mia joins your meetings, takes the notes and files them in your CRM.',
    paid: true,
    sku: 'addon.meeting-notes',
    license: 'Ronin commercial add-on licence',
    requires: { kingmaker: '>=0.2.6', launcher: '>=0.3.0', arch: 'arm64' },
    archive: { name: archiveName, size: archiveBuf.length, sha256: sha256(archiveBuf) },
    files,
    entry: { module: 'lib/floor-participant.mjs', export: 'register' },
    commands: [{ name: 'floor', summary: 'Join a meeting as Mia and take notes' }],
    permissions: ['microphone', 'network:lan'],
  };
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  rmSync(stage, { recursive: true, force: true });
  console.log(`Packaged ${archiveName} (${(archiveBuf.length / 1e6).toFixed(2)} MB) + manifest.json in dist/addon/`);
  console.log('Files:'); for (const f of files) console.log(`  ${f.path}  ${f.size} B  ${f.sha256.slice(0, 16)}…`);
  console.log('UNSIGNED — sign manifest.json with the Kingmaker Release key (RSA-PSS SHA-256) at release.');
}
main();
