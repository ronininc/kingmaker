// lib/paid-access.mjs — Kingmaker's check before invoking a PAID capability (owner, 2026-11-16): Scripture Armor and its
// Little Brother toolkit belong to the $99/month individual offer, not the free tier. Kingmaker invokes Armor-provided
// tools only with a VERIFIED entitlement, using the existing paid-add-on verifier (lib/addon-entitlement.mjs): ES256
// signature against the pinned install-cert key, SKU, expiry, and /cert-status revocation with its existing 3-day
// offline grace (then fail closed). The free runtime and the user's own methods never pass through this check.
// Proposed SKU (owner decision pending): "scripture-armor" for Armor + Little Brother; the curated corpus uses
// "library.methods" at its download route. Nothing here can stop someone running Armor's binaries outside Kingmaker,
// or delete copies already on disk; it governs what Kingmaker itself will invoke.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeAddonVerifiers } from './addon-entitlement.mjs';
import { readUpdateConfig } from './update.mjs';

export const ARMOR_SKU = 'scripture-armor';

export function createPaidAccess(state, { verifiers = null } = {}) {
  const v = verifiers ?? makeAddonVerifiers({ install: {}, config: readUpdateConfig(state), cacheDir: join(state, 'entitlements', '.cache') });
  return async function check(sku = ARMOR_SKU) {
    let ent; try { ent = JSON.parse(readFileSync(join(state, 'entitlements', `${sku}.json`), 'utf8')); } catch { ent = null; }
    if (!ent) return { ok: false, reason: `Scripture Armor and its Little Brother toolkit are part of the paid individual membership; this install has no ${sku} entitlement. Your own methods and free Kingmaker keep working.` };
    const ok = await v.verifyEntitlement(ent, { sku });
    return ok ? { ok: true } : { ok: false, reason: `the ${sku} entitlement could not be verified as current (invalid, expired, revoked, or no revocation answer within the 3-day offline grace) — Armor tools are not invoked` };
  };
}
