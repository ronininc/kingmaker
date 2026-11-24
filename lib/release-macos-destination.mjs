// Dormant signature-bound representation. Current install/update/feed consumers
// intentionally reject kingmaker.release/2. Do not emit /2 until all are ready.
import { MANIFEST_SCHEMA, manifestProblems, launcherProblems, issuanceProblems } from './release-manifest.mjs';
import { verifyManifestBytes } from './release-signing.mjs';
import { RELEASE_PUBLIC_KEY_PEM } from './release-pubkey.mjs';
import { KINGMAKER_BUNDLE_ID } from './release-identity.mjs';
import { appSigningPolicy } from './macos-app-signing-policy.mjs';

export const DESTINATION_MANIFEST_SCHEMA = 'kingmaker.release/2';
export const DESTINATION_POLICY_SCHEMA = 'kingmaker.macos-destination-policy/1';
const POLICY_KEYS = ['bundleId', 'lane', 'schema', 'teamId', 'version'];
const MAX_BYTES = 1024 * 1024;
const HEX64 = /^[a-f0-9]{64}$/;

/** @typedef {{schema:'kingmaker.macos-destination-policy/1',lane:'developer-id',teamId:string,bundleId:'com.ronininc.solghost',version:string}} DeveloperIdDestination */
/** @typedef {{lane:'developer-id',expectedVersion:string,expectedTeam:string} | {lane:'legacy', expectedVersion:string, legacyLeaf:string}} ExpectedAppSigner */

/**
 * Derive the exact app signer requirement from authenticated manifest bytes and
 * an independently selected expected release lane/version/authority.
 * Missing signature, old-to-new ambiguity, or downgrade to /1 under an Apple
 * expectation fails closed. Legacy apps use only the already-approved old leaf;
 * the manifest never supplies a leaf, requirement string, or fallback.
 * This does NOT validate installed app bytes or authorize an installer.
 * @param {Uint8Array} bytes
 * @param {string} signature
 * @param {ExpectedAppSigner} expected
 */
export function parseSignedAppDestination(bytes, signature, expected, { verify = verifyManifestBytes } = {}) {
  const selected = appSigningPolicy(expected);
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > MAX_BYTES
    || typeof signature !== 'string' || !signature.trim() || signature.length > 8192
    || verify(bytes, signature.trim(), RELEASE_PUBLIC_KEY_PEM) !== true) {
    throw new Error('Destination manifest requires a valid signature over the exact bytes.');
  }
  // Only signed bytes can be used for policy selection. No unsigned transport
  // metadata, URL parameters or policy fields are read before authentication.
  const m = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error('Manifest must be an object.');
  const schema = selected.lane === 'developer-id' ? DESTINATION_MANIFEST_SCHEMA : MANIFEST_SCHEMA;
  if (m.schema !== schema) throw new Error('Manifest schema does not match the independently selected destination lane.');
  if (m.product !== 'Kingmaker' || m.version !== selected.expectedVersion || m.tag !== `v${selected.expectedVersion}`
    || m.app?.bundleId !== KINGMAKER_BUNDLE_ID || m.app?.version !== selected.expectedVersion
    || !HEX64.test(m.engine?.sha256 ?? '')) throw new Error('Manifest does not identify the exact selected Kingmaker release.');
  if (selected.lane === 'legacy') {
    if (Object.hasOwn(m, 'destinationSigning')) throw new Error('A legacy manifest cannot carry a destination signer policy.');
    if (manifestProblems(m).length) throw new Error('Legacy manifest payload pins are invalid.');
    return selected;
  }

  const p = m.destinationSigning;
  if (!p || typeof p !== 'object' || Array.isArray(p)
    || Object.keys(p).sort().join(',') !== POLICY_KEYS.join(',')
    || p.schema !== DESTINATION_POLICY_SCHEMA || p.lane !== 'developer-id'
    || p.version !== selected.expectedVersion || p.bundleId !== KINGMAKER_BUNDLE_ID
    || p.teamId !== selected.expectedTeam) throw new Error('Signed Developer ID destination does not match the selected release, app, or Apple Team.');
  // Validate the unchanged payload portion against the existing pin validators,
  // never by downgrading the wire document itself or porting a policy to /1.
  const { destinationSigning: _policy, ...payload } = m;
  const projected = { ...payload, schema: MANIFEST_SCHEMA };
  if (manifestProblems(projected).length || launcherProblems(projected.launcher, { required: true }).length
    || issuanceProblems(projected, { required: true }).length) throw new Error('Developer ID manifest payload pins or provenance are invalid.');
  return selected;
}
