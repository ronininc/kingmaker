// lib/fleet-review.mjs — the user → owner → fleet path around lib/ability-pipeline.mjs (2026-11-16).
//
//   packageContribution  (any install)   ONE method from the user's OWN library, only with the user's explicit
//                                        per-item consent AND the install's current fleet consent. Packaged by
//                                        proposeAbility: executable block only (prose, notes, provenance paths,
//                                        author names dropped); secrets / private data / device paths left inside the
//                                        executable block are NOT silently redacted — the method stays local with the
//                                        reasons. Paid curated-corpus items are refused. Records provenance + rights.
//                                        Writes the bundle to <state>/fleet/outbox only: NOTHING is transmitted here
//                                        (there is no fleet transport for abilities yet).
//   createOwnerReviewQueue (owner's private Kingmaker)  a persistent queue of received bundles. Enqueue re-checks
//                                        integrity, per-item consent and the owner's corpus; review runs the
//                                        evidence checks; decide() is the owner's act — approve signs a release with
//                                        the owner ability-approve key (only if the evidence passed), reject signs a
//                                        rejection record. Every item is decided at most once. Nothing is approved by
//                                        default or by timeout.
//   receiveFleetAbility  (any install)   verifies membership (when the policy needs it) with a real verifier, then
//                                        hands the release to acceptAbilityRelease — the only door into the fleet store.
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { acceptAbilityRelease, approveAbility, proposeAbility, reviewProposal, ROLES } from './ability-pipeline.mjs';
import { corpusFingerprints, corpusMatch, fleetPolicy } from './corpus-guard.mjs';
import { FLEET_DISCLOSURE_DIGEST } from './sharing.mjs';

const sha = (x) => createHash('sha256').update(x).digest('hex');
const canonical = (o) => JSON.stringify(o, Object.keys(o).sort());
const userStoreOf = (state) => join(state, 'abilities', 'methods');

/** Package one method of the user's own library for the owner's review. `consent` must be literally true. */
export function packageContribution({ state, methodId, consent, rights, now = () => new Date() }) {
  const keep = (...reasons) => ({ status: 'kept-local', reasons, transmitted: false });
  if (consent !== true) return keep('user_consent_required');
  const store = userStoreOf(state);
  let idx; try { idx = JSON.parse(readFileSync(join(store, 'index.json'), 'utf8')); } catch { return keep('not_in_user_library'); }
  const entry = (idx?.methods ?? []).find((m) => m.id === methodId);
  if (!entry || typeof entry.file !== 'string') return keep('not_in_user_library');
  const path = resolve(store, entry.file);
  if (!path.startsWith(resolve(store) + sep)) return keep('not_in_user_library');
  let text; try { text = readFileSync(path, 'utf8'); } catch { return keep('not_in_user_library'); }
  const corpus = corpusMatch(text, { state }); if (corpus) return keep('paid_corpus_item');
  const r = proposeAbility({ state, methodText: text, rights, now });
  if (r.status !== 'proposed') return { ...r, transmitted: false };
  const bundle = { ...r.bundle, provenance: { origin: 'user-library', methodId, packagedAt: now().toISOString(), strippedBytes: Buffer.byteLength(text) - Buffer.byteLength(r.bundle.text),
    consent: { perItem: true, installFleetConsent: true, disclosureDigest: FLEET_DISCLOSURE_DIGEST } } };
  writeFileSync(join(state, 'fleet', 'outbox', `${bundle.id}-${bundle.version}.proposal.json`), JSON.stringify(bundle, null, 2), { mode: 0o600 });
  return { status: 'packaged', bundle, transmitted: false };
}

/** The owner's review queue in `dir`. `ownerDir` holds the owner role keys; `corpusStores` the owner's corpus source. */
export function createOwnerReviewQueue({ dir, ownerDir, corpusStores = [], now = () => new Date() }) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fileOf = (h) => { if (!/^[a-f0-9]{64}$/.test(String(h))) throw new Error('REVIEW_ITEM_ID_INVALID'); return join(dir, `${h}.json`); };
  const read = (h) => { try { return JSON.parse(readFileSync(fileOf(h), 'utf8')); } catch { return null; } };
  const write = (item) => { const f = fileOf(item.sha256); writeFileSync(`${f}.tmp`, JSON.stringify(item, null, 2), { mode: 0o600 }); renameSync(`${f}.tmp`, f); };
  const fps = () => corpusFingerprints({ stores: corpusStores });
  return {
    enqueue(bundle) {
      const refuse = (reason) => ({ status: 'refused', reason });
      if (bundle?.schema !== 'kingmaker.ability-proposal/1') return refuse('not an ability proposal');
      if (typeof bundle.text !== 'string' || sha(bundle.text) !== bundle.sha256) return refuse('integrity: text does not match its sha256');
      if (bundle.provenance?.consent?.perItem !== true || bundle.consentDigest !== FLEET_DISCLOSURE_DIGEST) return refuse('no recorded per-item user consent under the current disclosure');
      const corpus = corpusMatch(bundle.text, { fps: fps() }); if (corpus) return refuse(corpus);
      const prior = read(bundle.sha256); if (prior) return refuse(`already in the queue (${prior.status})`);
      write({ sha256: bundle.sha256, status: 'pending', receivedAt: now().toISOString(), bundle, evidence: null, decision: null });
      return { status: 'queued', sha256: bundle.sha256 };
    },
    list(status = null) {
      return readdirSync(dir).filter((f) => /^[a-f0-9]{64}\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8'))).filter((i) => !status || i.status === status);
    },
    get: read,
    async review(h, opts = {}) {
      const item = read(h); if (!item) throw new Error('REVIEW_ITEM_UNKNOWN');
      if (item.decision) throw new Error(`REVIEW_ITEM_DECIDED: ${item.status}`);
      item.evidence = await reviewProposal(item.bundle, { ...opts, now }); item.status = 'reviewed'; write(item);
      return item.evidence;
    },
    /** The owner's decision. approve → owner-signed release (refused unless the stored evidence passed). */
    decide(h, { decision, note = '' }) {
      const item = read(h); if (!item) throw new Error('REVIEW_ITEM_UNKNOWN');
      if (item.decision) throw new Error(`REVIEW_ITEM_DECIDED: ${item.status}`);
      if (decision === 'approve') {
        if (!item.evidence) throw new Error('ABILITY_NOT_REVIEWED');
        const release = approveAbility({ bundle: item.bundle, evidence: item.evidence, ownerDir, now });
        item.status = 'approved'; item.decision = { decision, note, at: now().toISOString(), decisionId: release.payload.decisionId }; item.release = release; write(item);
        return { status: 'approved', release };
      }
      if (decision === 'reject') {
        const keyPath = join(ownerDir, 'ability.key.pem');
        if (!existsSync(keyPath)) throw new Error('OWNER_AUTHORITY_REQUIRED');
        const trust = JSON.parse(readFileSync(join(ownerDir, 'trust.json'), 'utf8'));
        const payload = { schema: 'kingmaker.ability-rejection/1', role: ROLES.ability, keyId: trust.ability.keyId, id: item.bundle.id, version: item.bundle.version, sha256: item.sha256, note, rejectedAt: now().toISOString() };
        const rec = { payload, sig: sign(null, Buffer.from(`kingmaker.ability-rejection/1\n${canonical(payload)}`), createPrivateKey(readFileSync(keyPath, 'utf8'))).toString('base64') };
        item.status = 'rejected'; item.decision = { decision, note, at: payload.rejectedAt, record: rec }; write(item);
        return { status: 'rejected', record: rec };
      }
      throw new Error('REVIEW_DECISION_INVALID: approve or reject');
    },
  };
}

/** Receive an owner release on an install: verified membership when the policy needs it, then the single fleet door. */
export async function receiveFleetAbility({ state, release, revocations = [], verifyMembership = null, now = () => new Date() }) {
  let membership = null;
  if (!fleetPolicy(state).freeInstallsReceiveFleetAbilities && typeof verifyMembership === 'function') {
    try { membership = await verifyMembership(); } catch { membership = { ok: false }; }
  }
  return acceptAbilityRelease({ state, release, revocations, membership, now });
}
