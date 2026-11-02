// The public asset contract consumed by Ronin Launcher 0.3.13.
//
// The ordinary manifest and detached RSA-PSS signature are separate from the
// Scripture Armor release envelope.  A release with none of the three Armor
// assets is a transitional, unsealed release (the Launcher warns); a partial
// envelope is always invalid.  Production publication requires the complete
// envelope so a release cannot accidentally regress to the transitional path.

import { manifestProblems } from './release-manifest.mjs';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { verifyManifestBytes } from './release-signing.mjs';
import { RELEASE_PUBLIC_KEY_PEM } from './release-pubkey.mjs';

export const MANIFEST_ASSET = 'kingmaker-manifest.json';
export const MANIFEST_SIGNATURE_ASSET = `${MANIFEST_ASSET}.sig`;
export const ARMOR_RELEASE_ASSETS = Object.freeze([
  `${MANIFEST_ASSET}.scripture`,
  'kingmaker-manifest.key.scripture',
  'kingmaker-manifest-pin.json',
]);

/** Pure release-publication checks. Signature/envelope cryptography is checked
 * by the existing release gate and Launcher; this function prevents incomplete
 * or legacy-shaped asset sets from reaching those verifiers. */
export function releaseAssetProblems({ manifest, assets = [], requireSignature = true, requireArmor = true } = {}) {
  const out = manifestProblems(manifest, { forRelease: true }).map((p) => `manifest: ${p}`);
  const names = new Set(assets.map((a) => typeof a === 'string' ? a : a?.name).filter(Boolean));
  if (!names.has(MANIFEST_ASSET)) out.push(`assets: missing ${MANIFEST_ASSET}`);
  if (requireSignature && !names.has(MANIFEST_SIGNATURE_ASSET)) out.push(`assets: missing ${MANIFEST_SIGNATURE_ASSET}`);
  for (const part of manifest?.parts ?? []) {
    if (!names.has(part.name)) out.push(`assets: missing manifest part ${part.name}`);
  }
  const presentArmor = ARMOR_RELEASE_ASSETS.filter((name) => names.has(name));
  if (presentArmor.length > 0 && presentArmor.length !== ARMOR_RELEASE_ASSETS.length) {
    out.push(`assets: partial Scripture Armor envelope (present ${presentArmor.join(', ')}; require ${ARMOR_RELEASE_ASSETS.join(', ')})`);
  } else if (requireArmor && presentArmor.length === 0) {
    out.push(`assets: missing mandatory Scripture Armor envelope (${ARMOR_RELEASE_ASSETS.join(', ')})`);
  }
  return out;
}

export function assertReleaseAssets(input, options) {
  const problems = releaseAssetProblems({ ...input, ...options });
  if (problems.length) throw new Error(`release asset contract failed: ${problems.join('; ')}`);
  return true;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
function regular(path, label, problems) {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink()) problems.push(`${label}: not a regular non-symlink file`);
    return st;
  } catch (e) { problems.push(`${label}: missing (${e.code ?? e.message})`); return null; }
}

/** Check the actual bytes proposed for publication, not just their names.
 * `verifyArmor` must be the governed Scripture Armor verifier. This checkout
 * deliberately has no permissive fallback: absent verifier means no release. */
export async function verifyPhysicalReleaseAssets({ manifestPath, assetsDir, installerDmg, requireInstallerDmg = true, verifyArmor, verifySignature = (bytes, sig) => verifyManifestBytes(bytes, sig, RELEASE_PUBLIC_KEY_PEM) } = {}) {
  const problems = [];
  regular(manifestPath, MANIFEST_ASSET, problems);
  let manifest = null, manifestBytes = null;
  try { manifestBytes = readFileSync(manifestPath); manifest = JSON.parse(manifestBytes); } catch (e) { problems.push(`manifest: unreadable (${e.message})`); }
  const names = manifest ? [MANIFEST_ASSET, MANIFEST_SIGNATURE_ASSET, ...(manifest.parts ?? []).map((p) => p.name), manifest.launcher?.archive, ...ARMOR_RELEASE_ASSETS].filter(Boolean) : [];
  if (manifest) problems.push(...releaseAssetProblems({ manifest, assets: names }));
  for (const part of manifest?.parts ?? []) {
    const path = join(assetsDir, part.name);
    const st = regular(path, part.name, problems);
    if (st && (st.size !== part.size || sha256(readFileSync(path)) !== part.sha256)) problems.push(`${part.name}: bytes do not match manifest size/SHA-256`);
  }
  if (manifest?.launcher?.archive) {
    const path = join(assetsDir, manifest.launcher.archive), st = regular(path, manifest.launcher.archive, problems);
    if (st && (st.size !== manifest.launcher.size || sha256(readFileSync(path)) !== manifest.launcher.sha256)) problems.push(`${manifest.launcher.archive}: bytes do not match launcher pin`);
  }
  const sigPath = `${manifestPath}.sig`;
  if (regular(sigPath, MANIFEST_SIGNATURE_ASSET, problems) && manifestBytes) {
    if (!verifySignature(manifestBytes, readFileSync(sigPath, 'utf8'))) problems.push(`${MANIFEST_SIGNATURE_ASSET}: signature does not verify against pinned release key`);
  }
  const armorPaths = ARMOR_RELEASE_ASSETS.map((name) => join(assetsDir, name));
  const armorFilesOk = armorPaths.every((p, i) => Boolean(regular(p, ARMOR_RELEASE_ASSETS[i], problems)));
  if (armorFilesOk) {
    if (typeof verifyArmor !== 'function') problems.push('Scripture Armor envelope: governed verifier unavailable; refusing publication');
    else {
      try { if (!await verifyArmor({ manifestBytes, manifest, paths: Object.fromEntries(ARMOR_RELEASE_ASSETS.map((n, i) => [n, armorPaths[i]])) })) problems.push('Scripture Armor envelope: cryptographic verification failed'); }
      catch (e) { problems.push(`Scripture Armor envelope: verifier failed (${e.message})`); }
    }
  }
  if (!installerDmg && requireInstallerDmg) problems.push('installer DMG: path is required');
  else {
    const st = regular(installerDmg, 'installer DMG', problems);
    if (st && (!/^Kingmaker-Installer-.+\.dmg$/.test(basename(installerDmg)) || st.size === 0)) problems.push('installer DMG: bad name or empty file');
  }
  return { ok: problems.length === 0, problems, manifest };
}
