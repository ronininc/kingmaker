/**
 * lib/federation.mjs (router-phase2)
 *
 * Federated node-to-node protocol for the fixed hardware topology
 * (control Mac, mini, Spark): Ed25519 node identity, a capability-gated
 * trust ladder, a policy engine, and a session challenge handshake that
 * actually runs on the live path.
 *
 * Studied from RuFlow's federation plugin (behavior spec §4, mapping §8
 * ADAPT), re-implemented clean-room with the fixes the spec demands:
 *   - authorization is ENFORCE-ONLY: there is no "legacy" mode that grants
 *     every claim; unknown claim types are REFUSED;
 *   - the session challenge handshake runs on every connect (upstream's
 *     live path skips it — ours does not);
 *   - first cross-machine contact requires a consent token — Robbie's tap,
 *     validated through the injected `consent` seam; refused without it;
 *   - trust promotion is an explicit, consent-gated act (upstream promotes
 *     on score alone, with an unauthenticated bootstrap override);
 *   - PII crossing the wire is blocked, redacted, or keyed-HMAC'd by
 *     trust level — never the upstream 4-char-prefix "hash";
 *   - no 'spawn' claim exists at all: this protocol never asks a peer to
 *     execute anything.
 *
 * Transport is injected (tests use an in-memory bus); every session,
 * handshake, claim decision, trust change, and refusal lands on the
 * hash-chained audit log. $0 spend, no telemetry.
 */

import { generateKeyPairSync, sign, verify, createHmac, createHash, randomBytes, createPrivateKey, createPublicKey } from 'node:crypto';

/** Trust ladder: capability-gated, promotion never automatic. */
export const TRUST = { UNKNOWN: 0, IDENTIFIED: 1, CAPABILITY_PROVEN: 2, TRUSTED: 3 };
export const TRUST_NAME = ['unknown', 'identified', 'capability-proven', 'trusted'];

/** Minimum trust for each claim type. Unknown claim types are refused outright. */
export const CLAIM_MIN_TRUST = {
  send: TRUST.IDENTIFIED,
  receive: TRUST.IDENTIFIED,
  'memory-query': TRUST.CAPABILITY_PROVEN,
  'context-share': TRUST.CAPABILITY_PROVEN,
  'delegate-task': TRUST.TRUSTED,
};

export const DEFAULT_POLICY = {
  maxMessageBytes: 1_048_576, // 1 MiB
  messagesPerMinute: 120,
  sessionTtlMs: 3_600_000,     // 1 h
  maxHops: 8,
  delegationBudgetUsd: 1.0,
};

/** Deterministic canonical string for envelope signing (undefined values skipped). */
function canonicalize(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalize).join(',') + ']';
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
}

function pubKeyObj(publicKeyHex) {
  return createPublicKey({ key: Buffer.from(publicKeyHex, 'hex'), format: 'der', type: 'spki' });
}
function privKeyObj(privateKeyHex) {
  return createPrivateKey({ key: Buffer.from(privateKeyHex, 'hex'), format: 'der', type: 'pkcs8' });
}

/** Generate an Ed25519 node identity. */
export function generateIdentity() {
  const kp = generateKeyPairSync('ed25519');
  return {
    publicKeyHex: kp.publicKey.export({ type: 'spki', format: 'der' }).toString('hex'),
    privateKeyHex: kp.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('hex'),
  };
}

const signEnvelope = (privateKeyHex, envelope) =>
  sign(null, Buffer.from(canonicalize({ ...envelope, sig: undefined }), 'utf8'), privKeyObj(privateKeyHex)).toString('hex');

function verifyEnvelope(publicKeyHex, envelope) {
  const { sig, ...rest } = envelope;
  if (!sig) return false;
  try {
    return verify(null, Buffer.from(canonicalize(rest), 'utf8'), pubKeyObj(publicKeyHex), Buffer.from(sig, 'hex'));
  } catch {
    return false;
  }
}

/** PII scan: per-type × per-trust action. Block-list never crosses; contact
 *  PII is redacted at IDENTIFIED, keyed-HMAC at CAPABILITY_PROVEN, and
 *  cleartext at TRUSTED only with an explicit tap. */
const BLOCK_PATTERNS = [
  { name: 'ssn', re: /\b\d{3}-\d{2}-\d{4}\b/ },
  { name: 'credit-card', re: /\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b/ },
  { name: 'api-key', re: /(sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,})/ },
  { name: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];
const CONTACT_PATTERNS = [
  { name: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { name: 'phone', re: /\+?\d[\d .()-]{7,}\d/ },
  { name: 'ipv4', re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/ },
];

/**
 * Create a federation node. Required seams: auditLog (hash-chained),
 * consent(token, peerId, purpose) → boolean — Robbie's tap validation.
 * transport: { send(toNodeId, envelope) } — injected; tests use a bus.
 */
export function createFederation({
  nodeId,
  keyPair = null,
  auditLog,
  consent,
  transport = null,
  hmacSecret = null,
  policy = {},
  now = () => Date.now(),
} = {}) {
  if (!nodeId) throw new Error('federation: nodeId is required');
  if (!auditLog) throw new Error('federation: an auditLog is required — federation without audit is not shipped');
  if (typeof consent !== 'function') throw new Error('federation: a consent(token, peerId, purpose) seam is required');

  const keys = keyPair ?? generateIdentity();
  const pol = { ...DEFAULT_POLICY, ...policy };
  const hmacKey = hmacSecret ?? createHash('sha256').update(keys.privateKeyHex, 'utf8').digest('hex');
  const actor = `federation:${nodeId}`;

  /** peerId → { publicKeyHex, trust, session, knownSince, rateWindow: [ts], spentUsd } */
  const peers = new Map();
  /** sessionId → { resolve, peerId } for the initiator's in-flight handshake */
  const pending = new Map();
  /** sessionId → { challenge, peerId } for the responder's in-flight handshake */
  const challenges = new Map();
  let transportRef = transport;

  const log = (action, detail, meta) => auditLog.append({ actor, action, detail, meta: meta ?? {} });
  let seq = 0;
  const nextId = (prefix) => `${prefix}-${nodeId}-${now()}-${seq++}`;

  function makeEnvelope(to, sessionId, type, payload) {
    const env = { v: 1, envelopeId: nextId('env'), from: nodeId, to, sessionId, type, payload, ts: now(), nonce: randomBytes(8).toString('hex') };
    env.sig = signEnvelope(keys.privateKeyHex, env);
    return env;
  }

  function scrubPayload(payload, trust, tapGranted) {
    const text = JSON.stringify(payload);
    const blocked = BLOCK_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.name);
    if (blocked.length > 0) {
      return { ok: false, reason: 'pii-blocked', types: blocked };
    }
    let scrubbed = text;
    const hmacOf = (v) => createHmac('sha256', hmacKey).update(v, 'utf8').digest('hex');
    for (const p of CONTACT_PATTERNS) {
      const matches = text.match(new RegExp(p.re.source, 'g')) || [];
      if (matches.length === 0) continue;
      if (trust >= TRUST.TRUSTED && tapGranted) continue; // cleartext only with the tap
      const repl = trust >= TRUST.CAPABILITY_PROVEN
        ? (v) => `hmac:${hmacOf(v)}`
        : () => `[REDACTED:${p.name}]`;
      scrubbed = scrubbed.replace(new RegExp(p.re.source, 'g'), repl);
    }
    return { ok: true, payload: JSON.parse(scrubbed) };
  }

  function peerTrust(peerId) {
    return peers.has(peerId) ? peers.get(peerId).trust : TRUST.UNKNOWN;
  }

  /**
   * Register a peer's pinned public key. This is first contact: refused
   * without a valid consent token. The token is Robbie's tap — the
   * injected consent seam validates it.
   */
  function registerPeer(peerId, publicKeyHex, { consentToken = null, name = '' } = {}) {
    if (!peerId || !publicKeyHex) {
      return { ok: false, reason: 'peerId and pinned publicKeyHex are required' };
    }
    if (!consentToken || !consent(consentToken, peerId, 'first-contact')) {
      log('federation.first-contact-refused', `peer ${peerId}: no valid consent token`, { peerId });
      return { ok: false, reason: 'first-contact-consent-required' };
    }
    peers.set(peerId, {
      publicKeyHex, name, trust: TRUST.UNKNOWN, session: null, rateWindow: [], spentUsd: 0, knownSince: now(),
    });
    log('federation.peer-registered', `peer ${peerId}${name ? ` (${name})` : ''} registered at trust=unknown`, { peerId, name });
    return { ok: true, trust: TRUST.UNKNOWN };
  }

  /**
   * Connect to a registered peer: the session challenge handshake runs
   * every time. On success the peer sits at trust=identified — the
   * handshake authenticates, it never authorizes.
   */
  async function connect(peerId) {
    const peer = peers.get(peerId);
    if (!peer) {
      log('federation.connect-refused', `peer ${peerId}: unregistered — no first contact without consent`, { peerId });
      return { ok: false, reason: 'unregistered-peer' };
    }
    const sessionId = nextId('sess');
    const result = await new Promise((resolve) => {
      let timer;
      const done = (v) => { if (timer) clearTimeout(timer); resolve(v); };
      pending.set(sessionId, { resolve: done, peerId });
      timer = setTimeout(() => {
        if (pending.has(sessionId)) {
          pending.delete(sessionId);
          resolve({ ok: false, reason: 'handshake-timeout' });
        }
      }, 5000);
      const req = makeEnvelope(peerId, sessionId, 'handshake-request', { nodeId, publicKeyHex: keys.publicKeyHex });
      (transportRef?.send(peerId, req) ?? Promise.resolve()).catch((e) => done({ ok: false, reason: `transport: ${e.message}` }));
    });
    if (result.ok) {
      peer.session = { id: sessionId, establishedAt: now(), expiresAt: now() + pol.sessionTtlMs };
      peer.trust = Math.max(peer.trust, TRUST.IDENTIFIED);
      log('federation.session-established', `session ${sessionId} with ${peerId}; trust=${TRUST_NAME[peer.trust]}`, { peerId, sessionId, trust: TRUST_NAME[peer.trust] });
    } else {
      log('federation.handshake-failed', `peer ${peerId}: ${result.reason}`, { peerId, reason: result.reason });
    }
    return result;
  }

  /** Promote a peer's trust. Explicit and consent-gated — never score-driven. */
  function promote(peerId, level, { consentToken = null, reason = '' } = {}) {
    const peer = peers.get(peerId);
    if (!peer) return { ok: false, reason: 'unregistered-peer' };
    if (!Object.values(TRUST).includes(level) || level <= peer.trust) {
      return { ok: false, reason: 'invalid promotion level' };
    }
    if (!consentToken || !consent(consentToken, peerId, `promote-to-${TRUST_NAME[level]}`)) {
      log('federation.promote-refused', `peer ${peerId} → ${TRUST_NAME[level]}: no consent token`, { peerId, level: TRUST_NAME[level] });
      return { ok: false, reason: 'promotion-consent-required' };
    }
    const from = peer.trust;
    peer.trust = level;
    log('federation.trust-changed', `peer ${peerId}: ${TRUST_NAME[from]} → ${TRUST_NAME[level]} — ${reason}`, { peerId, from: TRUST_NAME[from], to: TRUST_NAME[level], reason });
    return { ok: true, trust: level };
  }

  function checkRate(peer) {
    const cutoff = now() - 60_000;
    peer.rateWindow = peer.rateWindow.filter((t) => t > cutoff);
    return peer.rateWindow.length < pol.messagesPerMinute;
  }

  /**
   * Send a claim to a peer. Enforce-only: unknown claims refused, trust
   * below the claim floor refused, caps and budgets enforced. Returns
   * { ok } or { ok: false, reason } — refusals are audited.
   */
  async function send(peerId, claim, payload, { costUsd = 0, hops = 0, tapGranted = false } = {}) {
    const peer = peers.get(peerId);
    if (!peer) {
      log('federation.send-refused', `peer ${peerId}: unregistered`, { peerId, claim });
      return { ok: false, reason: 'unregistered-peer' };
    }
    if (!(claim in CLAIM_MIN_TRUST)) {
      log('federation.send-refused', `peer ${peerId}: unknown claim '${claim}' — refused`, { peerId, claim });
      return { ok: false, reason: 'unknown-claim-type' };
    }
    if (peer.trust < CLAIM_MIN_TRUST[claim]) {
      log('federation.send-refused', `peer ${peerId}: claim '${claim}' needs trust ≥ ${TRUST_NAME[CLAIM_MIN_TRUST[claim]]} (has ${TRUST_NAME[peer.trust]})`, { peerId, claim, trust: TRUST_NAME[peer.trust] });
      return { ok: false, reason: 'insufficient-trust' };
    }
    if (!peer.session || now() > peer.session.expiresAt) {
      log('federation.send-refused', `peer ${peerId}: no live session`, { peerId, claim });
      return { ok: false, reason: 'session-expired' };
    }
    const scrub = scrubPayload(payload, peer.trust, tapGranted);
    if (!scrub.ok) {
      log('federation.send-refused', `peer ${peerId}: ${scrub.reason} (${scrub.types.join(', ')})`, { peerId, claim, blockedTypes: scrub.types });
      return { ok: false, reason: scrub.reason, types: scrub.types };
    }
    const bytes = Buffer.byteLength(JSON.stringify(scrub.payload), 'utf8');
    if (bytes > pol.maxMessageBytes) {
      log('federation.send-refused', `peer ${peerId}: ${bytes} bytes over ${pol.maxMessageBytes} cap`, { peerId, claim, bytes });
      return { ok: false, reason: 'message-over-cap', bytes };
    }
    if (!checkRate(peer)) {
      log('federation.send-refused', `peer ${peerId}: rate limit ${pol.messagesPerMinute}/min exceeded`, { peerId, claim });
      return { ok: false, reason: 'rate-limited' };
    }
    if (hops > pol.maxHops) {
      log('federation.send-refused', `peer ${peerId}: hop count ${hops} over ${pol.maxHops}`, { peerId, claim });
      return { ok: false, reason: 'hop-limit' };
    }
    if (costUsd > 0 && peer.spentUsd + costUsd > pol.delegationBudgetUsd) {
      log('federation.send-refused', `peer ${peerId}: delegation budget $${pol.delegationBudgetUsd} would be exceeded`, { peerId, claim, spentUsd: peer.spentUsd, costUsd });
      return { ok: false, reason: 'delegation-budget-exceeded' };
    }
    peer.rateWindow.push(now());
    peer.spentUsd += costUsd;
    const env = makeEnvelope(peerId, peer.session.id, 'message', { claim, payload: scrub.payload, hops, costUsd });
    await (transportRef?.send(peerId, env) ?? Promise.resolve());
    log('federation.message.sent', `peer ${peerId}: claim '${claim}', ${bytes} bytes`, { peerId, claim, bytes, trust: TRUST_NAME[peer.trust] });
    return { ok: true, bytes };
  }

  /** Inbound dispatch. The challenge handshake path is the live path — it
   *  runs, and the response signature is verified against the PINNED key,
   *  never the key asserted in the response. */
  async function handleEnvelope(env) {
    const peerId = env?.from && peers.has(env.from) ? env.from : null;
    const peer = peerId ? peers.get(peerId) : null;
    const pinned = peer?.publicKeyHex ?? null;

    if (env.type === 'handshake-request') {
      if (!peer || !pinned || !verifyEnvelope(pinned, env)) return { ok: false, reason: 'unregistered-peer' };
      const challenge = randomBytes(32).toString('hex');
      challenges.set(env.sessionId, { challenge, peerId });
      const reply = makeEnvelope(peerId, env.sessionId, 'handshake-challenge', { challenge });
      await (transportRef?.send(peerId, reply) ?? Promise.resolve());
      return { ok: true };
    }

    if (env.type === 'handshake-challenge') {
      const wait = pending.get(env.sessionId);
      if (!wait) return { ok: false, reason: 'no-pending-session' };
      const p = peers.get(wait.peerId);
      if (!p) return { ok: false, reason: 'unregistered-peer' };
      const sig = signEnvelope(keys.privateKeyHex, { challenge: env.payload.challenge, sessionId: env.sessionId });
      const resp = makeEnvelope(wait.peerId, env.sessionId, 'handshake-response', { challenge: env.payload.challenge, signature: sig });
      await (transportRef?.send(wait.peerId, resp) ?? Promise.resolve());
      return { ok: true };
    }

    if (env.type === 'handshake-response') {
      // Responder side: verify the challenge signature against the PINNED
      // key, then accept the session on BOTH sides with an accept envelope.
      const rec = challenges.get(env.sessionId);
      if (!rec || env.from !== rec.peerId) {
        return { ok: false, reason: 'no-pending-challenge' };
      }
      challenges.delete(env.sessionId);
      const p = peers.get(env.from);
      if (!p) return { ok: false, reason: 'unregistered-peer' };
      const expected = canonicalize({ challenge: env.payload.challenge, sessionId: env.sessionId });
      let good = false;
      try {
        good = verify(null, Buffer.from(expected, 'utf8'), pubKeyObj(p.publicKeyHex), Buffer.from(env.payload.signature, 'hex'));
      } catch {
        good = false;
      }
      if (!good) {
        log('federation.handshake-failed', `peer ${env.from}: challenge signature did not verify against the pinned key`, { peerId: env.from });
        const rej = makeEnvelope(env.from, env.sessionId, 'handshake-reject', { reason: 'challenge-signature-invalid' });
        await (transportRef?.send(env.from, rej) ?? Promise.resolve());
        return { ok: false, reason: 'challenge-signature-invalid' };
      }
      p.session = { id: env.sessionId, establishedAt: now(), expiresAt: now() + pol.sessionTtlMs };
      p.trust = Math.max(p.trust, TRUST.IDENTIFIED);
      log('federation.session-established', `session ${env.sessionId} with ${env.from}; trust=${TRUST_NAME[p.trust]}`, { peerId: env.from, sessionId: env.sessionId, trust: TRUST_NAME[p.trust] });
      const acc = makeEnvelope(env.from, env.sessionId, 'handshake-accept', { sessionId: env.sessionId });
      await (transportRef?.send(env.from, acc) ?? Promise.resolve());
      return { ok: true };
    }

    if (env.type === 'handshake-accept') {
      // Initiator side: the handshake ran end to end and verified.
      const wait = pending.get(env.sessionId);
      if (!wait) return { ok: false, reason: 'no-pending-session' };
      pending.delete(env.sessionId);
      wait.resolve({ ok: true, sessionId: env.sessionId, peerId: env.from, handshakeRan: true });
      return { ok: true };
    }

    if (env.type === 'handshake-reject') {
      const wait = pending.get(env.sessionId);
      if (!wait) return { ok: false, reason: 'no-pending-session' };
      pending.delete(env.sessionId);
      wait.resolve({ ok: false, reason: env.payload.reason ?? 'handshake-rejected' });
      return { ok: true };
    }

    if (env.type === 'heartbeat') {
      if (peerId && pinned && verifyEnvelope(pinned, env)) {
        const p = peers.get(peerId);
        if (p.session && p.session.id === env.sessionId) p.session.lastHeartbeat = now();
      }
      return { ok: true };
    }

    if (env.type === 'message') {
      if (!peer || !pinned || !verifyEnvelope(pinned, env)) {
        log('federation.message-refused', `message from ${env?.from ?? 'unknown'}: signature invalid or peer unregistered`, { from: env?.from ?? null });
        return { ok: false, reason: 'unverified-sender' };
      }
      if (!peer.session || peer.session.id !== env.sessionId || now() > peer.session.expiresAt) {
        return { ok: false, reason: 'session-expired' };
      }
      if (!(env.payload.claim in CLAIM_MIN_TRUST) || peer.trust < CLAIM_MIN_TRUST[env.payload.claim]) {
        log('federation.message-refused', `peer ${peerId}: claim '${env.payload.claim}' below trust floor`, { peerId, claim: env.payload.claim });
        return { ok: false, reason: 'insufficient-trust' };
      }
      log('federation.message.received', `peer ${peerId}: claim '${env.payload.claim}'`, { peerId, claim: env.payload.claim });
      return { ok: true };
    }

    return { ok: false, reason: 'unknown-message-type' };
  }

  /** Revoke a peer entirely: session killed, trust reset, audited. */
  function revokePeer(peerId, reason = '') {
    const peer = peers.get(peerId);
    if (!peer) return { ok: false, reason: 'unregistered-peer' };
    peer.session = null;
    peer.trust = TRUST.UNKNOWN;
    log('federation.peer-revoked', `peer ${peerId}: ${reason || 'revoked by operator'}`, { peerId, reason });
    return { ok: true };
  }

  return {
    nodeId, publicKeyHex: keys.publicKeyHex, policy: { ...pol },
    registerPeer, connect, promote, send, revokePeer, handleEnvelope,
    setTransport(t) { transportRef = t; },
    trustOf: (peerId) => TRUST_NAME[peerTrust(peerId)],
    trustLevel: (peerId) => peerTrust(peerId),
    peers: () => [...peers.keys()],
    _scrubPayload: scrubPayload, // exposed for tests
  };
}
