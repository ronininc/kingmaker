#!/usr/bin/env node
// refit-store.mjs — Addendum M store discipline (M.1, M.19, M.26).
//
// Three mechanisms share one shape here — the append-only hash chain:
//
//   M.1  The vault registry stops being a file anything running as the
//        owner can quietly rewrite. Every registry save appends a
//        chain entry binding the exact bytes written; the chain head
//        is countersigned by a SECOND estate node (the anchor), which
//        only ever advances a monotonic sequence. Consumption reads
//        verify: local chain intact, head == the anchor's attested
//        head, no unanchored state older than this operation. An edit,
//        a truncation, or a replayed older head diverges from the
//        anchor and refuses at read time — prevention, not detection.
//
//   M.26 The armor's own logs get the same discipline: log files are
//        rotated into segments; each segment is hash-chained and then
//        SEALED as an ordinary package to a dedicated log identity,
//        so the at-rest log store is armored packages, not plaintext.
//        A stolen segment is ciphertext; an altered line breaks the
//        chain and names the segment.
//
//   M.19 Budgets: per-origin counters with epoch rollover, enforced at
//        the gates before any state is touched. Forged input is
//        refused by the signature gate first (cheap); authenticated
//        abuse burns only the abuser's own budget.
//
// Zero-dependency Node >= 22, same discipline as armor.mjs: canonical
// JSON field lists, Ed25519 signatures, mode-0600 store files.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  loadIdentity, sealPlaintext, parseScriptureFile, unsealFileKey, openSealedFile,
  signPayload, verifyPayload, fingerprintOfRaw, sha256Hex, armorDecode,
} from './armor.mjs';

export { sha256Hex };

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
}
function writeSecret(file, data) {
  fs.writeFileSync(file, data, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
}

// ---------------------------------------------------------------------------
// Generic append-only hash chain (JSONL). Entry: {seq, prev, digest, head}
// where head = sha256(prev | seq | digest). Genesis prev = 'GENESIS'.
// ---------------------------------------------------------------------------

export function chainHeadOf(prev, seq, digest) {
  return sha256Hex(Buffer.from(`${prev}|${seq}|${digest}`, 'utf8'));
}

export function readChain(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n')
      .filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch { return []; }
}

export function appendChain(file, digest) {
  const entries = readChain(file);
  const seq = entries.length + 1;
  const prev = entries.length ? entries[entries.length - 1].head : 'GENESIS';
  const entry = { seq, prev, digest, head: chainHeadOf(prev, seq, digest) };
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
  return entry;
}

// Full re-walk: every link recomputed. Returns {ok, entries} or
// {ok:false, at: seq, error}.
export function verifyChain(file) {
  const entries = readChain(file);
  let prev = 'GENESIS';
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.seq !== i + 1) return { ok: false, at: e.seq ?? i + 1, error: 'chain-sequence-gap' };
    if (e.prev !== prev) return { ok: false, at: e.seq, error: 'chain-prev-mismatch' };
    if (chainHeadOf(e.prev, e.seq, e.digest) !== e.head) {
      return { ok: false, at: e.seq, error: 'chain-head-mismatch' };
    }
    prev = e.head;
  }
  return { ok: true, entries, head: prev === 'GENESIS' ? null : prev, seq: entries.length };
}

// ---------------------------------------------------------------------------
// M.1 — the anchored registry chain.
//
// Files in the vault store:
//   registry-chain.jsonl   one entry per registry save; digest binds
//                          the exact registry.json bytes of that save.
//   registry-anchor.json   the anchor's latest signed attestation
//                          {seq, head, by_sign_fp, at, sig} as a mesh doc.
// The anchor node keeps anchor-state.json {seq, head, vault_sign_fp}
// and only advances it (handleAnchorHead below is the anchor side,
// usable by any daemon-role process; vaultd wires it into its mesh
// handler).
// ---------------------------------------------------------------------------

export const registryChainFile = (dir) => path.join(dir, 'registry-chain.jsonl');
export const registryAnchorFile = (dir) => path.join(dir, 'registry-anchor.json');
export const anchorStateFile = (dir) => path.join(dir, 'anchor-state.json');

export function digestOfFileBytes(file) {
  try { return sha256Hex(fs.readFileSync(file)); } catch { return null; }
}

// Called by the daemon after every registry save (refit mode).
export function chainRegistrySave(dir, registryFile) {
  const digest = digestOfFileBytes(registryFile);
  if (!digest) return null;
  return appendChain(registryChainFile(dir), digest);
}

// The anchor's attestation is a signed mesh document (armor.mjs
// signPayload discipline) of type 'anchor-attest' whose body carries
// {seq, head}. Verify: signature valid AND signer is the expected
// anchor identity.
export function verifyAttestation(doc, expectedAnchorSignFp) {
  if (!doc || doc.type !== 'anchor-attest') return false;
  if (expectedAnchorSignFp && doc.from_sign_fp !== expectedAnchorSignFp) return false;
  if (!doc.body || typeof doc.body.seq !== 'number' || !doc.body.head) return false;
  return verifyPayload(doc);
}

export function loadAttestation(dir) {
  try { return JSON.parse(fs.readFileSync(registryAnchorFile(dir), 'utf8')); } catch { return null; }
}

export function saveAttestation(dir, doc) {
  // Regression guard: a slower anchor round must never overwrite a
  // NEWER attestation with an older one — the file only advances.
  const existing = loadAttestation(dir);
  if (existing && doc && typeof existing.body?.seq === 'number'
    && typeof doc.body?.seq === 'number' && existing.body.seq > doc.body.seq) return;
  writeSecret(registryAnchorFile(dir), JSON.stringify(doc, null, 2));
}

// Anchor side: advance-only countersigning. `me` is the anchor node's
// identity; `state` is its anchor-state.json content. Returns either
// {error} or {attestation, state} — the caller persists `state`.
export function anchorAdvance(me, state, vaultSignFp, head, seq) {
  const st = state && typeof state === 'object' ? state : { seq: 0, head: null, vault_sign_fp: null };
  if (st.vault_sign_fp && st.vault_sign_fp !== vaultSignFp) {
    return { error: 'anchor-bound-to-other-vault' };
  }
  if (typeof seq !== 'number' || seq <= st.seq) {
    return { error: 'anchor-sequence-not-advancing' };
  }
  if (!head || typeof head !== 'string') return { error: 'anchor-head-missing' };
  const next = { seq, head, vault_sign_fp: vaultSignFp };
  const attestation = signPayload(me, {
    type: 'anchor-attest', to_seal_fp: null,
    body: { seq, head, vault_sign_fp: vaultSignFp },
  });
  return { attestation, state: next };
}

export function loadAnchorState(dir) {
  try {
    const st = JSON.parse(fs.readFileSync(anchorStateFile(dir), 'utf8'));
    if (st && typeof st === 'object') return st;
  } catch {}
  return { seq: 0, head: null, vault_sign_fp: null };
}

export function saveAnchorState(dir, st) {
  writeSecret(anchorStateFile(dir), JSON.stringify(st, null, 2));
}

// The consumption-side verification (M.1 acceptance in one function).
//   dir             vault store
//   registryFile    the registry.json the daemon is about to trust
//   anchorSignFp    expected anchor identity fingerprint
//   liveAnchor      null, or the anchor node's CURRENT {seq, head} as
//                   just reported by an anchor-status query (reachable)
// Rules (Addendum M.1):
//   - the local chain must verify end to end;
//   - the chain's last digest must bind the registry bytes on disk
//     (any edit to registry.json diverges here);
//   - an attestation must exist, verify, and its seq/head must equal
//     a PREFIX of the local chain (the attested head is the chain head
//     at that seq) — replaying an older attestation against a newer
//     chain is fine only in the direction of unanchored tail entries;
//   - unanchored tail entries (seq > attested seq) are permitted ONLY
//     when allowUnanchoredTail is set by the caller for the operation
//     that created them; a consumption decision facing a PRE-EXISTING
//     unanchored tail refuses (fail closed until it can anchor);
//   - when the anchor is reachable (liveAnchor given), its head must
//     equal the attested head — a local replay of chain+attestation
//     files is caught because the anchor's own sequence has moved on.
export function verifyAnchoredRegistry(dir, registryFile, anchorSignFp, { liveAnchor = null, allowUnanchoredTail = false } = {}) {
  const chain = verifyChain(registryChainFile(dir));
  if (!chain.ok) return { ok: false, error: `anchor-chain-broken: ${chain.error} at seq ${chain.at}` };
  if (!chain.entries.length) return { ok: false, error: 'anchor-chain-empty' };
  const regDigest = digestOfFileBytes(registryFile);
  const last = chain.entries[chain.entries.length - 1];
  if (last.digest !== regDigest) {
    return { ok: false, error: 'anchor-divergence: registry bytes do not match the chained digest (store edited outside the daemon)' };
  }
  const att = loadAttestation(dir);
  if (!att) return { ok: false, error: 'anchor-missing: no anchor attestation on file' };
  if (!verifyAttestation(att, anchorSignFp)) {
    return { ok: false, error: 'anchor-attestation-invalid' };
  }
  const attSeq = att.body.seq;
  const attEntry = chain.entries[attSeq - 1];
  if (!attEntry || attEntry.head !== att.body.head) {
    return { ok: false, error: 'anchor-divergence: attested head is not the chain head at the attested sequence (replayed or truncated chain)' };
  }
  const unanchored = chain.seq - attSeq;
  if (unanchored > 0 && !allowUnanchoredTail) {
    return { ok: false, error: `anchor-unanchored-state: ${unanchored} chain entr${unanchored === 1 ? 'y' : 'ies'} not yet countersigned — consumption refuses until the anchor can be reached` };
  }
  if (liveAnchor) {
    if (liveAnchor.seq !== attSeq || liveAnchor.head !== att.body.head) {
      return { ok: false, error: 'anchor-divergence: the anchor node reports a different head than the local attestation (replayed anchor files)' };
    }
  }
  return { ok: true, seq: chain.seq, anchored_seq: attSeq, head: chain.head };
}

// ---------------------------------------------------------------------------
// M.26 — sealed log segments.
//
// rotateAndSealLog(logFile, storeDir, logIdentityDir): if logFile has
// content, move it to segments/seg-<n>.jsonl, chain its digest into
// log-chain.jsonl, and seal the segment bytes as a package to the log
// identity (the store's own identity acts as sender; the log identity
// is a dedicated endpoint role holding the seal key). After sealing,
// the plaintext segment is destroyed — the at-rest store holds only
// the .scripture package + the chain.
// ---------------------------------------------------------------------------

export function sealLogSegment(storeDir, logFile, logIdentityDir) {
  if (!fs.existsSync(logFile)) return null;
  const bytes = fs.readFileSync(logFile);
  if (!bytes.length) return null;
  const me = loadIdentity(storeDir);
  const logId = loadIdentity(logIdentityDir);
  if (!me || !logId) throw new Error('seal-log: identity missing');
  const segDir = path.join(storeDir, 'log-segments');
  ensureDir(segDir);
  const chainFile = path.join(storeDir, 'log-chain.jsonl');
  const digest = sha256Hex(bytes);
  const entry = appendChain(chainFile, digest);
  const { frame, text } = sealPlaintext(bytes, me, { seal_pub: logId.seal_pub }, {});
  const segFile = path.join(segDir, `seg-${String(entry.seq).padStart(6, '0')}.scripture`);
  writeSecret(segFile, text);
  fs.writeFileSync(logFile, '', { mode: 0o600 });
  return { seq: entry.seq, digest, head: entry.head, segment: segFile, canary: frame.canary };
}

// Verify the whole sealed-log store: chain intact, every segment
// opens under the log identity, and every segment's plaintext digest
// equals its chained digest (tamper names the segment).
export function verifySealedLogs(storeDir, logIdentityDir) {
  const chainFile = path.join(storeDir, 'log-chain.jsonl');
  const chain = verifyChain(chainFile);
  if (!chain.ok) return { ok: false, error: `log-chain-broken: ${chain.error} at seq ${chain.at}` };
  const logId = loadIdentity(logIdentityDir);
  if (!logId) return { ok: false, error: 'log-identity-missing' };
  const segDir = path.join(storeDir, 'log-segments');
  for (const e of chain.entries) {
    const segFile = path.join(segDir, `seg-${String(e.seq).padStart(6, '0')}.scripture`);
    let parsed;
    try { parsed = parseScriptureFile(fs.readFileSync(segFile, 'utf8')); }
    catch (err) { return { ok: false, error: `segment ${e.seq} unreadable: ${err.message}`, at: e.seq }; }
    let plain;
    try { plain = openSealedSegment(logId, parsed); }
    catch (err) { return { ok: false, error: `segment ${e.seq} does not open: ${err.message}`, at: e.seq }; }
    if (sha256Hex(plain) !== e.digest) {
      return { ok: false, error: `segment ${e.seq} digest mismatch (tampered segment)`, at: e.seq };
    }
  }
  return { ok: true, segments: chain.entries.length };
}

function openSealedSegment(logId, parsed) {
  const payload = armorDecode(parsed.body, Buffer.from(parsed.frame.armor_seed, 'base64'));
  const fileKey = unsealFileKey(logId.sealPriv, parsed.frame);
  return openSealedFile(fileKey, parsed.frame, payload);
}

// ---------------------------------------------------------------------------
// M.19 — budgets. Counters live in a store file, keyed by origin, with
// epoch rollover. checkBudget() is called BEFORE any state changes;
// spend happens only for authenticated, admitted acts.
// ---------------------------------------------------------------------------

export function epochOf(nowMs, epochMs = 3600_000) { return Math.floor(nowMs / epochMs); }

export function loadBudgets(dir) {
  try {
    const b = JSON.parse(fs.readFileSync(path.join(dir, 'budgets.json'), 'utf8'));
    if (b && typeof b === 'object' && b.origins) return b;
  } catch {}
  return { v: 1, origins: {} };
}

export function saveBudgets(dir, b) {
  writeSecret(path.join(dir, 'budgets.json'), JSON.stringify(b, null, 2));
}

// Returns {ok:true, used} or {ok:false, error:'budget-exceeded', used, cap}.
export function spendBudget(dir, origin, kind, cap, nowMs = Date.now()) {
  const b = loadBudgets(dir);
  const ep = epochOf(nowMs);
  const key = `${kind}`;
  const rec = b.origins[origin] || {};
  if (rec.epoch !== ep) { rec.epoch = ep; rec.counts = {}; }
  const used = rec.counts[key] || 0;
  if (cap != null && used >= cap) {
    b.origins[origin] = rec; saveBudgets(dir, b);
    return { ok: false, error: 'budget-exceeded', used, cap };
  }
  rec.counts[key] = used + 1;
  b.origins[origin] = rec;
  saveBudgets(dir, b);
  return { ok: true, used: used + 1 };
}

export function budgetUsed(dir, origin, kind, nowMs = Date.now()) {
  const b = loadBudgets(dir);
  const rec = b.origins[origin];
  if (!rec || rec.epoch !== epochOf(nowMs)) return 0;
  return rec.counts[kind] || 0;
}
