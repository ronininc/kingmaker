/**
 * lib/model-pin-registry.mjs
 *
 * PORTED from ronininc/kingmaker-os contracts/model-pin-registry.ts
 * Source of truth: kingmaker-os. Do not edit here.
 *
 * SHA256 content-addressed model pins. Only ACTIVE pins load.
 * Revoke a pin and the model becomes unloadable. No anonymous weights —
 * every model is identified by its hash before it ever runs.
 */

import { createHash } from 'node:crypto';

export const PIN_STATUS = {
  ACTIVE: 'active',
  REVOKED: 'revoked',
  PENDING: 'pending',
};

export function createRegistry() {
  return { pins: new Map() };
}

/**
 * Pin a model. The pin ID is the SHA256 of the canonical pin record —
 * content-addressed, not assigned.
 */
export function pinModel(registry, { name, sha256, source, abliterated = false, license = 'unknown' }) {
  if (!name || !sha256) {
    throw new Error('pin-registry: name and sha256 are required');
  }
  if (!/^[a-f0-9]{64}$/i.test(sha256)) {
    throw new Error('pin-registry: sha256 must be a 64-char hex string');
  }
  const record = {
    name,
    sha256: sha256.toLowerCase(),
    source,
    abliterated,
    license,
    status: PIN_STATUS.ACTIVE,
    pinnedAt: new Date().toISOString(),
    revokedAt: null,
  };
  const pinId = createHash('sha256').update(JSON.stringify(record)).digest('hex');
  record.pinId = pinId;
  registry.pins.set(pinId, record);
  return record;
}

/** Revoke a pin. The model becomes unloadable immediately. */
export function revokePin(registry, pinId) {
  const record = registry.pins.get(pinId);
  if (!record) {
    throw new Error(`pin-registry: unknown pin ${pinId.slice(0, 12)}...`);
  }
  record.status = PIN_STATUS.REVOKED;
  record.revokedAt = new Date().toISOString();
  return record;
}

/** Can this model load? Only ACTIVE pins. */
export function canLoad(registry, sha256) {
  const needle = sha256.toLowerCase();
  for (const record of registry.pins.values()) {
    if (record.sha256 === needle && record.status === PIN_STATUS.ACTIVE) {
      return { ok: true, record };
    }
  }
  return { ok: false, reason: 'no ACTIVE pin for this sha256 — unpinned weights are refused' };
}

/** List pins, optionally filtered by status. */
export function listPins(registry, status = null) {
  const out = [];
  for (const record of registry.pins.values()) {
    if (!status || record.status === status) out.push(record);
  }
  return out;
}
