/**
 * weightsynth-registry.mjs — parents, recipes, pins, evidence, exports.
 *
 * The registry is the IP store's working face (SPEC.md): recipes,
 * parentage and Judge records live here — the small, un-rebuildable
 * assets. Weights themselves are cache: rebuildable from any recipe.
 *
 * Discipline enforced in code:
 *   - Parents are addressed by sha256 only, each carrying a license.
 *     A merge inherits the STRICTEST parent license; license-dirty
 *     parents (unknown / noncommercial / proprietary) refuse at
 *     recipe time. No override exists in this module.
 *   - A pin records full parentage + Judge scores + the recipe id.
 *     Loading a weight requires the pin's detached ed25519 signature
 *     to verify against the founder's public key AND the artifact hash
 *     to match. The private key never enters this module: signing is
 *     a founder act performed by the host with the offline key.
 *   - The brains' export is built from metadata by whitelist. It is
 *     structurally incapable of carrying tensor bytes.
 */

import { sign as edSign, verify as edVerify, createPublicKey, createPrivateKey } from 'node:crypto';
import { canonicalStringify, contentId, sha256Hex, hashTensorSet } from './weightsynth-core.mjs';

const HEX64 = /^[0-9a-f]{64}$/;

/* ------------------------------------------------------------------ */
/* Licenses                                                             */
/* ------------------------------------------------------------------ */

/** Strictness ladder. Higher = more restrictive. A merge inherits max. */
export const LICENSE_STRICTNESS = Object.freeze({
  'public-domain': 0, 'CC0-1.0': 0, 'MIT': 1, 'BSD-3': 1, 'Apache-2.0': 1,
  'MPL-2.0': 2, 'LGPL-3.0': 2, 'GPL-3.0': 3, 'AGPL-3.0': 3,
  'noncommercial': 4, 'proprietary': 4, 'unknown': 5,
});

export function licenseOf(parents) {
  let worst = null;
  for (const p of parents) {
    const s = LICENSE_STRICTNESS[p.license];
    if (s === undefined) throw new Error(`REFUSE: parent license "${p.license}" is not on the ladder — classify it first`);
    if (worst === null || s > LICENSE_STRICTNESS[worst]) worst = p.license;
  }
  return worst;
}

export function isLicenseDirty(license) {
  return (LICENSE_STRICTNESS[license] ?? 5) >= 4;
}

/* ------------------------------------------------------------------ */
/* Parents                                                              */
/* ------------------------------------------------------------------ */

export function createParentRegistry() {
  const parents = new Map();
  return {
    register({ hash, license, source, tensors = null }) {
      if (!HEX64.test(hash || '')) throw new Error('REFUSE: parent must be registered by sha256');
      if (LICENSE_STRICTNESS[license] === undefined) throw new Error(`REFUSE: license "${license}" is not on the ladder`);
      if (!source || typeof source !== 'string') throw new Error('REFUSE: parent requires a source (where it came from is part of the pin)');
      if (tensors) {
        // Verify the claimed hash against the actual tensors when the
        // host hands them over — a registry entry that lies is worse
        // than none.
        const actual = hashTensorSet(tensors);
        if (actual !== hash) throw new Error(`REFUSE: parent hash mismatch (claimed ${hash.slice(0, 12)}…, actual ${actual.slice(0, 12)}…)`);
      }
      parents.set(hash, { hash, license, source });
      return parents.get(hash);
    },
    get(hash) { return parents.get(hash) || null; },
    require(hash) {
      const p = parents.get(hash);
      if (!p) throw new Error(`REFUSE: parent ${String(hash).slice(0, 12)}… not registered`);
      return p;
    },
    /** Recipe-time gate: all parents known + none license-dirty. */
    checkRecipe(recipe) {
      const ps = recipe.parents.map((h) => this.require(h));
      for (const p of ps) {
        if (isLicenseDirty(p.license)) {
          throw new Error(`REFUSE: parent ${p.hash.slice(0, 12)}… is license-dirty (${p.license}) — dirty parents refuse at recipe time`);
        }
      }
      return { parents: ps, inheritedLicense: licenseOf(ps) };
    },
    list() { return [...parents.values()]; },
  };
}

/* ------------------------------------------------------------------ */
/* Pins                                                                 */
/* ------------------------------------------------------------------ */

/** The record that gets signed. Everything the router needs to trust
 *  an artifact, and nothing it doesn't. */
export function pinRecord({ recipeId, artifactHash, parentHashes, inheritedLicense, judge, twinSpecHash }) {
  if (!HEX64.test(recipeId || '') || !HEX64.test(artifactHash || '')) {
    throw new Error('REFUSE: pin requires a recipe id and an artifact hash');
  }
  return {
    kind: 'weightsynth-pin', version: 1,
    recipeId, artifactHash,
    parents: [...parentHashes].sort(),
    inheritedLicense,
    judge: { quality: judge.quality, production: judge.production, suite: judge.suite ?? null },
    twinSpecHash,
  };
}

export function pinId(record) {
  return contentId(record);
}

/** FOUNDER ACT (host-side, offline key): sign a pin record. This
 *  module never stores the key; the host passes it in at pin time. */
export function signPin(record, privateKeyPem) {
  const key = createPrivateKey(privateKeyPem);
  const sig = edSign(null, Buffer.from(canonicalStringify(record), 'utf8'), key);
  return sig.toString('base64');
}

/**
 * The router's load gate. An artifact may be served ONLY when:
 *   1. its bytes hash to the pin's artifactHash, and
 *   2. the pin's detached signature verifies against the founder's
 *      public key.
 * Anything else refuses — unsigned, tampered, or mis-pinned alike.
 */
export function verifyForLoad({ record, signatureB64, artifactHash, publicKeyPem }) {
  if (!record || record.kind !== 'weightsynth-pin') throw new Error('REFUSE load: not a pin record');
  if (artifactHash !== record.artifactHash) {
    throw new Error('REFUSE load: artifact hash does not match the pin (tampered or wrong artifact)');
  }
  if (!signatureB64) throw new Error('REFUSE load: unsigned pin — the router serves signed weights only');
  const key = createPublicKey(publicKeyPem);
  const ok = edVerify(null, Buffer.from(canonicalStringify(record), 'utf8'), key, Buffer.from(signatureB64, 'base64'));
  if (!ok) throw new Error('REFUSE load: pin signature does not verify against the founder key');
  return { ok: true, pinId: pinId(record) };
}

/* ------------------------------------------------------------------ */
/* The brains' export — scores and descriptors, never weights          */
/* ------------------------------------------------------------------ */

const BRAIN_EXPORT_KEYS = Object.freeze(['kind', 'recipeId', 'artifactHash', 'inheritedLicense', 'judge', 'twinSpecHash']);

/** Built by whitelist from a pin record. Tensor bytes cannot cross:
 *  they are never read here, and no other key can pass. */
export function brainExport(record) {
  const out = {};
  for (const k of BRAIN_EXPORT_KEYS) {
    if (k === 'judge') out.judge = { quality: record.judge.quality, production: record.judge.production, suite: record.judge.suite };
    else if (k === 'kind') out.kind = 'weightsynth-pin-export';
    else out[k] = record[k];
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Evidence intake — research proposes, the Mac disposes                */
/* ------------------------------------------------------------------ */

export const HARDWARE_PROFILES = Object.freeze({
  'm3-8gb': Object.freeze({ ramGB: 8, weightBudgetGB: 5.5, label: 'Apple M3, 8 GB unified' }),
  'm5pro-24gb': Object.freeze({ ramGB: 24, weightBudgetGB: 19, label: 'Apple M5 Pro, 24 GB unified' }),
});

export const EVIDENCE_CLASSES = Object.freeze(['measured', 'reported', 'vendor-claim']);

/**
 * A shortlist entry. `source` is mandatory and must be a citation the
 * founder can re-open. `vendor-claim` entries are leads: they may
 * inform a search but can never pass screening — a number nobody
 * independent has reproduced is not evidence (the Edge0 lesson).
 */
export function shortlistEntry({ candidate, source, evidenceClass, profile, footprintGB, note = '' }) {
  if (!candidate || typeof candidate !== 'string') throw new Error('REFUSE shortlist: candidate name required');
  if (!source || typeof source !== 'string') throw new Error('REFUSE shortlist: a source citation is required — unsourced numbers are not evidence');
  if (!EVIDENCE_CLASSES.includes(evidenceClass)) throw new Error(`REFUSE shortlist: evidenceClass must be one of ${EVIDENCE_CLASSES.join('/')}`);
  if (!HARDWARE_PROFILES[profile]) throw new Error(`REFUSE shortlist: unknown hardware profile ${profile}`);
  if (typeof footprintGB !== 'number' || !(footprintGB > 0)) throw new Error('REFUSE shortlist: footprintGB must be a positive number');
  return { candidate, source, evidenceClass, profile, footprintGB, note, id: contentId({ candidate, source, profile }) };
}

/** Screening: envelope + evidence class. Returns survivors and the
 *  refused, each refusal with its reason — the whittling is auditable. */
export function screenShortlist(entries, profile) {
  const prof = HARDWARE_PROFILES[profile];
  if (!prof) throw new Error(`REFUSE screen: unknown hardware profile ${profile}`);
  const survivors = [], refused = [];
  for (const e of entries) {
    if (e.evidenceClass === 'vendor-claim') { refused.push({ id: e.id, reason: 'vendor-claim — a lead, never evidence' }); continue; }
    if (e.profile !== profile) { refused.push({ id: e.id, reason: `profiled for ${e.profile}, not ${profile}` }); continue; }
    if (e.footprintGB > prof.weightBudgetGB) { refused.push({ id: e.id, reason: `footprint ${e.footprintGB} GB exceeds the ${profile} weight budget ${prof.weightBudgetGB} GB` }); continue; }
    survivors.push(e);
  }
  return { survivors, refused };
}

/** Stable digest of a screening run, for the audit chain. */
export function screeningReceipt(screened, profile) {
  return {
    kind: 'weightsynth-screening', profile,
    survivors: screened.survivors.map((e) => e.id),
    refused: screened.refused,
    digest: sha256Hex(JSON.stringify({ s: screened.survivors.map((e) => e.id), r: screened.refused })),
  };
}
