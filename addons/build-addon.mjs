#!/usr/bin/env node
// addons/build-addon.mjs — package an add-on from this checkout as a Ronin Launcher add-on (ronin.addon/1), the way
// addons/meeting-notes/scripts/build-floor-addon.mjs packages meeting notes. Operator tooling; nothing is uploaded.
//
//   node addons/build-addon.mjs <id-folder> [--out <dir>]      e.g. node addons/build-addon.mjs ronin
//
// Reads addons/<folder>/addon.json (id, name, version source, sku, requires, entry, commands, permissions, leaveOut),
// zips exactly the files the add-on runs (never its tests, docs or scripts), and writes dist/addon/<id>/manifest.json with
// each file's size + SHA-256, the archive's, and entry { module, export: 'register' }. The manifest is left UNSIGNED:
// signing it with the Kingmaker Release key (RSA-PSS SHA-256) is the release step, exactly like kingmaker-manifest.json.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifestProblems } from '../lib/addons.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** The add-on's runnable files (add-on-relative, sorted): everything but what addon.json leaves out. */
export function addonFiles(dir, leaveOut = []) {
  const skip = new Set(leaveOut), out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name), rel = relative(dir, p).split(sep).join('/');
      if (skip.has(rel) || skip.has(e.name) || e.name === '.DS_Store') continue;
      if (e.isDirectory()) walk(p); else if (e.isFile()) out.push(rel);
    }
  };
  walk(dir);
  return out.sort();
}

export function buildAddon(folder, { out = join(HERE, '..', 'dist', 'addon'), version } = {}) {
  const dir = join(HERE, folder);
  const desc = JSON.parse(readFileSync(join(dir, 'addon.json'), 'utf8'));
  const v = version || desc.version || JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')).version;
  const files = addonFiles(dir, desc.leaveOut).map((path) => { const buf = readFileSync(join(dir, path)); return { path, size: buf.length, sha256: sha256(buf) }; });
  const dest = join(out, desc.id);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const archiveName = `${desc.id}-${v}.zip`, archivePath = join(dest, archiveName);
  execFileSync('zip', ['-X', '-D', '-q', archivePath, ...files.map((f) => f.path)], { cwd: dir });
  const archive = readFileSync(archivePath);
  const manifest = {
    schema: 'ronin.addon/1', id: desc.id, name: desc.name, version: v, summary: desc.summary, paid: Boolean(desc.paid), ...(desc.sku ? { sku: desc.sku } : {}),
    license: desc.license, requires: desc.requires, archive: { name: archiveName, size: archive.length, sha256: sha256(archive) },
    files, entry: { module: desc.entry, export: 'register' }, commands: desc.commands ?? [], permissions: desc.permissions ?? [],
  };
  const problems = manifestProblems(manifest);
  if (problems.length) throw new Error(`the manifest is not a valid ronin.addon/1: ${problems.join('; ')}`);
  writeFileSync(join(dest, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { dir: dest, manifest, archivePath };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [folder] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const i = process.argv.indexOf('--out');
  if (!folder) { console.error('usage: node addons/build-addon.mjs <folder> [--out <dir>]'); process.exit(2); }
  const r = buildAddon(folder, i > 0 ? { out: resolve(process.argv[i + 1]) } : {});
  console.log(`Packaged ${r.manifest.id} ${r.manifest.version}: ${r.manifest.files.length} files, ${(statSync(r.archivePath).size / 1e6).toFixed(2)} MB, in ${r.dir}`);
  console.log('UNSIGNED: sign manifest.json with the Kingmaker Release key (RSA-PSS SHA-256) at release.');
}
