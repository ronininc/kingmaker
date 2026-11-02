// The public asset contract consumed by Ronin Launcher 0.3.13.
//
// The ordinary manifest and detached RSA-PSS signature are separate from the
// Scripture Armor release envelope.  A release with none of the three Armor
// assets is a transitional, unsealed release (the Launcher warns); a partial
// envelope is always invalid.  Production publication requires the complete
// envelope so a release cannot accidentally regress to the transitional path.

import { manifestProblems } from './release-manifest.mjs';

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
