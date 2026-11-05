#!/usr/bin/env node
// scripts/installer-plan.mjs — the deterministic installer assembly plan (finish plan Phase 2).
//
// build-installer.sh assembles Kingmaker Installer.app by hand: copy this,
// embed that, sed the version in. Nothing records what SHOULD be in the
// bundle, so a missing embed (the manifest, the pin, the signature) is found
// by an owner, not by the build. This module makes the assembly a PLAN:
//
//   planInstaller({ manifest, manifestText, signed, pin, sources })
//     → the exact file set the bundle must carry, each with its source and
//       sha256, in canonical order, plus a plan hash. Same inputs → same
//       plan, byte for byte (the plan is generated FROM the signed manifest,
//       never edited by hand).
//
//   verifyInstallerBundle({ plan, read })
//     → checks a built bundle against the plan: every planned file present
//       with the planned hash; generated files (the compiled binary, the
//       code signature) present. Extra unplanned files are reported —
//       an installer carries what the plan says, nothing else.
//
// The Swift compile, codesign and DMG steps remain platform acts on the
// release Mac; this plan is what they are verified against.

import { createHash } from 'node:crypto';
import { PLATFORMS, platformsProblems } from '../lib/release-platforms.mjs';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * The release's platform shape, as the plan records it. The Mac INSTALLER
 * bundle only ever carries the macOS artifact set — linux/windows artifacts
 * ship BESIDE the release (mirrored under v<version>/<platform>/), never
 * inside Installer.app — but the plan is the one place a whole release is
 * described, so it records every platform's status, and cross-checks the
 * declared macos set against the manifest's parts (names + sha256 + size):
 * a platforms map that disagrees with the parts is the 0.4.2 split-brain
 * (checks on one payload, archive carrying another) in a new place.
 * A pre-platforms manifest synthesizes macos from its parts, no problems.
 */
export function planPlatforms(manifest) {
  const parts = Array.isArray(manifest?.parts) ? manifest.parts : [];
  if (!manifest?.platforms) {
    return { declared: false, platforms: { macos: { status: 'ready', artifacts: parts.map((p) => p.name), synthesized: true } }, problems: [] };
  }
  const problems = [...platformsProblems(manifest.platforms)];
  const mac = manifest.platforms.macos;
  if (mac?.status === 'ready' && Array.isArray(mac.artifacts)) {
    const byName = new Map(parts.map((p) => [p.name, p]));
    if (mac.artifacts.length !== parts.length) problems.push(`platforms.macos names ${mac.artifacts.length} artifact(s) but the manifest has ${parts.length} part(s)`);
    for (const a of mac.artifacts) {
      const p = byName.get(a?.name);
      if (!p) problems.push(`platforms.macos artifact ${a?.name} is not one of the parts`);
      else if (p.sha256 !== a.sha256 || p.size !== a.size) problems.push(`platforms.macos artifact ${a.name} disagrees with the part of the same name`);
    }
  }
  const platforms = {};
  for (const name of PLATFORMS) if (manifest.platforms[name]) platforms[name] = { status: manifest.platforms[name].status, artifacts: (manifest.platforms[name].artifacts ?? []).map((a) => a.name) };
  return { declared: true, platforms, problems };
}

/** Canonical JSON: recursively key-sorted — the plan hash never depends on
 *  the caller's object key order. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Files the installer bundle always carries from the repo (path → source). */
export const STATIC_FILES = Object.freeze([
  { path: 'Contents/Resources/engine.sh', source: 'installer/engine.sh', executable: true },
  { path: 'Contents/Resources/InstallerIcon.icns', source: 'installer/Resources/InstallerIcon.icns' },
  { path: 'Contents/Resources/RoninCrest.png', source: 'installer/Resources/RoninCrest.png' },
  { path: 'Contents/Resources/TERMS.md', source: 'TERMS.md' },
  { path: 'Contents/Resources/LICENSE', source: 'LICENSE' },
  { path: 'Contents/Resources/COMMERCIAL-LICENSE.md', source: 'COMMERCIAL-LICENSE.md' },
  { path: 'Contents/Resources/THIRD_PARTY_NOTICES.md', source: 'THIRD_PARTY_NOTICES.md' },
  { path: 'Contents/Resources/kingmaker-release-public.pem', source: 'lib/kingmaker-release-public.pem' },
]);

/** Files produced by the build itself (presence-checked, not hash-checked:
 *  the signer and compiler own their bytes). */
export const GENERATED_FILES = Object.freeze([
  { path: 'Contents/MacOS/Kingmaker Installer', note: 'compiled from installer/KingmakerInstaller.swift' },
  { path: 'Contents/Info.plist', note: 'installer/Info.plist with @VERSION@/@RELEASE@ substituted from the manifest' },
  { path: 'Contents/PkgInfo', note: 'the APPL???? type stamp' },
]);

/**
 * planInstaller({ manifest, manifestText, manifestSig, pin, fileBytes })
 *   manifest      the parsed release manifest
 *   manifestText  its exact bytes (what gets embedded, what was signed)
 *   manifestSig   the detached signature bytes, or null when unsigned
 *   pin           { sha1 } of the release identity, or null
 *   fileBytes     (sourcePath) => Buffer for STATIC_FILES + the pin file
 * Signing state is part of the plan: an unsigned plan says UNSIGNED in its
 * hash — an installer built from it can never be mistaken for a signed one.
 */
export function planInstaller({ manifest, manifestText, manifestSig = null, pin = null, fileBytes }) {
  if (!manifest || !manifestText) throw new Error('installer-plan: a manifest and its exact text are required');
  if (typeof fileBytes !== 'function') throw new Error('installer-plan: fileBytes(source) is required');
  const files = [];
  for (const f of STATIC_FILES) {
    const bytes = fileBytes(f.source);
    files.push({ ...f, sha256: sha256(bytes), size: bytes.length });
  }
  const manifestBytes = Buffer.isBuffer(manifestText) ? manifestText : Buffer.from(String(manifestText));
  files.push({ path: 'Contents/Resources/kingmaker-manifest.json', source: 'release manifest', sha256: sha256(manifestBytes), size: manifestBytes.length });
  if (manifestSig) {
    const sigBytes = Buffer.isBuffer(manifestSig) ? manifestSig : Buffer.from(String(manifestSig));
    files.push({ path: 'Contents/Resources/kingmaker-manifest.json.sig', source: 'detached manifest signature', sha256: sha256(sigBytes), size: sigBytes.length });
  }
  if (pin?.sha1) {
    const pinBytes = fileBytes('lib/release-identity.json');
    files.push({ path: 'Contents/Resources/release-identity.json', source: 'lib/release-identity.json', sha256: sha256(pinBytes), size: pinBytes.length });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  const plan = {
    schema: 'kingmaker.installer-plan/1',
    version: String(manifest.version),
    tag: String(manifest.tag),
    signed: Boolean(manifestSig),
    pinnedIdentity: pin?.sha1 ?? null,
    // The release's platform shape (planPlatforms): the bundle below is the
    // macOS installer; other platforms' artifacts ride beside the release.
    platforms: planPlatforms(manifest),
    files,
    generated: GENERATED_FILES,
  };
  return { ...plan, planHash: sha256(Buffer.from(canonical(plan))) };
}

/**
 * verifyInstallerBundle({ plan, read, list })
 *   read(path) -> Buffer | null      list() -> [all paths in the bundle]
 * Returns { ok, problems } — missing planned files, hash mismatches,
 * missing generated files, and unplanned extras (signature internals
 * under _CodeSignature/ and Contents/MacOS are the only tolerated extras,
 * and the binary itself is a planned generated file).
 */
export function verifyInstallerBundle({ plan, read, list }) {
  const problems = [];
  for (const p of plan.platforms?.problems ?? []) problems.push(`platforms: ${p}`);
  const present = new Set(list());
  const planned = new Set();
  for (const f of plan.files) {
    planned.add(f.path);
    const bytes = read(f.path);
    if (!bytes) { problems.push(`missing planned file: ${f.path}`); continue; }
    if (sha256(bytes) !== f.sha256) problems.push(`hash mismatch: ${f.path} (bundle carries different bytes than the plan)`);
  }
  for (const g of plan.generated) {
    planned.add(g.path);
    if (!present.has(g.path)) problems.push(`missing generated file: ${g.path} (${g.note})`);
  }
  for (const p of present) {
    if (planned.has(p)) continue;
    if (p.startsWith('Contents/_CodeSignature/') || p === 'Contents/_CodeSignature/CodeResources') continue;
    problems.push(`unplanned file in the bundle: ${p}`);
  }
  if (!plan.signed && present.has('Contents/Resources/kingmaker-manifest.json.sig')) {
    problems.push('the plan is UNSIGNED but the bundle carries a signature file (stale embed — the 0.4.1 trap)');
  }
  return { ok: problems.length === 0, problems };
}
