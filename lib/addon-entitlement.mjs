// lib/addon-entitlement.mjs — the engine's paid-add-on verifiers, wired to the pinned keys and the update host.
//
// loadAddons()/installAddon() (lib/addons.mjs) delegate the two cryptographic gates to functions the engine injects.
// This module builds them for the real Kingmaker:
//   verifyManifest    — the Release-key RSA-PSS check over the manifest's exact bytes (addons.mjs defaultVerifiers).
//   verifyEntitlement — the ES256 install-cert signature check (sku + expiry, and installId/deviceSha256 when the Mac
//                       knows its own) PLUS /cert-status revocation, cached with a few days' offline grace then off.
// Both FAIL CLOSED: a missing pinned key, a bad signature, or no fresh revocation answer past the grace window → not
// entitled, so the add-on does not load. The pinned keys live in lib/*.pem (public, safe to commit); revocation is the
// same /cert-status the install certificate already uses (docs/addons.md §4), reached with the Mac's update key.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CERT_KEY_PEM, RELEASE_KEY_PEM, defaultVerifiers, verifyEntitlementEnvelope } from './addons.mjs';

const DAY = 86_400_000;

/** The id revocation is keyed by: the entitlement's opaque order ref, else installId:sku. Matches the update host. */
export function entitlementId(claims) {
  return String(claims?.order || `${claims?.installId || ''}:${claims?.sku || ''}`);
}

/**
 * Ask the update host whether this entitlement (or its install id) is revoked, caching the answer with an offline
 * grace window. Returns true = revoked OR no trustworthy answer (fail closed); false = good. Never throws.
 *   config   — { url, key } from readUpdateConfig (null when this Mac has no update host → can't check → fail closed).
 *   cacheFile — where the last answer is kept ({ revoked, at }, 0600).
 *   graceMs  — how long a cached "not revoked" is trusted while the host is unreachable (default 3 days).
 */
export async function checkRevoked({ config, entId, installId = '', cacheFile, now = Date.now, fetchImpl = fetch, graceMs = 3 * DAY, timeoutMs = 10_000 }) {
  let cache = null;
  try { cache = JSON.parse(readFileSync(cacheFile, 'utf8')); } catch { /* none yet */ }
  if (config && config.url && config.key) {
    try {
      const url = `${config.url}/cert-status?entitlement=${encodeURIComponent(entId)}&install=${encodeURIComponent(installId)}`;
      const r = await fetchImpl(url, { headers: { Authorization: `Bearer ${config.key}` }, signal: AbortSignal.timeout(timeoutMs) });
      if (r.ok) {
        const revoked = Boolean((await r.json())?.revoked);
        try { mkdirSync(dirname(cacheFile), { recursive: true }); writeFileSync(cacheFile, JSON.stringify({ revoked, at: now() }), { mode: 0o600 }); } catch { /* best effort */ }
        return revoked;
      }
    } catch { /* offline or host error: fall back to the cache below */ }
  }
  // No fresh answer: trust a recent "not revoked" within the grace window; otherwise fail closed.
  if (cache && typeof cache.at === 'number' && (now() - cache.at) <= graceMs) return Boolean(cache.revoked);
  return true;
}

/**
 * The injected verifiers for addons.mjs. `install` ({ installId, deviceSha256 }) binds the entitlement to this Mac
 * when the values are known; absent fields are simply not checked (the signature, sku, expiry and revocation still
 * are). `config`/`cacheDir` drive the revocation check. Custom PEMs / fetch / clock for tests.
 */
export function makeAddonVerifiers({ install = {}, config = null, cacheDir, certKeyPem = CERT_KEY_PEM, releaseKeyPem = RELEASE_KEY_PEM, now = Date.now, fetchImpl = fetch, graceMs = 3 * DAY } = {}) {
  const base = defaultVerifiers({ releaseKeyPem, certKeyPem, now });
  return {
    verifyManifest: base.verifyManifest,
    verifyEntitlement: async (ent, ctx = {}) => {
      if (!base.verifyEntitlement(ent, { sku: ctx.sku, install })) return false; // signature + sku + install binding + expiry
      const claims = verifyEntitlementEnvelope(ent, certKeyPem);
      if (!claims) return false;
      const entId = entitlementId(claims);
      const cacheFile = join(cacheDir, `revocation-${entId.replace(/[^\w.-]/g, '_')}.json`);
      const revoked = await checkRevoked({ config, entId, installId: claims.installId, cacheFile, now, fetchImpl, graceMs });
      return !revoked;
    },
  };
}
