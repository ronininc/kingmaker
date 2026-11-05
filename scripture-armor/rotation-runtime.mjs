// Runtime integration for protected key rotation — SYNTHETIC STORES ONLY.
//
// This module wires the existing fixture-grade pieces (rotation-candidate.mjs,
// key-transition.mjs, retired-key-recovery.mjs) into a file-backed identity
// store with the runtime properties LOCAL-KEY-ROTATION.md requires before the
// Rotate button may exist:
//
//   (a) quiesce protocol   — the store is checkpointed/paused before rotation
//                            and refuses data/sign operations while quiesced
//                            or while an unrecovered rotation journal exists;
//   (b) owner-auth gate    — rotation requires a one-shot, expiring,
//                            binding-exact authorization grant shaped like
//                            mac/LocalKeyAuthorization.swift (opaque,
//                            in-process, non-serializable, 15 s deadline,
//                            bound to action + the exact Swift rotation
//                            binding of snapshot/transition/revision/epoch);
//   (c) rotate + re-encrypt — a prepared candidate generation replaces the
//                            current one; stored data is re-encrypted under
//                            the new identity and verified by decrypting the
//                            pre-rotation ciphertext both via the retired
//                            decryption-only package and via the re-encrypted
//                            copy under the new key alone;
//   (d) restart/recovery   — a write-ahead journal makes an interrupted
//                            rotation recover to exactly one consistent
//                            state: the old generation, or the fully
//                            committed new one. Never neither, never torn;
//   (e) signing transition — signatures made pre-rotation verify against the
//                            previous generation's PUBLIC identity only
//                            during the transition window, resolved through
//                            the verified transition document; after the
//                            window (or a further rotation) they no longer
//                            resolve. Retired signing keys are never kept;
//   (f) peer propagation   — the signed transition document is delivered to
//                            enrolled peers and only authenticated,
//                            replay-resistant acknowledgements (per
//                            key-transition.mjs) count. A peer that does not
//                            ack stays visibly pending/rejected in a durable
//                            propagation record — never silently diverged.
//
// WALLS (not simulated here): the authorization approver is injected — on a
// real device it is LocalAuthentication/device-owner presence inside the
// native host (mac/LocalKeyAuthorization.swift); the transition authority
// signature in production is produced inside the Secure-Enclave-backed
// native vault (mac/ProtectedIdentityVault.swift prepareRotation) — here a
// synthetic enrolled P-256 key held by the caller signs; generation
// snapshots here are plaintext JSON files with mode 0600 because this is a
// synthetic test store — production stores them as native encrypted
// envelopes (mac/ProtectedGenerationStore.swift). Nothing in this module
// knows any real identity, path, or key.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  generateIdentityRecord, identityFromRecord, publicBlock, parsePublicBlock,
  sealPlaintext, parseScriptureFile, verifyFrameSignature, unsealFileKey,
  armorDecode, openSealedFile, signPayload, verifyPayload, fingerprintOfRaw,
} from './armor.mjs';
import { initialKeySnapshot, prepareKeyRotation, validateKeySnapshot } from './rotation-candidate.mjs';
import { publicRevision, verifyTransition, beginAcknowledgements, acknowledgeTransition, acknowledgementStatus } from './key-transition.mjs';
import { openRetiredDecryption } from './retired-key-recovery.mjs';

const ANCHOR_SCHEMA = 'scripture-armor.runtime-anchor/1';
const JOURNAL_SCHEMA = 'scripture-armor.rotation-journal/1';
const WINDOW_SCHEMA = 'scripture-armor.transition-window/1';
const PROP_SCHEMA = 'scripture-armor.propagation/1';
const GRANT_TTL_SECONDS = 15; // mirrors LocalKeyAuthorization.swift
const sha256hex = data => crypto.createHash('sha256').update(data).digest('hex');
function fail(message) { throw Error(`rotation-runtime: ${message}`); }

// Mirror of ProtectedIdentityVault.binding / rotationBinding (Swift):
//   binding(action,data,revision,epoch) =
//     sha256hex( utf8("scripture-armor.native-key-operation/1:<action>:<epoch>:<revision>:")
//                || sha256(data) )
//   rotationBinding(snapshot,transition,revision,epoch) =
//     binding("rotate-transition:<sha256hex(transition)>", snapshot, revision, epoch)
export function rotationBinding(snapshotBytes, transitionBytesBuf, revision, epoch) {
  const transitionHash = sha256hex(transitionBytesBuf);
  const action = `rotate-transition:${transitionHash}`;
  const prefix = Buffer.from(`scripture-armor.native-key-operation/1:${action}:${epoch}:${revision}:`, 'utf8');
  return sha256hex(Buffer.concat([prefix, crypto.createHash('sha256').update(snapshotBytes).digest()]));
}

// ---------------------------------------------------------------------------
// (b) Owner authorization — synthetic approver, native grant shape.
// The grant is an opaque in-process object: its id lives under a Symbol key,
// so JSON serialization carries nothing usable, and it is consumed exactly
// once, only for the exact (action, binding) it was issued for, only before
// its monotonic deadline. A newer authorize() supersedes any pending grant.
// ---------------------------------------------------------------------------
const GRANT_ID = Symbol('rotation-runtime.grant-id');
export class SyntheticOwnerAuthorizer {
  constructor({ approver, clock } = {}) {
    if (typeof approver !== 'function') fail('an approver function is required');
    this.approver = approver; // ({action,binding}) => boolean — synthetic Touch ID stand-in
    this.clock = clock || (() => Number(process.hrtime.bigint()) / 1e9);
    this.generation = 0;
    this.grant = null;
  }
  authorize(action, binding) {
    const request = ++this.generation;
    this.grant = null; // a newer request invalidates an older pending grant
    if (!this.approver({ action, binding })) fail('owner authorization denied or unavailable');
    if (request !== this.generation) fail('owner authorization superseded');
    const grant = Object.freeze({ [GRANT_ID]: crypto.randomUUID() });
    this.grant = { id: grant[GRANT_ID], action, binding, deadline: this.clock() + GRANT_TTL_SECONDS };
    return grant;
  }
  consume(grant, action, binding) {
    const current = this.grant;
    this.grant = null; // one-shot: consumed (or burned) on any consume attempt
    if (!current || !grant || grant[GRANT_ID] !== current.id) return false;
    return current.action === action && current.binding === binding &&
      Number.isFinite(this.clock()) && this.clock() < current.deadline;
  }
  invalidate() { this.generation++; this.grant = null; }
}

// ---------------------------------------------------------------------------
// File helpers — durable, fsync'd, atomic where it matters.
// ---------------------------------------------------------------------------
function writeFileDurable(file, data, mode = 0o600) {
  const fd = fs.openSync(file, 'w', mode);
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function writeAtomic(file, data, mode = 0o600) {
  const tmp = `${file}.tmp-${crypto.randomBytes(6).toString('hex')}`;
  writeFileDurable(tmp, data, mode);
  fs.renameSync(tmp, file);
  fsyncDir(path.dirname(file));
}
function fsyncDir(dir) {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

// ---------------------------------------------------------------------------
// The store.
// ---------------------------------------------------------------------------
export class SyntheticIdentityStore {
  constructor(dir) {
    this.dir = dir;
    this.anchorPath = path.join(dir, 'anchor.json');
    this.journalPath = path.join(dir, 'journal.json');
    this.quiescePath = path.join(dir, 'quiesced');
    this.windowPath = path.join(dir, 'transition-window.json');
    this.propPath = path.join(dir, 'propagation.json');
    this.genDir = path.join(dir, 'generations');
    this.dataDir = path.join(dir, 'data');
    this.quiesced = false;
    this.anchor = null;
    this.snapshot = null;
    this.identity = null;
  }

  static create(dir, { label = 'synthetic', rotationAuthorityPin, deviceId = crypto.randomBytes(32).toString('hex') } = {}) {
    if (fs.existsSync(dir)) fail('store directory already exists');
    if (typeof rotationAuthorityPin !== 'string' || !rotationAuthorityPin) fail('an enrolled rotation authority pin is required');
    fs.mkdirSync(path.join(dir, 'generations'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    const store = new SyntheticIdentityStore(dir);
    const snapshot = initialKeySnapshot(generateIdentityRecord(label), deviceId);
    const bytes = Buffer.from(JSON.stringify(snapshot));
    const revision = publicRevision(publicBlock(identityFromRecord(snapshot.identity)));
    writeFileDurable(path.join(store.genDir, 'gen-0.json'), bytes);
    store.anchor = { schema: ANCHOR_SCHEMA, deviceId, epoch: 0, revision, generation: 'gen-0.json', digest: sha256hex(bytes), rotationAuthorityPin };
    writeAtomic(store.anchorPath, JSON.stringify(store.anchor, null, 2));
    fsyncDir(dir);
    store._load();
    return store;
  }

  // recover:false refuses to open a store with an outstanding journal/quiesce
  // marker (the refusal other runtime entry points must observe mid-rotation).
  static open(dir, { recover = true } = {}) {
    const store = new SyntheticIdentityStore(dir);
    const hasJournal = fs.existsSync(store.journalPath);
    const hasQuiesce = fs.existsSync(store.quiescePath);
    if ((hasJournal || hasQuiesce) && !recover) fail('store is quiesced / has an unrecovered rotation journal — recovery required');
    if (hasJournal || hasQuiesce) store.recover();
    store._load();
    return store;
  }

  _load() {
    this.anchor = readJson(this.anchorPath);
    if (this.anchor.schema !== ANCHOR_SCHEMA) fail('bad anchor');
    const genFile = path.join(this.genDir, this.anchor.generation);
    const bytes = fs.readFileSync(genFile);
    if (sha256hex(bytes) !== this.anchor.digest) fail('generation digest mismatch — torn store refused');
    this.snapshot = JSON.parse(bytes.toString('utf8'));
    if (this.snapshot.deviceId !== this.anchor.deviceId || this.snapshot.epoch !== this.anchor.epoch) fail('anchor/snapshot mismatch — torn store refused');
    this.identity = validateKeySnapshot(this.snapshot);
    if (publicRevision(publicBlock(this.identity)) !== this.anchor.revision) fail('anchor revision mismatch — torn store refused');
    this.quiesced = fs.existsSync(this.quiescePath) || fs.existsSync(this.journalPath);
  }

  enrolledState() {
    return { deviceId: this.anchor.deviceId, epoch: this.anchor.epoch, publicIdentity: publicBlock(this.identity), rotationAuthority: this.anchor.rotationAuthorityPin };
  }

  _assertUsable(operation) {
    if (this.quiesced || fs.existsSync(this.quiescePath) || fs.existsSync(this.journalPath)) {
      fail(`store quiesced — ${operation} refused during rotation`);
    }
  }

  // -- data plane ------------------------------------------------------------
  sealData(name, plaintext) {
    this._assertUsable('seal');
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) fail('bad data name');
    const sealed = sealPlaintext(Buffer.from(plaintext), this.identity, this.identity);
    writeAtomic(path.join(this.dataDir, `${name}.scripture`), sealed.text);
    return sealed.text;
  }

  openData(name) {
    this._assertUsable('open');
    const text = fs.readFileSync(path.join(this.dataDir, `${name}.scripture`), 'utf8');
    return this._openText(text);
  }

  // Open a v4 package addressed to the current generation, or to any retired
  // generation via its decryption-only recovery package. The retired path
  // carries NO signing keys (see retired-key-recovery.mjs decode()).
  _openText(text) {
    const { frame, body } = parseScriptureFile(text);
    if (!verifyFrameSignature(frame, body)) fail('frame signature invalid');
    const payload = armorDecode(body, Buffer.from(frame.armor_seed, 'base64'));
    if (frame.recipient_seal_fp === this.identity.sealFp && frame.recipient_kem_fp === this.identity.kemFp) {
      const key = unsealFileKey(this.identity, frame);
      try { return openSealedFile(key, frame, payload); } finally { key.fill(0); }
    }
    for (const entry of this.snapshot.retired) {
      const pub = parsePublicBlock(entry.publicIdentity);
      const sealFp = fingerprintOfRaw(Buffer.from(pub.seal_pub, 'base64url'));
      const kemFp = fingerprintOfRaw(Buffer.from(pub.kem_pub, 'base64'));
      if (frame.recipient_seal_fp !== sealFp || frame.recipient_kem_fp !== kemFp) continue;
      const recovered = openRetiredDecryption(entry.package, this.identity);
      const key = unsealFileKey(recovered, frame);
      try { return openSealedFile(key, frame, payload); } finally { key.fill(0); }
    }
    fail('no generation in this store can open the package');
  }

  // -- signing plane -----------------------------------------------------------
  sign(body) {
    this._assertUsable('sign');
    return signPayload(this.identity, { type: 'rotation-runtime/test-payload', body });
  }

  // (e) Trusted verification: the signer must be the current generation, or
  // the immediately previous generation while its transition window is open.
  verifyTrusted(doc, { now = Math.floor(Date.now() / 1000) } = {}) {
    if (!verifyPayload(doc)) return false;
    if (doc.from_sign_fp === this.identity.signFp) return true;
    if (!fs.existsSync(this.windowPath)) return false;
    const win = readJson(this.windowPath);
    if (win.schema !== WINDOW_SCHEMA || now >= win.expiresAt) return false;
    const prev = parsePublicBlock(win.previousPublicIdentity);
    const prevSignFp = fingerprintOfRaw(Buffer.from(prev.sign_pub, 'base64url'));
    return doc.from_sign_fp === prevSignFp && win.epoch === this.anchor.epoch;
  }

  // -- (a)+(b)+(c)+(d) rotation ------------------------------------------------
  // requestAuthorization(binding) mirrors the native host flow: the runtime
  // computes the exact binding, the native layer asks the owner, and the
  // resulting grant is consumed inside the prepare step. Any failure before
  // the commit point aborts cleanly to the old generation.
  rotate({ authorizer, requestAuthorization, authorityPrivateKey, enrolledPeers = [], now = Math.floor(Date.now() / 1000), hooks = {} } = {}) {
    this._assertUsable('rotate');
    if (!authorizer || typeof requestAuthorization !== 'function') fail('owner authorization path required');
    if (!authorityPrivateKey) fail('rotation authority key required (synthetic enrolled authority)');
    const fromEpoch = this.anchor.epoch;
    const toEpoch = fromEpoch + 1;
    const journal = { schema: JOURNAL_SCHEMA, phase: 'quiesced', fromEpoch, toEpoch, newRevision: null, newGeneration: `gen-${toEpoch}.json`, transitionId: null, window: null };
    const stagedGen = path.join(this.genDir, `${journal.newGeneration}.staged`);
    const stagedData = [];
    try {
      // (a) quiesce: durable marker first, then journal; every operation
      // (including from a second process) refuses until recovery/commit clears both.
      writeFileDurable(this.quiescePath, JSON.stringify({ at: now, fromEpoch }));
      this.quiesced = true;
      writeAtomic(this.journalPath, JSON.stringify(journal, null, 2));
      hooks.afterPhase?.('quiesced');

      // prepare candidate against the quiesced snapshot
      const candidate = prepareKeyRotation(this.snapshot, { now });
      const candidateSnapshot = JSON.parse(candidate.snapshot.toString('utf8'));
      const newIdentity = validateKeySnapshot(candidateSnapshot);
      journal.newRevision = candidate.revision;
      journal.window = { schema: WINDOW_SCHEMA, previousPublicIdentity: publicBlock(this.identity), epoch: toEpoch, expiresAt: now + 300 };
      writeFileDurable(stagedGen, candidate.snapshot);
      journal.phase = 'prepared';
      writeAtomic(this.journalPath, JSON.stringify(journal, null, 2));
      hooks.afterPhase?.('prepared');

      // (b) owner authorization, bound to the exact candidate
      const binding = rotationBinding(candidate.snapshot, candidate.transition, candidate.revision, toEpoch);
      const grant = requestAuthorization(binding);
      if (!authorizer.consume(grant, 'rotate', binding)) fail('owner authorization grant refused (expired, superseded, replayed, or bound to a different candidate)');
      journal.phase = 'authorized';
      writeAtomic(this.journalPath, JSON.stringify(journal, null, 2));
      hooks.afterPhase?.('authorized');

      // authority-signed transition, self-verified against the enrolled pin
      const document = { ...candidate.publicProof, authoritySignature: crypto.sign('sha256', candidate.transition, authorityPrivateKey).toString('base64') };
      const verified = verifyTransition(document, this.enrolledState(), now);
      if (verified.epoch !== toEpoch || verified.transitionId === undefined) fail('transition self-verification failed');
      journal.transitionId = verified.transitionId;
      journal.document = document;
      journal.enrolledPeers = enrolledPeers.map(p => publicRevision(p));
      writeAtomic(this.journalPath, JSON.stringify(journal, null, 2));

      // (c) verify pre-rotation data opens under the NEW identity via the
      // retired decryption-only package, then re-encrypt every record under
      // the new key and verify the re-encrypted copy with the new key alone.
      const probe = new SyntheticIdentityStore(this.dir);
      probe.snapshot = candidateSnapshot; probe.identity = newIdentity;
      for (const file of fs.readdirSync(this.dataDir).filter(f => f.endsWith('.scripture'))) {
        const originalText = fs.readFileSync(path.join(this.dataDir, file), 'utf8');
        const clear = probe._openText(originalText); // recovery path: retired package, new identity
        const resealed = sealPlaintext(clear, newIdentity, newIdentity);
        const check = probe._openText(resealed.text); // new key alone
        if (!check.equals(clear)) fail(`re-encryption verification failed for ${file}`);
        const stagedFile = path.join(this.dataDir, `${file}.staged`);
        writeFileDurable(stagedFile, resealed.text);
        stagedData.push(stagedFile);
      }
      journal.phase = 'reencrypted';
      writeAtomic(this.journalPath, JSON.stringify(journal, null, 2));
      hooks.afterPhase?.('reencrypted');

      // commit: generation file, then staged data, then the anchor flip
      // (single atomic rename) — the anchor is the commit point.
      fs.renameSync(stagedGen, path.join(this.genDir, journal.newGeneration)); fsyncDir(this.genDir);
      for (const stagedFile of stagedData) { fs.renameSync(stagedFile, stagedFile.replace(/\.staged$/, '')); }
      fsyncDir(this.dataDir);
      writeAtomic(this.windowPath, JSON.stringify(journal.window, null, 2));
      const anchor = { schema: ANCHOR_SCHEMA, deviceId: this.anchor.deviceId, epoch: toEpoch, revision: candidate.revision, generation: journal.newGeneration, digest: sha256hex(candidate.snapshot), rotationAuthorityPin: this.anchor.rotationAuthorityPin };
      writeAtomic(this.anchorPath, JSON.stringify(anchor, null, 2));
      journal.phase = 'committed';
      writeAtomic(this.journalPath, JSON.stringify(journal, null, 2));
      hooks.afterPhase?.('committed');

      // propagation state starts pending for every enrolled peer — rotation
      // is NOT globally complete until acks land (see propagate()).
      if (journal.enrolledPeers.length) {
        const state = beginAcknowledgements(verified.transitionId, journal.enrolledPeers);
        writeAtomic(this.propPath, JSON.stringify({ schema: PROP_SCHEMA, transitionId: state.transitionId, peers: state.peers, document }, null, 2));
      }
      fs.rmSync(this.journalPath, { force: true });
      fs.rmSync(this.quiescePath, { force: true });
      fsyncDir(this.dir);
      this.quiesced = false;
      this._load();
      return { epoch: toEpoch, revision: candidate.revision, transitionId: verified.transitionId, document };
    } catch (error) {
      // A hook that simulates a kill (process exit) never reaches here — the
      // journal on disk is what recovery uses. Ordinary failures abort to the
      // old generation, which was never modified.
      if (error && error.name === 'SimulatedKill') throw error;
      try { this.recover(); this._load(); } catch { /* recovery failure surfaces on next open */ }
      throw error;
    }
  }

  // (d) Recovery: anchor is the commit point. If the anchor already names the
  // journal's target generation, roll forward (finish cleanup); otherwise
  // roll back (drop staged material). Either way exactly one generation is
  // current afterwards and its digest/snapshot are verified by _load().
  recover() {
    const hasJournal = fs.existsSync(this.journalPath);
    let journal = null;
    if (hasJournal) { try { journal = readJson(this.journalPath); } catch { fail('rotation journal corrupt — manual inspection required'); } }
    const anchor = readJson(this.anchorPath);
    if (journal && journal.schema === JOURNAL_SCHEMA) {
      const committed = anchor.epoch === journal.toEpoch && anchor.revision === journal.newRevision;
      if (committed) {
        if (journal.window && !fs.existsSync(this.windowPath)) writeAtomic(this.windowPath, JSON.stringify(journal.window, null, 2));
        if (journal.document && journal.enrolledPeers?.length && !fs.existsSync(this.propPath)) {
          const state = beginAcknowledgements(journal.transitionId, journal.enrolledPeers);
          writeAtomic(this.propPath, JSON.stringify({ schema: PROP_SCHEMA, transitionId: state.transitionId, peers: state.peers, document: journal.document }, null, 2));
        }
        // staged data files that never got renamed are stale duplicates of
        // already-committed re-encryptions; drop them.
        for (const f of fs.readdirSync(this.dataDir).filter(f => f.endsWith('.staged'))) fs.rmSync(path.join(this.dataDir, f), { force: true });
      } else {
        const stagedGen = path.join(this.genDir, `${journal.newGeneration}.staged`);
        fs.rmSync(stagedGen, { force: true });
        // a generation file renamed in but never anchored is unreferenced; drop it
        const orphan = path.join(this.genDir, journal.newGeneration);
        if (anchor.generation !== journal.newGeneration && fs.existsSync(orphan)) fs.rmSync(orphan, { force: true });
        for (const f of fs.readdirSync(this.dataDir).filter(f => f.endsWith('.staged'))) fs.rmSync(path.join(this.dataDir, f), { force: true });
      }
    }
    fs.rmSync(this.journalPath, { force: true });
    fs.rmSync(this.quiescePath, { force: true });
    fsyncDir(this.dir);
    this.quiesced = false;
  }

  // -- (f) peer propagation -----------------------------------------------------
  propagationStatus() {
    if (!fs.existsSync(this.propPath)) return null;
    const record = readJson(this.propPath);
    return acknowledgementStatus({ transitionId: record.transitionId, peers: record.peers });
  }

  // peerAdapters: [{ publicIdentity, deliver(document) -> receipt }]
  // deliver() is the peer's side: it verifies the transition against ITS
  // enrolled copy and returns a signed ack receipt. Any throw, bad receipt,
  // or replay marks that peer 'rejected' in the durable record; a peer that
  // never answers stays 'pending'. Neither is hidden.
  propagate(peerAdapters) {
    if (!fs.existsSync(this.propPath)) fail('no committed transition awaiting propagation');
    const record = readJson(this.propPath);
    let state = { transitionId: record.transitionId, peers: { ...record.peers } };
    const results = {};
    for (const peer of peerAdapters) {
      const revision = publicRevision(peer.publicIdentity);
      if (state.peers[revision] === undefined) { results[revision] = 'not-enrolled'; continue; }
      if (state.peers[revision] === 'acknowledged') { results[revision] = 'already-acknowledged'; continue; }
      try {
        const receipt = peer.deliver(record.document);
        // a peer rejected for a transient/bad delivery may retry; a peer that
        // already acknowledged cannot (acknowledgeTransition rejects replays)
        if (state.peers[revision] === 'rejected') state = { ...state, peers: { ...state.peers, [revision]: 'pending' } };
        state = acknowledgeTransition(state, receipt, peer.publicIdentity);
        results[revision] = 'acknowledged';
      } catch (error) {
        state = { ...state, peers: { ...state.peers, [revision]: 'rejected' } };
        results[revision] = `rejected: ${error.message}`;
      }
    }
    writeAtomic(this.propPath, JSON.stringify({ schema: PROP_SCHEMA, transitionId: state.transitionId, peers: state.peers, document: record.document }, null, 2));
    return { status: acknowledgementStatus(state), results };
  }
}
