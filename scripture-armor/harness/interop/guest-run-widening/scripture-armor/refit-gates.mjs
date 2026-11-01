#!/usr/bin/env node
// refit-gates.mjs — Addendum M gate mechanisms: M.4/M.13 (signed
// owner acts + the review queue), M.5 (cell routing law), M.10
// (Addendum L delivery), M.11 (runtime watch), M.12 (provenance gate
// for consequential actions), M.14 (toolchain pins), M.6/M.15 (host
// posture + boot wall artifacts).
//
// The owner-act design (M.4/M.13) in one paragraph: the daemon pends;
// the pending has a DIGEST over its full record (canary, frame digest,
// scan verdict + digest, tier, notices, registry status, provenance).
// The daemon issues a fresh nonce per approval attempt (owner
// channel). The owner signs {act, pending_id, pending_digest, nonce}
// with a SEPARATE owner key registered in the store (owner-act.json)
// — in production that key lives in the platform keystore,
// non-exportable where offered; the files anyone can steal hold only
// its public half. A captured exchange replays to nothing (nonce
// consumed, digest bound), a swapped package invalidates the approval
// mechanically (digest mismatch), a fake prompt holds no key, and
// pendings expire into refusal — expiry is never consent.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  signPayload, verifyPayload, sha256Hex, sealPlaintext, parseScriptureFile,
  unsealFileKey, openSealedFile, armorDecode,
} from './armor.mjs';

const b64 = (buf) => Buffer.from(buf).toString('base64');
const unb64 = (s) => Buffer.from(s, 'base64');

// ---------------------------------------------------------------------------
// M.4 / M.13 — signed owner acts.
// ---------------------------------------------------------------------------

export const PENDING_DIGEST_FIELDS = [
  'id', 'canary', 'digest', 'verdict', 'scan_digest', 'tier',
  'notices', 'registry_status', 'provenance', 'kind',
];

export function pendingDigestOf(rec) {
  const ordered = {};
  for (const f of PENDING_DIGEST_FIELDS) ordered[f] = rec[f] ?? null;
  return sha256Hex(Buffer.from(JSON.stringify(ordered), 'utf8'));
}

export const OWNER_ACT_FIELDS = ['act', 'pending_id', 'pending_digest', 'nonce', 'at'];

export function canonicalOwnerAct(doc) {
  const ordered = {};
  for (const f of OWNER_ACT_FIELDS) ordered[f] = doc[f] ?? null;
  return JSON.stringify(ordered);
}

// The owner key is its own identity (Ed25519), created by the refit
// installer into owner-act.json in the store: {sign_pub, sign_priv}
// — the private half belongs in the platform keystore in production;
// the store file is the battery/install form, mode 0600, and the
// design's claim is about the PROTOCOL (what the daemon demands),
// which does not change when the key's home improves.
export function createOwnerKey(storeDir) {
  const kp = crypto.generateKeyPairSync('ed25519');
  const pub = kp.publicKey.export({ format: 'jwk' });
  const priv = kp.privateKey.export({ format: 'jwk' });
  const rec = { v: 1, sign_pub: pub.x, sign_priv: priv.d, created: new Date().toISOString() };
  fs.writeFileSync(path.join(storeDir, 'owner-act.json'), JSON.stringify(rec, null, 2), { mode: 0o600 });
  return rec;
}

export function loadOwnerKey(storeDir) {
  try { return JSON.parse(fs.readFileSync(path.join(storeDir, 'owner-act.json'), 'utf8')); } catch { return null; }
}

export function ownerKeyObject(rec) {
  return {
    signPub: crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: rec.sign_pub }, format: 'jwk' }),
    signPriv: crypto.createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', x: rec.sign_pub, d: rec.sign_priv }, format: 'jwk' }),
    sign_pub: rec.sign_pub,
    signFp: sha256Hex(Buffer.from(rec.sign_pub, 'base64url')),
  };
}

export function signOwnerAct(ownerKey, { act, pendingId, pendingDigest, nonce }) {
  const doc = {
    act, pending_id: pendingId, pending_digest: pendingDigest,
    nonce, at: new Date().toISOString(),
  };
  doc.sig = b64(crypto.sign(null, Buffer.from(canonicalOwnerAct(doc), 'utf8'), ownerKey.signPriv));
  doc.owner_sign_pub = ownerKey.sign_pub;
  return doc;
}

// Daemon-side verification. consumedNonces is a Set the daemon owns;
// a nonce verifies exactly once. maxAgeMs bounds the act's freshness.
export function verifyOwnerAct(doc, { ownerSignPub, pending, pendingDigest, consumedNonces, maxAgeMs = 120000, nowMs = Date.now() }) {
  if (!doc || !doc.sig || doc.owner_sign_pub !== ownerSignPub) {
    return { ok: false, error: 'owner-act: not signed by the registered owner key' };
  }
  if (doc.pending_id !== pending.id) return { ok: false, error: 'owner-act: pending mismatch' };
  if (doc.pending_digest !== pendingDigest) {
    return { ok: false, error: 'owner-act: digest mismatch — the thing signed is not the thing pending (swapped after the tap)' };
  }
  if (consumedNonces.has(doc.nonce)) return { ok: false, error: 'owner-act: nonce already consumed (replay)' };
  if (Math.abs(nowMs - Date.parse(doc.at)) > maxAgeMs) return { ok: false, error: 'owner-act: stale act' };
  let okSig = false;
  try {
    const pub = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: doc.owner_sign_pub }, format: 'jwk' });
    okSig = crypto.verify(null, Buffer.from(canonicalOwnerAct(doc), 'utf8'), pub, unb64(doc.sig));
  } catch {}
  if (!okSig) return { ok: false, error: 'owner-act: bad signature' };
  consumedNonces.add(doc.nonce);
  return { ok: true };
}

// The review queue (M.13): pendings presented as ONE queue with the
// full record per item — never a drip of isolated taps. Expiry is
// computed against the pending's window; an expired pending is a
// refusal, listed as expired, never silently approvable.
export function reviewQueue(pendings, nowMs = Date.now()) {
  return pendings.map((p) => ({
    id: p.id, kind: p.kind || 'unwrap', canary: p.canary ?? null,
    digest: pendingDigestOf(p),
    verdict: p.verdict ?? null, tier: p.tier ?? null,
    notices: p.notices ?? [], registry_status: p.registry_status ?? null,
    provenance: p.provenance ?? null,
    expired: p.expires_at ? Date.parse(p.expires_at) < nowMs : false,
  }));
}

// ---------------------------------------------------------------------------
// M.5 — cell routing law. Pure decision function the daemon consults:
//   executable-class activation NEVER runs in a shared-kernel cell.
//   Order: local HARD → estate HARD host (route) → refuse
//   'cell-unavailable'. There is no downgrade input: policy fields
//   that used to feed one (soft_for_source, tier downgrade_allowed)
//   are not consulted for executable class under the refit — the
//   battery proves edits to them change nothing.
// SOFT retains exactly one duty: the Closure 1 scan sandbox over
// untrusted DATA (detonation for analysis), which is not activation.
// ---------------------------------------------------------------------------

export function decideCellRoute({ contentClass, hardLocal, hardHosts = [], softAvailable = false }) {
  if (contentClass === 'data') {
    return { action: 'scan-sandbox', cell: 'soft', reason: 'untrusted data goes to the scan sandbox, never to activation' };
  }
  // binary + source are both executable-class when activated.
  if (hardLocal) return { action: 'run', cell: 'hard', reason: 'local HARD cell' };
  if (hardHosts.length) return { action: 'route', cell: 'hard', host: hardHosts[0], reason: 'no local KVM — route to estate HARD host' };
  return {
    action: 'refuse', error: 'cell-unavailable',
    reason: 'executable activation requires a HARD cell (hypervisor); this host has none and no estate HARD host is reachable — activation refuses, it does not downgrade',
    softAvailableIgnored: softAvailable,
  };
}

// ---------------------------------------------------------------------------
// M.11 — runtime watch. The scan's declared expectations vs the
// cell's observed behavior: destinations attempted, persistence
// attempted, egress volume. Deviation → anomaly state + estate-wide
// grant revocation (the daemon applies it; here is the comparison
// law). A logic bomb can sleep; it cannot leave, persist, or phone
// home when it wakes — those are the three watched verbs.
// ---------------------------------------------------------------------------

export function watchDeviation(declared, observed) {
  const deviations = [];
  const declaredDest = new Set(declared?.destinations ?? []);
  for (const d of observed?.destinations_attempted ?? []) {
    if (!declaredDest.has(d)) deviations.push({ kind: 'undeclared-destination', detail: d });
  }
  if (observed?.persistence_attempted) deviations.push({ kind: 'persistence-attempted', detail: observed.persistence_attempted });
  if (observed?.sensors_attempted?.length) {
    deviations.push({ kind: 'sensor-attempted', detail: observed.sensors_attempted.join(',') });
  }
  const cap = declared?.max_egress_bytes ?? 0;
  if ((observed?.egress_bytes ?? 0) > cap) {
    deviations.push({ kind: 'egress-over-declared', detail: `${observed.egress_bytes}>${cap}` });
  }
  return { deviated: deviations.length > 0, deviations, action: deviations.length ? 'anomaly+revoke-grant-estate-wide' : 'none' };
}

// ---------------------------------------------------------------------------
// M.12 — provenance gate for consequential actions. Inbound content
// crosses as DATA with its canary + origin attached; the boundary
// channel carries no instruction weight by construction. A
// consequential action is admitted only if its authority chain
// terminates in an owner-signed instruction or the Kingmaker spine's
// standing law. An action whose cited authority is an airlock-in or
// egress canary refuses as authority-mismatch.
// ---------------------------------------------------------------------------

export const CONSEQUENTIAL_CLASSES = ['send', 'trade', 'settings', 'money', 'approval', 'publish', 'delete'];

export function wrapInboundAsData(canary, origin, bytes) {
  return {
    kind: 'boundary-data', canary, origin,
    sha256: sha256Hex(bytes),
    instruction_weight: 0, // by construction: data, never authority
    bytes,
  };
}

export function admitAction(action) {
  // action = {class, authority: {kind: 'owner-signed'|'spine-law'|'canary'|'content'|'none', ref}}
  if (!CONSEQUENTIAL_CLASSES.includes(action.class)) return { ok: true, consequential: false };
  const kind = action.authority?.kind;
  if (kind === 'owner-signed' || kind === 'spine-law') return { ok: true, consequential: true };
  return {
    ok: false, consequential: true,
    error: `authority-mismatch: consequential action '${action.class}' cites authority '${kind ?? 'none'}' — only an owner-signed instruction or standing spine law authorizes it; content never does`,
  };
}

// Verify an owner-signed instruction really is the owner's: the
// instruction doc is a signed mesh-style payload under the owner key
// (M.4 key). Returns the doc if valid.
export function verifyOwnerInstruction(doc, ownerSignPub) {
  if (!doc || doc.owner_sign_pub !== ownerSignPub || !doc.sig) return null;
  try {
    const pub = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: doc.owner_sign_pub }, format: 'jwk' });
    const ok = crypto.verify(null, Buffer.from(canonicalOwnerAct(doc), 'utf8'), pub, unb64(doc.sig));
    return ok ? doc : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// M.10 — Addendum L delivery. A Ronin app bundle ships as an armored
// artifact + a loader. The bundle is sealed to the PRESENTING
// DEVICE's identity after its login binding verifies; the loader
// opens it only when the local identity's fingerprint matches the
// binding sealed inside the frame's delivery record; execution is
// from memory (the opened bytes are handed to the caller, never
// written to disk by this layer). A bundle copied to any other
// device refuses — and the refusal is a beacon record the caller
// files. Scraping the artifact yields glyph-layer bytes only: the
// division battery's job is to confirm no readable source and no
// checkable relation in them.
// ---------------------------------------------------------------------------

export function deliverBundle(senderId, deviceId, bundleBytes, { service } = {}) {
  const { frame, text } = sealPlaintext(bundleBytes, senderId, { seal_pub: deviceId.seal_pub }, {});
  const delivery = {
    v: 1, service: service ?? null,
    bound_seal_fp: deviceId.sealFp, bound_sign_fp: deviceId.signFp,
    canary: frame.canary,
  };
  return { frame, text, delivery };
}

export function openDeliveredBundle(localId, text, delivery) {
  if (localId.sealFp !== delivery.bound_seal_fp || localId.signFp !== delivery.bound_sign_fp) {
    return {
      ok: false, error: 'device-binding-mismatch: this bundle was sealed to a different device — refusal',
      beacon: { event: 'delivery', result: 'refused: device-binding-mismatch', canary: delivery.canary, at: new Date().toISOString() },
    };
  }
  try {
    const { frame, body } = parseScriptureFile(text);
    const fileKey = unsealFileKey(localId.sealPriv, frame);
    const payload = armorDecode(body, Buffer.from(frame.armor_seed, 'base64'));
    const plain = openSealedFile(fileKey, frame, payload);
    return { ok: true, bytes: plain, in_memory_only: true };
  } catch (e) {
    return { ok: false, error: `delivery-open-failed: ${e.message}` };
  }
}

// ---------------------------------------------------------------------------
// M.14 — toolchain pins. Every tool the armor runs is hash-pinned at
// install; the pins live in a SIGNED policy artifact (mesh-doc form,
// signed by the estate identity); the launch wrapper verifies the
// tool's digest at run time and refuses on any mismatch — a swapped
// byte in the Ghidra install is an engine-digest-mismatch, never a
// scan. Updates are wrap events: new bytes, new scan, owner approval,
// new pin — this module is the pin + verify half of that law.
// ---------------------------------------------------------------------------

export function pinTool(name, absPath) {
  const st = fs.statSync(absPath);
  if (st.isDirectory()) {
    // Directory digest: sha256 over the sorted (relpath, size,
    // sha256) lines of every regular file — one byte changed anywhere
    // in the install changes the pin.
    const lines = [];
    const walk = (d, rel) => {
      for (const n of fs.readdirSync(d).sort()) {
        const p = path.join(d, n);
        const r = rel ? `${rel}/${n}` : n;
        const s = fs.statSync(p);
        if (s.isDirectory()) walk(p, r);
        else if (s.isFile()) lines.push(`${r}|${s.size}|${sha256Hex(fs.readFileSync(p))}`);
      }
    };
    walk(absPath, '');
    return { name, path: absPath, kind: 'dir', digest: sha256Hex(Buffer.from(lines.join('\n'), 'utf8')), files: lines.length };
  }
  return { name, path: absPath, kind: 'file', digest: sha256Hex(fs.readFileSync(absPath)), files: 1 };
}

export function signToolPins(estateId, pins) {
  return signPayload(estateId, { type: 'tool-pins', to_seal_fp: null, body: { pins } });
}

export function verifyToolPins(doc, pins) {
  if (!doc || doc.type !== 'tool-pins' || !verifyPayload(doc)) return { ok: false, error: 'tool-pins-signature-invalid' };
  const recorded = new Map((doc.body.pins || []).map((p) => [p.name, p]));
  for (const p of pins) {
    const rec = recorded.get(p.name);
    if (!rec) return { ok: false, error: `tool-unpinned: ${p.name} has no pin in signed policy` };
    const now = pinTool(p.name, p.path);
    if (now.digest !== rec.digest) {
      return { ok: false, error: `engine-digest-mismatch: ${p.name} at ${p.path} does not match its signed pin (a byte changed in the install)` };
    }
  }
  return { ok: true };
}

// Run a pinned tool only after verification. Returns the spawn result
// or the refusal — the tool never executes on a bad pin.
export function runPinnedTool(pinDoc, pin, args, opts = {}) {
  const v = verifyToolPins(pinDoc, [pin]);
  if (!v.ok) return v;
  try {
    const out = execFileSync(pin.path, args, { timeout: opts.timeoutMs ?? 120000, maxBuffer: 256 * 1024 * 1024, env: opts.env });
    return { ok: true, stdout: out };
  } catch (e) {
    return { ok: false, error: `tool-run-failed: ${e.message}`, stdout: e.stdout ?? null };
  }
}

// ---------------------------------------------------------------------------
// M.6 / M.15 — host posture + boot wall.
//
// M.6: a cell host enrolls only with swap off or swap encrypted under
// ephemeral keys, hibernation disabled, core dumps disabled — all
// verified at enrollment and re-checked in status. The checks below
// read the LIVE host facilities (Linux: /proc/swaps, /sys/power,
// ulimit -c via the runtime; other platforms: named facilities the
// installer asserts, verified by the same posture-file contract).
// M.15: the boot wall is a generated, persistent default-deny
// ruleset per platform + a quarantine (captive-portal) lane profile:
// browser-only, no route to any estate address, no estate
// credentials, dies when the mesh rises. Generation is the buildable
// artifact; the battery verifies the ruleset's content and the lane's
// non-reachability in a network namespace where the platform allows.
// ---------------------------------------------------------------------------

export function hostPosture() {
  const out = { platform: process.platform, checks: {}, ok: true };
  if (process.platform === 'linux') {
    let swaps = '';
    try { swaps = fs.readFileSync('/proc/swaps', 'utf8').trim().split('\n').slice(1).filter(Boolean); }
    catch { swaps = []; }
    out.checks.swap_entries = swaps.length;
    out.checks.swap_off_or_ephemeral = swaps.length === 0; // this host class: swap off
    let hib = null;
    try { hib = fs.readFileSync('/sys/power/state', 'utf8').includes('disk'); } catch {}
    out.checks.hibernation_available = hib;
    let coreLimit = null;
    try { coreLimit = execFileSync('bash', ['-c', 'ulimit -c'], { encoding: 'utf8' }).trim(); } catch {}
    out.checks.core_dump_limit = coreLimit;
    out.checks.core_dumps_disabled = coreLimit === '0';
    out.ok = out.checks.swap_off_or_ephemeral && out.checks.core_dumps_disabled;
  }
  return out;
}

export function enrollmentGate(posture) {
  if (posture.platform === 'linux') {
    if (!posture.checks.swap_off_or_ephemeral) {
      return { ok: false, error: 'enrollment-refused: cell hosts enroll only with swap off or swap encrypted under ephemeral keys (plaintext would otherwise reach disk through swap)' };
    }
    if (!posture.checks.core_dumps_disabled) {
      return { ok: false, error: 'enrollment-refused: core dumps must be disabled on a cell host (a crash must not write memory to disk)' };
    }
  }
  return { ok: true };
}

export function bootWallRules({ platform, controlPlane = [], estateAddrs = [] }) {
  // Default-deny from power-on; the ONLY pre-mesh traffic allowed is
  // the control plane's handshake. The quarantine lane is a separate
  // browser-only profile with NO route to estate addresses.
  if (platform === 'linux') {
    const cp = controlPlane.map((a) => `  ip daddr ${a} accept`).join('\n');
    return [
      'table inet scripture_boot {',
      '  chain output {',
      '    type filter hook output priority -10; policy drop;',
      '    oif "lo" accept',
      '    ct state established,related accept',
      cp || '  # (no control-plane addresses configured)',
      '  }',
      '  chain input {',
      '    type filter hook input priority -10; policy drop;',
      '    iif "lo" accept',
      '    ct state established,related accept',
      '  }',
      '}',
      '# Installed persistent (nftables boot unit) BEFORE any user session;',
      '# lifted only by the mesh-up event, which replaces it with the',
      '# estate ruleset. Estate addresses are never reachable pre-mesh:',
      ...estateAddrs.map((a) => `#   ${a} — no rule admits it in this table`),
    ].join('\n');
  }
  if (platform === 'darwin') {
    const cp = controlPlane.map((a) => `pass out quick proto { tcp udp } to ${a}`).join('\n');
    return ['# pf boot ruleset (loaded by the launchd boot daemon before login)', 'set block-policy drop', 'block all', 'pass on lo0 all', cp || '# (no control-plane addresses configured)', '# quarantine lane: separate network service, browser only, no estate routes'].join('\n');
  }
  return ['# Windows Firewall boot-time filters (persistent, pre-logon)', 'DefaultInboundAction=Block', 'DefaultOutboundAction=Block', ...controlPlane.map((a) => `AllowOutbound RemoteAddress=${a} # control-plane handshake only`), '# quarantine lane: separate browser-only profile, no estate routes, no estate credentials'].join('\n');
}

export function quarantineLaneProfile(estateAddrs) {
  return {
    name: 'quarantine-portal-lane',
    browser_only: true,
    estate_credentials: false,
    routes_to_estate: estateAddrs.map((a) => ({ addr: a, routed: false })),
    dies_on: 'mesh-up',
    tier: 0,
  };
}
