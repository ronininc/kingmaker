#!/usr/bin/env node
// refit-net.mjs — Addendum M network mechanisms: M.8 (the packet
// layer, Addendum K built), M.18 (traffic shaping), M.9 (hash-matched
// login binding + brokered credentials).
//
// M.8 — flows, not packets-from-scratch. A flow opens with a signed
// hello naming both endpoints' estate identities, then an X25519
// exchange seals the flow; every packet carries a counter and an
// AEAD tag (ChaCha20-Poly1305, counter nonce — the WireGuard
// pattern). Each side keeps a rolling hash chain over the digests of
// packets it RECEIVED, in order; receipts are signed chain heads the
// sender compares against its own sent-chain. One flipped, injected,
// reordered, or replayed packet breaks the counters or the chain:
// the flow dies and the mismatch is a beacon event. The visible
// stream is ciphertext only, rekeyed per flow (K.2 in the medium
// where bulk capture is cheapest). Enrollment is the gate: a flow to
// an endpoint with no verified descriptor chain (M.17) cannot form.
//
// Transport here is TCP between the endpoints' flow listeners — in
// production the same frames ride the mesh (M.16: untrusted plumbing;
// the flow's own signatures and seals are the trust, not the wire).

import crypto from 'node:crypto';
import net from 'node:net';
import {
  signPayload, verifyPayload, sha256Hex, fingerprintOfRaw,
} from './armor.mjs';

const b64 = (buf) => Buffer.from(buf).toString('base64');
const unb64 = (s) => Buffer.from(s, 'base64');

function xPubRaw(keyObject) { return Buffer.from(keyObject.export({ format: 'jwk' }).x, 'base64url'); }
function aeadSeal(key, nonce, plaintext) {
  const cipher = crypto.createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([ct, cipher.getAuthTag()]);
}
function aeadOpen(key, nonce, blob) {
  const ct = blob.subarray(0, blob.length - 16);
  const tag = blob.subarray(blob.length - 16);
  const d = crypto.createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}
function counterNonce(counter) {
  const n = Buffer.alloc(12);
  n.writeBigUInt64BE(BigInt(counter), 4);
  return n;
}
export const chainStep = (head, packetDigest) =>
  sha256Hex(Buffer.concat([Buffer.from(head, 'hex'), Buffer.from(packetDigest, 'hex')]));

// ---------------------------------------------------------------------------
// Flow session (one side). Pure state machine over frames so the
// battery can drive it in-process AND over real sockets:
//   hello (signed mesh doc, type 'flow-hello', body {eph_pub, mesh_addr})
//   frames: {counter, body_b64} — AEAD(flowKey, counter) over payload
//   receipt: signed doc type 'flow-receipt', body {flow_id, head, count}
// ---------------------------------------------------------------------------

export class Flow {
  constructor(me, peerSignFp, { meshAddr = null } = {}) {
    this.me = me;
    this.peerSignFp = peerSignFp;
    this.meshAddr = meshAddr; // this endpoint's mesh address (M.9 identity)
    this.flowId = crypto.randomUUID();
    this.eph = crypto.generateKeyPairSync('x25519');
    this.key = null;
    this.sendCounter = 0;
    this.recvCounter = 0;
    this.sentHead = 'GENESIS';
    this.recvHead = 'GENESIS';
    this.sentDigests = [];
    this.dead = null; // reason string once killed
    this.beacons = [];
  }

  hello() {
    return signPayload(this.me, {
      type: 'flow-hello', to_seal_fp: null,
      body: {
        flow_id: this.flowId,
        eph_pub: xPubRaw(this.eph.publicKey).toString('base64url'),
        mesh_addr: this.meshAddr,
      },
    });
  }

  // Accept the peer's hello: signature must verify AND the signer
  // must be the enrolled peer this flow was opened for (or, on the
  // answering side, any signer the caller admits — admission is the
  // descriptor check the server performs before constructing us).
  acceptHello(doc) {
    if (!doc || doc.type !== 'flow-hello' || !verifyPayload(doc)) {
      return this.kill('flow-hello-invalid');
    }
    if (this.peerSignFp && doc.from_sign_fp !== this.peerSignFp) {
      return this.kill('flow-hello-wrong-peer');
    }
    this.peerSignFp = doc.from_sign_fp;
    this.flowId = doc.body.flow_id;
    this.peerMeshAddr = doc.body.mesh_addr ?? null;
    const peerEph = crypto.createPublicKey({
      key: { kty: 'OKP', crv: 'X25519', x: doc.body.eph_pub }, format: 'jwk',
    });
    const shared = crypto.diffieHellman({ privateKey: this.eph.privateKey, publicKey: peerEph });
    const salt = Buffer.from(this.flowId, 'utf8');
    this.key = Buffer.from(crypto.hkdfSync('sha256', shared, salt,
      Buffer.from('scripture-armor/flow/v1'), 32));
    return { ok: true };
  }

  kill(reason) {
    this.dead = reason;
    this.beacons.push({ event: 'flow-killed', reason, at: new Date().toISOString() });
    return { ok: false, error: reason };
  }

  send(plaintext) {
    if (this.dead) return { ok: false, error: `flow-dead: ${this.dead}` };
    if (!this.key) return { ok: false, error: 'flow-not-open' };
    const counter = ++this.sendCounter;
    const sealed = aeadSeal(this.key, counterNonce(counter), plaintext);
    const digest = sha256Hex(plaintext);
    this.sentHead = this.sentHead === 'GENESIS'
      ? sha256Hex(Buffer.from(digest, 'hex'))
      : chainStep(this.sentHead, digest);
    this.sentDigests.push(digest);
    return { ok: true, frame: { counter, body_b64: b64(sealed) } };
  }

  receive(frame) {
    if (this.dead) return { ok: false, error: `flow-dead: ${this.dead}` };
    if (!this.key) return { ok: false, error: 'flow-not-open' };
    if (!frame || frame.counter !== this.recvCounter + 1) {
      return this.kill(`flow-counter-violation: expected ${this.recvCounter + 1}, got ${frame?.counter} (replay, reorder, or injection)`);
    }
    let plain;
    try {
      plain = aeadOpen(this.key, counterNonce(frame.counter), unb64(frame.body_b64));
    } catch {
      return this.kill('flow-aead-failure: packet altered or foreign (chain mismatch)');
    }
    this.recvCounter = frame.counter;
    const digest = sha256Hex(plain);
    this.recvHead = this.recvHead === 'GENESIS'
      ? sha256Hex(Buffer.from(digest, 'hex'))
      : chainStep(this.recvHead, digest);
    return { ok: true, plaintext: plain };
  }

  // A signed receipt over what THIS side received. The sender of the
  // data compares head/count against its own sent chain.
  receipt() {
    return signPayload(this.me, {
      type: 'flow-receipt', to_seal_fp: null,
      body: { flow_id: this.flowId, head: this.recvHead, count: this.recvCounter },
    });
  }

  // Verify a peer's receipt against my sent chain.
  verifyReceipt(doc) {
    if (!doc || doc.type !== 'flow-receipt' || !verifyPayload(doc)) {
      return { ok: false, error: 'receipt-invalid' };
    }
    if (doc.from_sign_fp !== this.peerSignFp) return { ok: false, error: 'receipt-wrong-peer' };
    if (doc.body.flow_id !== this.flowId) return { ok: false, error: 'receipt-wrong-flow' };
    if (doc.body.count !== this.sendCounter) {
      return { ok: false, error: `receipt-count-mismatch: peer has ${doc.body.count}, I sent ${this.sendCounter}` };
    }
    if (doc.body.head !== this.sentHead) {
      return { ok: false, error: 'receipt-chain-mismatch: what arrived is not what was sent, in order' };
    }
    return { ok: true };
  }
}

// ---------------------------------------------------------------------------
// TCP wiring: a flow server admits ONLY peers the caller's admit()
// accepts (the descriptor/member check lives with the caller — the
// battery passes an M.17-verified member set). Frames are NDJSON.
// ---------------------------------------------------------------------------

export function serveFlows(me, { port, host = '127.0.0.1', admit, onPacket, onBeacon }) {
  const flows = new Map();
  const server = net.createServer((conn) => {
    let buf = '';
    let flow = null;
    conn.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { conn.destroy(); return; }
        if (!flow) {
          if (!admit || !admit(msg)) { conn.destroy(); return; }
          flow = new Flow(me, msg.from_sign_fp, {});
          const acc = flow.acceptHello(msg);
          if (!acc.ok) { onBeacon && onBeacon(acc); conn.destroy(); return; }
          flows.set(flow.flowId, flow);
          conn.write(JSON.stringify(flow.hello()) + '\n');
          continue;
        }
        if (msg.receipt_request) {
          conn.write(JSON.stringify({ receipt: flow.receipt() }) + '\n');
          continue;
        }
        const r = flow.receive(msg);
        if (!r.ok) { onBeacon && onBeacon(r); conn.destroy(); return; }
        onPacket && onPacket(flow, r.plaintext);
      }
    });
    conn.on('error', () => {});
  });
  return new Promise((resolve) => {
    server.listen(port, host, () => resolve({ server, flows }));
  });
}

export function openFlow(me, peerSignFp, { port, host = '127.0.0.1', meshAddr = null }) {
  return new Promise((resolve, reject) => {
    const flow = new Flow(me, peerSignFp, { meshAddr });
    const conn = net.createConnection(port, host);
    const opener = setTimeout(() => {
      if (!opened) { try { conn.destroy(); } catch {} reject(new Error('flow-open-timeout: peer did not answer the hello (unenrolled or unreachable)')); }
    }, 3000);
    let buf = '';
    let opened = false;
    conn.on('connect', () => conn.write(JSON.stringify(flow.hello()) + '\n'));
    conn.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (!opened) {
          const acc = flow.acceptHello(msg);
          if (!acc.ok) { clearTimeout(opener); conn.destroy(); reject(new Error(acc.error)); return; }
          opened = true;
          clearTimeout(opener);
          resolve({
            flow, conn,
            send: (buf2) => {
              const r = flow.send(buf2);
              if (!r.ok) throw new Error(r.error);
              conn.write(JSON.stringify(r.frame) + '\n');
              return r;
            },
            requestReceipt: () => new Promise((res) => {
              const onData = (c2) => {
                const s = c2.toString('utf8');
                const m = s.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((o) => o && o.receipt);
                if (m) { conn.off('data', onData); res(m.receipt); }
              };
              conn.on('data', onData);
              conn.write(JSON.stringify({ receipt_request: true }) + '\n');
            }),
            close: () => conn.destroy(),
          });
          continue;
        }
      }
    });
    conn.on('error', (e) => { if (!opened) reject(e); });
  });
}

// ---------------------------------------------------------------------------
// M.18 — shaping. Estate node-to-node links run as a constant-rate,
// fixed-size stream: real flow frames are chopped into fixed-size
// cells emitted on a fixed tick; idle ticks emit sealed chaff cells
// (random plaintext under the same AEAD discipline — on the wire a
// chaff cell and a data cell are the same shape, because the visible
// layer is meaningless by construction, K.2). What a capture sees:
// uniform sizes, uniform timing, volume set by the bucket, not by
// the workload.
// ---------------------------------------------------------------------------

export const SHAPE_CELL_BYTES = 1024;

export class Shaper {
  constructor(flow, { tickMs = 10 } = {}) {
    this.flow = flow;
    this.tickMs = tickMs;
    this.queue = [];
    this.timer = null;
    this.sentCells = 0;
    this.chaffCells = 0;
  }
  push(plaintext) {
    // Chop into cell payloads of SHAPE_CELL_BYTES-64 (room for the
    // AEAD overhead + a 2-byte length prefix per cell fragment).
    const frag = SHAPE_CELL_BYTES - 64;
    for (let off = 0; off < plaintext.length; off += frag) {
      const part = plaintext.subarray(off, off + frag);
      const cell = Buffer.alloc(2 + part.length);
      cell.writeUInt16BE(part.length, 0);
      part.copy(cell, 2);
      this.queue.push(cell);
    }
    if (!plaintext.length) this.queue.push(Buffer.alloc(2));
  }
  // Emit exactly one cell (data if queued, else chaff). Returns the
  // flow frame, or the flow's refusal if the flow is dead.
  tick() {
    const cell = this.queue.length ? this.queue.shift() : null;
    let payload;
    if (cell) { payload = cell; }
    else {
      payload = crypto.randomBytes(SHAPE_CELL_BYTES - 64 + 2);
      payload.writeUInt16BE(0xffff, 0); // chaff marker (inside the seal)
      this.chaffCells++;
    }
    const padded = Buffer.alloc(SHAPE_CELL_BYTES - 64);
    payload.copy(padded, 0, 0, Math.min(payload.length, padded.length));
    const r = this.flow.send(padded);
    if (r.ok) this.sentCells++;
    return r;
  }
  // Receiver side: unshape a received plaintext cell → fragment or null (chaff).
  static unshape(plain) {
    const len = plain.readUInt16BE(0);
    if (len === 0xffff) return null;
    return plain.subarray(2, 2 + len);
  }
}

// ---------------------------------------------------------------------------
// M.9 — login binding (Addendum K's session standard) + brokering.
//
// bindLogin(deviceId, {service, session, meshAddr, nonce}): the
// device signs a binding statement — hash over service, session,
// mesh address, nonce — at login. The service stores the binding
// HASH (not a token). Per-session proof: the device produces signed
// receipts over (session, current flow chain head); the service
// checks (1) the connection's source mesh address == the bound mesh
// address, (2) the receipt signature verifies under the device key
// and its session matches. A stolen password/cookie/token replayed
// from anywhere else fails both: wrong address, no device key.
// ---------------------------------------------------------------------------

export const bindingHashOf = ({ service, session, mesh_addr, nonce }) =>
  sha256Hex(Buffer.from(JSON.stringify({ service, session, mesh_addr, nonce }), 'utf8'));

export function bindLogin(deviceId, { service, session, meshAddr, nonce }) {
  const core = { service, session, mesh_addr: meshAddr, nonce };
  const doc = signPayload(deviceId, {
    type: 'login-binding', to_seal_fp: null,
    body: { ...core, binding_hash: bindingHashOf(core) },
  });
  return doc;
}

export function sessionReceipt(deviceId, { session, chainHead }) {
  return signPayload(deviceId, {
    type: 'session-receipt', to_seal_fp: null,
    body: { session, chain_head: chainHead, at: new Date().toISOString() },
  });
}

// The participating service's verifier. Holds ONLY the binding hash +
// the device's public key + bound mesh address — no bearer secret.
export class BindingVerifier {
  constructor(bindingDoc) {
    if (!bindingDoc || bindingDoc.type !== 'login-binding' || !verifyPayload(bindingDoc)) {
      throw new Error('binding-invalid');
    }
    this.hash = bindingDoc.body.binding_hash;
    this.session = bindingDoc.body.session;
    this.meshAddr = bindingDoc.body.mesh_addr;
    this.deviceSignFp = bindingDoc.from_sign_fp;
    this.deviceSignPub = bindingDoc.from_sign_pub;
  }
  check({ sourceMeshAddr, receipt }) {
    if (sourceMeshAddr !== this.meshAddr) {
      return { ok: false, error: 'binding-address-mismatch: connection source is not the bound mesh address' };
    }
    if (!receipt || receipt.type !== 'session-receipt' || !verifyPayload(receipt)) {
      return { ok: false, error: 'binding-receipt-invalid' };
    }
    if (receipt.from_sign_fp !== this.deviceSignFp) {
      return { ok: false, error: 'binding-wrong-device: receipt not signed by the bound device key' };
    }
    if (receipt.body.session !== this.session) {
      return { ok: false, error: 'binding-session-mismatch' };
    }
    return { ok: true };
  }
}

// Brokered credentials for services that will NOT verify: the raw
// credential lives sealed in the vault; a broker session is a
// short-lived, scoped capability object — the endpoint holds the
// capability, never the credential; when the session dies the
// artifact is worthless (it names an expiry + a dead session id).
export function brokerSession(vaultId, { service, scope, ttlS = 300, nowMs = Date.now() }) {
  const doc = signPayload(vaultId, {
    type: 'broker-session', to_seal_fp: null,
    body: {
      service, scope,
      session: crypto.randomUUID(),
      expires_at: new Date(nowMs + ttlS * 1000).toISOString(),
    },
  });
  return doc;
}
export function brokerSessionValid(doc, nowMs = Date.now()) {
  if (!doc || doc.type !== 'broker-session' || !verifyPayload(doc)) return { ok: false, error: 'broker-artifact-invalid' };
  if (Date.parse(doc.body.expires_at) < nowMs) return { ok: false, error: 'broker-artifact-expired (session died; artifact is dead weight)' };
  return { ok: true, session: doc.body.session };
}
