// ============================================================================
// LANE-A FOLD MARK (Kingmaker 4.4 Phase 0.1, 2026-10-26) — this folded/ copy
// differs from merged/lib/armor-native.mjs ONLY at the lines marked
// "LANE-A FOLD RP-". Full list in ../FOLD-REPORT.md.
//   RP-3 APPLIED below (openInbound): unsealFileKey(me.sealPriv, frame) ->
//        unsealFileKey(me, frame). Public armor.mjs (v4) requires the full
//        identity for v4 frames; a bare X25519 key is legacy v1-v3 only.
//   RP-1 UNRESOLVED, NOT applied: line "import { Flow, openFlow } from
//        '../scripture-armor/refit-net.mjs'" — refit-net.mjs has NO public-line
//        counterpart and the pure fold removes it, so this module does not
//        load in folded geometry until a coordinator decision (retain
//        refit-net.mjs as merged-only carryover, or drop the flow leg).
//   RP-4 SEMANTIC, no code change: sealPlaintext() is now v4 — it refuses
//        peers whose enrolled block carries no ML-KEM-768 key. Classical
//        (merged-line) peer blocks must be re-shared/re-enrolled; the call
//        site itself is unchanged.
// ============================================================================
// lib/armor-native.mjs — Scripture Armor as Kingmaker's native behavior.
//
// Addendum D is the law of this module: the armor is Kingmaker's
// INSTRUMENT and SKIN, never its governor. This module exists so the
// engine can WIELD the armor — wrap its outgoing traffic, publish its
// hashes wrapped, and read the armor's sensing receipts as provenance.
// It exposes NO path that wraps, cells, catalogs, or gates Kingmaker
// itself: Kingmaker's code is source-available by design (code open,
// traffic wrapped), and wrapSubject() below refuses categorically.
//
// The armor is not reimplemented here. Every cryptographic act is the
// bundled Scripture Armor's own: packages are armor.mjs v3 packages
// (X25519-sealed file key, ChaCha20-Poly1305 AEAD, keyed commitment —
// never a raw plaintext hash — Ed25519-signed frame, per-package
// permuted glyph body), flows are refit-net.mjs flows (Addendum K:
// X25519 flow seal, counter nonces, rolling hash-chain receipts).
// The armor tree is resolved as the engine's sibling directory — the
// same relationship the shipped install unit has (pkg/engine beside
// pkg/scripture-armor).
//
// Loop discipline (the armor's closed loop, kept): every wrap is
// registered as an issuance (armor's issued-log always; the local
// vault daemon too when one is listening — an unreachable daemon
// queues, exactly as armor.mjs itself behaves). Every response is
// return-matched against the canary of the request it answers before
// its contents are trusted; a mismatch is a BEACON, recorded, never
// silently absorbed.

import { mkdirSync, readFileSync, appendFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as armor from '../scripture-armor/armor.mjs';
import { Flow, openFlow } from '../scripture-armor/refit-net.mjs';
import { daemonSocketFor } from '../scripture-armor/daemon-transport.mjs';

export { armor };
export { Flow, openFlow };

const ARMOR_URL = new URL('../scripture-armor/armor.mjs', import.meta.url);
export const ARMOR_SOURCE = fileURLToPath(ARMOR_URL);

/** The engine's armor state lives under the engine state dir. */
export function armorDir(state) { return join(state, 'armor'); }
export function identityDir(state) { return join(armorDir(state), 'identity'); }

function ensureDir0600(dir) { mkdirSync(dir, { recursive: true, mode: 0o700 }); }

function appendJsonl(file, rec) {
  ensureDir0600(join(file, '..'));
  appendFileSync(file, JSON.stringify(rec) + '\n', { mode: 0o600 });
}

function readJsonl(file) {
  try {
    return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// Identity — the engine's own armor identity (created once, 0600 store).
// ---------------------------------------------------------------------------

export function ensureIdentity(state, label = 'kingmaker-engine') {
  const dir = identityDir(state);
  const existing = armor.loadIdentity(dir);
  if (existing) return existing;
  return armor.createIdentity(dir, label);
}

export function publicBlockOf(state) {
  const me = armor.loadIdentity(identityDir(state));
  if (!me) throw new Error('armor-native: no engine armor identity — call ensureIdentity first');
  return armor.publicBlock(me);
}

/** Enrolled peers: name → public identity block (this install's address book). */
export function loadPeers(state) {
  try { return JSON.parse(readFileSync(join(armorDir(state), 'peers.json'), 'utf8')); } catch { return {}; }
}

export function enrollPeer(state, name, blockText) {
  const parsed = armor.parsePublicBlock(blockText); // refuses garbage key material
  const peers = loadPeers(state);
  peers[name] = { block: blockText, label: parsed.label || name, enrolled_at: new Date().toISOString() };
  savePeers(state, peers);
  return peers[name];
}

export function savePeers(state, peers) {
  ensureDir0600(armorDir(state));
  writeFileSync(join(armorDir(state), 'peers.json'), JSON.stringify(peers, null, 2), { mode: 0o600 });
}

export function peerBlock(state, name) {
  const p = loadPeers(state)[name];
  if (!p) throw new Error(`armor-native: peer not enrolled: ${name}`);
  return p.block;
}

/**
 * The sign fingerprint a public identity block commits to — the pin
 * for openInbound's expectSenderSignFp. Derived ONLY from the
 * enrolled block held locally (the address book / the fleet config),
 * never from anything inside an arriving frame: a frame's embedded
 * key is self-asserted, so pinning to it would pin to the attacker.
 */
export function signFpOfBlock(blockText) {
  const parsed = armor.parsePublicBlock(blockText);
  return armor.fingerprintOfRaw(Buffer.from(parsed.sign_pub, 'base64url'));
}

/** Both locally enrolled signing pins; never derive pins from a received frame. */
export function signerPinsOfBlock(blockText) {
  const parsed = armor.parsePublicBlock(blockText);
  return Object.freeze({
    expectSenderSignFp: armor.fingerprintOfRaw(Buffer.from(parsed.sign_pub, 'base64url')),
    expectSenderMldsaFp: parsed.mldsa_pub ? armor.fingerprintOfRaw(Buffer.from(parsed.mldsa_pub, 'base64')) : null,
  });
}

// ---------------------------------------------------------------------------
// Provenance + beacons — the sensing record. Everything the armor sees
// while Kingmaker talks lands here, one JSON line per event, readable
// by the engine's research tools (transparency of media is a READ
// surface: who was touched, who answered, whether the return matched).
// ---------------------------------------------------------------------------

export function recordProvenance(state, rec) {
  appendJsonl(join(armorDir(state), 'provenance.jsonl'), { at: new Date().toISOString(), ...rec });
}

export function readProvenance(state) {
  return readJsonl(join(armorDir(state), 'provenance.jsonl'));
}

export function recordBeacon(state, rec) {
  const full = { at: new Date().toISOString(), kind: 'beacon', ...rec };
  appendJsonl(join(armorDir(state), 'beacons.jsonl'), full);
  try { armor.appendEstateEvent(identityDir(state), full); } catch { /* estate log is best-effort witness */ }
  recordProvenance(state, full);
  return full;
}

export function readBeacons(state) {
  return readJsonl(join(armorDir(state), 'beacons.jsonl'));
}

// ---------------------------------------------------------------------------
// Issuance registration — armor's own registerIssuances against the
// local vault daemon when one is listening (its outbox semantics are
// inherited unchanged: unreachable daemon → queued, never dropped).
// Registration failure NEVER blocks egress and NEVER fabricates
// success: the outcome is written to provenance as what it was.
// ---------------------------------------------------------------------------

async function registerWithDaemon(state, frame) {
  const dir = identityDir(state);
  // This engine's daemon endpoint is anchored on the armor dir itself —
  // the PARENT of the identity store, not the store — and that anchor is
  // preserved exactly by passing the same dir to the transport helper:
  // on POSIX it computes the identical socket path under that dir, and on
  // win32 the pipe name derives from that same dir. (Every other caller
  // anchors on its identity dir; this one's socket has always lived one
  // level up.) The env override stays verbatim — no path resolution —
  // matching submit-transport-guard's identical env pattern.
  const socket = process.env.ARMOR_VAULTD_SOCKET || daemonSocketFor(armorDir(state));
  try {
    const r = await armor.registerIssuances(dir, socket, [frame], { [frame.canary]: { origin: 'egress' } });
    return { synced: r.synced, queued: r.queued, refused: (r.refused || []).length };
  } catch (e) {
    return { synced: 0, queued: 1, refused: 0, error: String(e?.message || e) };
  }
}

// ---------------------------------------------------------------------------
// The wrap — egress only. wrapEgress seals a TRAFFIC payload to an
// enrolled peer. It is the instrument path: Kingmaker sends; the
// armor carries. There is deliberately no variant that takes
// Kingmaker itself as the payload's subject (see wrapSubject).
// ---------------------------------------------------------------------------

export async function wrapEgress(state, plaintext, peerBlockText, { purpose = 'egress' } = {}) {
  const me = armor.loadIdentity(identityDir(state));
  if (!me) throw new Error('armor-native: no engine armor identity — call ensureIdentity first');
  const peer = armor.parsePublicBlock(peerBlockText);
  const buf = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8');
  const { frame, text } = armor.sealPlaintext(buf, me, peer);
  const registration = await registerWithDaemon(state, frame);
  recordProvenance(state, {
    kind: 'wrap', purpose, canary: frame.canary,
    to_seal_fp: frame.recipient_seal_fp, digest_kind: armor.frameDigestKind(frame),
    registration,
  });
  return { text, frame };
}

/** Open a package addressed to this engine. Throws on any armor-level failure. */
export function openInbound(state, text, { expectSenderSignFp = null, expectSenderMldsaFp = null } = {}) {
  const me = armor.loadIdentity(identityDir(state));
  if (!me) throw new Error('armor-native: no engine armor identity — call ensureIdentity first');
  const { frame, body } = armor.parseScriptureFile(String(text));
  if (!armor.verifyFrameSignature(frame, body)) {
    throw new Error('armor-native: frame signature invalid — package refused');
  }
  if (frame.recipient_seal_fp !== me.sealFp) {
    throw new Error('armor-native: package not addressed to this engine — refused');
  }
  if (expectSenderSignFp && frame.sender_sign_fp !== expectSenderSignFp) {
    // Airlock refusal: an answer (or an offered package) signed by
    // anyone other than the pinned, enrolled sender is a breach
    // attempt, not a delivery — beacon it before payload handling.
    recordBeacon(state, {
      event: 'package-unexpected-sender',
      expected_sign_fp: expectSenderSignFp, got_sign_fp: frame.sender_sign_fp,
      canary: frame.canary,
      detail: 'package signed by an identity other than the pinned enrolled sender — refused before payload handling',
    });
    throw new Error(`armor-native: package from unexpected sender ${frame.sender_sign_fp} — refused`);
  }
  if (expectSenderMldsaFp && (frame.v !== 4 || frame.sender_mldsa_fp !== expectSenderMldsaFp)) {
    throw new Error('armor-native: package from unexpected post-quantum signer — refused before payload handling');
  }
  if (frame.expiry && Date.parse(frame.expiry) < Date.now()) {
    // Expiry, mirroring vaultd's semantics exactly (refuse an
    // expired frame; an unstamped frame carries no expiry to break).
    // A package that arrives after its stamped expiry is stale
    // traffic, not a delivery — beacon it before payload handling.
    recordBeacon(state, {
      event: 'package-expired',
      canary: frame.canary, expiry: frame.expiry, sender_sign_fp: frame.sender_sign_fp,
      detail: 'package arrived after its stamped expiry — refused before payload handling',
    });
    throw new Error(`armor-native: package expired ${frame.expiry} — refused`);
  }
  // LANE-A FOLD RP-3 (applied): was armor.unsealFileKey(me.sealPriv, frame) — v4 frames require the identity object (ML-KEM half).
  const fileKey = armor.unsealFileKey(me, frame);
  const payload = armor.armorDecode(body, Buffer.from(frame.armor_seed, 'base64'));
  const plaintext = armor.openSealedFile(fileKey, frame, payload);
  return { plaintext, frame };
}

// ---------------------------------------------------------------------------
// Return-match — the closed loop's second half. A response is trusted
// only when it names the canary of the request it answers, that
// request is in this install's sent ledger, and it has not been
// answered before. Anything else is a beacon.
// ---------------------------------------------------------------------------

function sentFile(state) { return join(armorDir(state), 'sent-ledger.jsonl'); }

export function noteSent(state, { canary, purpose, peer = null }) {
  appendJsonl(sentFile(state), { canary, purpose, peer, at: new Date().toISOString(), answered: false });
}

export function matchReturn(state, canary, { purpose = 'response' } = {}) {
  const file = sentFile(state);
  const entries = readJsonl(file);
  const idx = entries.findIndex((e) => e.canary === canary);
  if (idx < 0) {
    recordBeacon(state, { event: 'return-unknown-canary', canary, purpose, detail: 'response names a request this install never sent' });
    return { ok: false, error: 'return-unknown-canary' };
  }
  if (entries[idx].answered) {
    recordBeacon(state, { event: 'return-replay', canary, purpose, detail: 'this request was already answered once' });
    return { ok: false, error: 'return-replay' };
  }
  entries[idx] = { ...entries[idx], answered: true, answered_at: new Date().toISOString() };
  ensureDir0600(armorDir(state));
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 });
  recordProvenance(state, { kind: 'return-match', canary, purpose, ok: true });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Served ledger — the serving side's half of the replay discipline.
// matchReturn stops a duplicate ANSWER being trusted twice; this
// stops a captured REQUEST being EXECUTED twice: a serving door
// (relay, fleet host, armor peer) claims the request's canary here
// after opening it and BEFORE acting on it. A canary is served
// once; a verbatim re-send is refused (+ beacon) before execution,
// so a replayed non-idempotent action never runs a second time.
//
// The ledger is a state file (served-ledger.jsonl under the armor
// dir, beside sent-ledger.jsonl) — file-backed like every other
// armor-native record, so the protection survives restarts of the
// serving process. It is bounded by the frames' own lifetimes: an
// entry is retained until the frame's stamped expiry passes (after
// which openInbound's expiry check refuses the frame anyway, so
// the entry has nothing left to guard) or, for unstamped frames,
// 24 h from service. Pruning happens on every claim.
// ---------------------------------------------------------------------------

function servedFile(state) { return join(armorDir(state), 'served-ledger.jsonl'); }

const SERVED_FALLBACK_MS = 24 * 3600 * 1000;

// -----------------------------------------------------------------------
// F2 (Codex review 2026-10-26): the served ledger is replay protection,
// so its reader must FAIL CLOSED. The shared readJsonl returns [] on
// any error — right for best-effort records (provenance, beacons), and
// for the sent ledger it degrades to "unknown canary" refusals — but
// for the served ledger [] means "nothing was ever served": a
// malformed or truncated served-ledger.jsonl silently erased replay
// knowledge and claimServed accepted (and rewrote over) it. Here,
// corruption is a hard refusal: the damaged file is renamed aside
// untouched (never overwritten), a quarantine tombstone is left in its
// place, and every claim refuses until the owner reconciles (reviews
// the preserved file, then removes the tombstone). The claim write
// itself is atomic — temp file, fsync, rename, directory fsync — so a
// crash mid-write can no longer truncate the ledger into the corrupt
// state this reader refuses.
// -----------------------------------------------------------------------

function servedQuarantineFile(state) { return join(armorDir(state), 'served-ledger.quarantined'); }

function readServedLedger(state) {
  const file = servedFile(state);
  const tomb = servedQuarantineFile(state);
  if (existsSync(tomb)) {
    let preserved = 'unknown';
    try { preserved = JSON.parse(readFileSync(tomb, 'utf8')).preserved || preserved; } catch {}
    throw new Error(`armor-native: served ledger is quarantined after corruption — claim refused until the owner reconciles (preserved ledger: ${preserved}; remove ${tomb} to resume)`);
  }
  let text;
  try { text = readFileSync(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  try {
    return text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch (e) {
    const preserved = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    ensureDir0600(armorDir(state));
    try { renameSync(file, preserved); } catch {}
    try {
      writeFileSync(servedQuarantineFile(state),
        JSON.stringify({ preserved, at: new Date().toISOString(), error: e.message }) + '\n', { mode: 0o600 });
    } catch {}
    throw new Error(`armor-native: served ledger corrupt (${e.message}) — claim refused; damaged ledger preserved at ${preserved}`);
  }
}

function writeFileAtomic0600(file, text) {
  ensureDir0600(join(file, '..'));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const fd = openSync(tmp, 'w', 0o600);
  try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
  try {
    const dfd = openSync(join(file, '..'), 'r');
    try { fsyncSync(dfd); } finally { closeSync(dfd); }
  } catch {}
}

export function claimServed(state, frame) {
  const now = Date.now();
  const entries = readServedLedger(state).filter((e) => Date.parse(e.until) > now);
  if (entries.some((e) => e.canary === frame.canary)) {
    recordBeacon(state, {
      event: 'package-replay',
      canary: frame.canary, sender_sign_fp: frame.sender_sign_fp,
      detail: 'request canary was already served once — verbatim re-send refused before execution',
    });
    throw new Error(`armor-native: package canary already served — replay refused (${frame.canary})`);
  }
  entries.push({
    canary: frame.canary, sender_sign_fp: frame.sender_sign_fp,
    until: frame.expiry ?? new Date(now + SERVED_FALLBACK_MS).toISOString(),
    served_at: new Date(now).toISOString(),
  });
  writeFileAtomic0600(servedFile(state), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return true;
}

// ---------------------------------------------------------------------------
// Hashes, wrapped. A hash Kingmaker publishes or transmits to the
// fleet travels INSIDE a sealed package; the visible frame carries
// only the v3 keyed commitment (digest_kind 'commit'), which no
// observer can check against the hash. (Owner-side launcher install
// verification is a separate, local act on the matching device and is
// NOT routed through here — see BUILD-REPORT open design point.)
// ---------------------------------------------------------------------------

export async function publishHashWrapped(state, sha256hex, peerBlockText, { subject = 'manifest' } = {}) {
  if (!/^[a-f0-9]{64}$/.test(sha256hex)) throw new Error('armor-native: publishHashWrapped expects a sha256 hex');
  const doc = JSON.stringify({ kind: 'wrapped-hash', subject, sha256: sha256hex, at: new Date().toISOString() });
  return wrapEgress(state, Buffer.from(doc, 'utf8'), peerBlockText, { purpose: 'hash-publication' });
}

// ---------------------------------------------------------------------------
// Addendum D guard. The armor serves Kingmaker; it never processes
// Kingmaker. There is no subject-wrap capability in this module at
// all — this function exists so the refusal is explicit, named, and
// testable rather than an absence someone might "helpfully" fill in.
// ---------------------------------------------------------------------------

export function wrapSubject(subject, _payload) {
  if (subject === 'kingmaker' || subject === 'kingmaker-code' || subject === 'engine') {
    return {
      ok: false,
      error: 'addendum-d-refusal: Kingmaker is never a subject of the armor — it wields the armor (wrapEgress / flowExchange), it is not wrapped, celled, or cataloged by it. Kingmaker code is source-available by design; its traffic is what gets wrapped.',
    };
  }
  return {
    ok: false,
    error: 'armor-native exposes no subject-wrap path at all: this module is egress-only by design (Addendum D). Use wrapEgress for traffic.',
  };
}
