// heartbeat.mjs — OWNER AMENDMENT (2026-11-14): satellite is a narrowband SIGNALING / CONTINUITY
// channel (heartbeat / attestation class), never a streaming plane — a metered portion is 1 MiB;
// a satellite message is tens of bytes. This codec is the whole satellite surface: 35 bytes.
//   v(1) state(1) trust(1) seq(4 BE) at(4 BE, unix s) attestDigest(16, truncated sha256) mac(8)
// The MAC is HMAC-SHA256 truncated, keyed by session-dispensed material (vault §3.1 pattern) — a
// continuity proof, not a root signature. The full attestation rides the next broadband path.
import { createHmac, createHash } from 'node:crypto';
const STATE_CODE = { OPS: 1, RED: 2, CONTAINMENT: 3, SEALED: 4, FORGE: 5, SETTLE: 6 };
const CODE_STATE = Object.fromEntries(Object.entries(STATE_CODE).map(([k, v]) => [v, k]));
export const HEARTBEAT_BYTES = 35;
export function encodeHeartbeat({ state, trust, seq, at, attestDigestHex, macKey }) {
  const b = Buffer.alloc(HEARTBEAT_BYTES - 8);
  b[0] = 1; b[1] = STATE_CODE[state] ?? 0; b[2] = trust; b.writeUInt32BE(seq, 3); b.writeUInt32BE(at, 7);
  Buffer.from(createHash('sha256').update(attestDigestHex).digest()).copy(b, 11, 0, 16);
  const mac = createHmac('sha256', macKey).update(b).digest().subarray(0, 8);
  return Buffer.concat([b, mac]);
}
export function decodeHeartbeat(buf, macKey) {
  if (buf.length !== HEARTBEAT_BYTES) throw new Error(`heartbeat must be ${HEARTBEAT_BYTES} B, got ${buf.length}`);
  const body = buf.subarray(0, HEARTBEAT_BYTES - 8), mac = buf.subarray(HEARTBEAT_BYTES - 8);
  const expect = createHmac('sha256', macKey).update(body).digest().subarray(0, 8);
  if (!mac.equals(expect)) throw new Error('heartbeat MAC mismatch — not from a dispensed session key');
  return { v: body[0], state: CODE_STATE[body[1]], trust: body[2], seq: body.readUInt32BE(3), at: body.readUInt32BE(7), attestDigest16: body.subarray(11, 27).toString('hex') };
}
