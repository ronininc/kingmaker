#!/usr/bin/env node
// Create concrete, hash-correct staging metadata without signing or publishing.
// Production gates still require signature, Armor envelope, issuance and DMG.
import { createHash } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { buildManifest, sha256sums, verifyParts } from '../lib/release-manifest.mjs';

const [archiveArg, launcherArg, outArg] = process.argv.slice(2);
if (!archiveArg || !launcherArg || !outArg) { console.error('usage: stage-unsigned-manifest.mjs <app-archive> <launcher-zip> <manifest-out>'); process.exit(2); }
const archive = resolve(archiveArg), launcher = resolve(launcherArg), out = resolve(outArg), hash = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const version = '4.4.2-recovered.0', tag = 'v4.4.2-recovered.0';
const part = { name: basename(archive), size: statSync(archive).size, sha256: hash(archive) };
const launch = { name: 'Ronin Launcher.app', bundleId: 'org.ronininc.launcher', version: '0.3.13-local-unproven', archive: basename(launcher), format: 'zip', url: null, size: statSync(launcher).size, sha256: hash(launcher), required: true };
const manifest = buildManifest({ version, tag, app: { bundleId: 'com.ronininc.solghost', version, signing: 'ad-hoc; fixture only', unpackedBytes: null }, archive: { name: part.name, size: part.size, sha256: part.sha256 }, parts: [part], partSize: part.size, launcher: launch, requires: { macos: '14.0', arch: 'arm64' } });
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(resolve(dirname(out), 'SHA256SUMS'), sha256sums([part, { name: launch.archive, sha256: launch.sha256 }, { name: basename(out), sha256: hash(out) }]));
writeFileSync(resolve(dirname(out), 'NON-PUBLISHABLE.txt'), 'UNSIGNED LOCAL STAGING ONLY\nMissing: governed manifest signature, issuance provenance, Developer ID/notarization, Installer DMG.\nOptional paid Scripture Armor envelope is not present and is not required for free Kingmaker.\nLauncher 0.3.13 zip was made from the installed local app; exact source provenance is unavailable.\n');
const checked = await verifyParts(manifest, dirname(out), { forRelease: true });
if (!checked.ok) throw new Error(checked.problems.join('; '));
console.log(JSON.stringify({ manifest: out, app: manifest.app, parts: manifest.parts, launcher: manifest.launcher, verified: true }, null, 2));
