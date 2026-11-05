// Public trust transitions only. This module cannot load or rotate a vault,
// authorize a user, enroll an authority, or access a private key store.
import crypto from 'node:crypto';
import {parsePublicBlock} from './armor.mjs';

const fields = ['schema','deviceId','epoch','previous','replacement','nonce','issuedAt','expiresAt'];
const signedFields = [...fields,'authoritySignature','replacementSignature','replacementPQSignature'];
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
function fail(message) { throw Error(`key-transition: ${message}`); }
function exact(object, names) {
  if (!object || Object.getPrototypeOf(object) !== Object.prototype ||
      Object.keys(object).length !== names.length || names.some(k => !Object.hasOwn(object,k))) fail('unexpected fields');
}
function hex(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
const signingKey = id => crypto.createPublicKey({format:'jwk',key:{kty:'OKP',crv:'Ed25519',x:id.sign_pub}});
const pqSigningKey = id => crypto.createPublicKey({format:'der',type:'spki',key:Buffer.from(id.mldsa_pub,'base64')});
function bytes(value, maximum = 12000) {
  if (typeof value !== 'string' || value.length > maximum || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) fail('invalid signature encoding');
  const out = Buffer.from(value,'base64');
  if (out.toString('base64') !== value) fail('noncanonical encoding');
  return out;
}
export function publicRevision(block) {
  if (typeof block !== 'string' || block.length > 16000) fail('invalid public identity');
  const id = parsePublicBlock(block);
  if (!id.kem_pub || !id.mldsa_pub) fail('post-quantum public keys required');
  // parsePublicBlock validates key material; never allow private fields in a
  // public transition, even if the existing public-block parser ignores them.
  const raw = JSON.parse(Buffer.from(block,'base64').toString('utf8'));
  exact(raw,['v','label','seal_pub','sign_pub','kem_pub','mldsa_pub']);
  return hash(JSON.stringify([id.seal_pub,id.sign_pub,id.kem_pub,id.mldsa_pub]));
}
export function authorityPublicKey(raw) {
  const p = bytes(raw,88);
  if (p.length !== 65 || p[0] !== 4) fail('P-256 authority required');
  return crypto.createPublicKey({format:'jwk',key:{kty:'EC',crv:'P-256',x:p.subarray(1,33).toString('base64url'),y:p.subarray(33).toString('base64url')}});
}
export function transitionBytes(doc) {
  if (doc.schema !== 'scripture-armor.key-transition/1' || !hex(doc.deviceId) || !hex(doc.previous) ||
      !hex(doc.nonce) || !Number.isSafeInteger(doc.epoch) || doc.epoch < 1 ||
      !Number.isSafeInteger(doc.issuedAt) || !Number.isSafeInteger(doc.expiresAt) ||
      doc.expiresAt <= doc.issuedAt || doc.expiresAt-doc.issuedAt > 86400) fail('invalid transition');
  if (publicRevision(doc.replacement) === doc.previous) fail('replacement must change keys');
  return Buffer.from(JSON.stringify(fields.map(k=>doc[k])));
}
export function verifyTransition(doc, enrolled, now = Math.floor(Date.now()/1000)) {
  exact(doc,signedFields);
  const payload = transitionBytes(doc);
  if (!Number.isSafeInteger(now) || now < doc.issuedAt || now >= doc.expiresAt) fail('transition outside validity window');
  if (doc.deviceId !== enrolled.deviceId || doc.epoch !== enrolled.epoch+1 ||
      doc.previous !== publicRevision(enrolled.publicIdentity)) fail('device, revision or epoch mismatch');
  if (!crypto.verify('sha256',payload,authorityPublicKey(enrolled.rotationAuthority),bytes(doc.authoritySignature,128))) fail('pinned rotation authority signature required');
  const next = parsePublicBlock(doc.replacement);
  if (!crypto.verify(null,payload,signingKey(next),bytes(doc.replacementSignature,128)) ||
      !crypto.verify(null,payload,pqSigningKey(next),bytes(doc.replacementPQSignature))) fail('replacement proof of possession required');
  return {deviceId:enrolled.deviceId,epoch:doc.epoch,publicIdentity:doc.replacement,
    rotationAuthority:enrolled.rotationAuthority,previousRevision:doc.previous,
    transitionId:hash(payload),authorityMode:'independently-pinned'};
}
export function beginAcknowledgements(transitionId, enrolledPeers) {
  if (!hex(transitionId) || !Array.isArray(enrolledPeers) || enrolledPeers.length > 10000 ||
      enrolledPeers.some(p=>!hex(p)) || new Set(enrolledPeers).size !== enrolledPeers.length) fail('invalid enrolled peers');
  return Object.freeze({transitionId,peers:Object.freeze(Object.fromEntries(enrolledPeers.map(p=>[p,'pending'])))});
}
// The caller must authenticate a peer receipt against that peer's pinned keys.
// A boolean, network address or claimed bot name is deliberately not accepted.
export function acknowledgeTransition(state, receipt, peerPublicIdentity) {
  exact(receipt,['schema','transitionId','peerRevision','signature','pqSignature']);
  const revision=publicRevision(peerPublicIdentity);
  if (receipt.schema !== 'scripture-armor.key-transition-ack/1' ||
      receipt.transitionId !== state.transitionId || receipt.peerRevision !== revision ||
      state.peers[revision] !== 'pending') fail('unexpected or replayed peer acknowledgement');
  const payload=Buffer.from(JSON.stringify([receipt.schema,receipt.transitionId,receipt.peerRevision]));
  const peer=parsePublicBlock(peerPublicIdentity);
  if (!crypto.verify(null,payload,signingKey(peer),bytes(receipt.signature,128)) ||
      !crypto.verify(null,payload,pqSigningKey(peer),bytes(receipt.pqSignature))) fail('authenticated peer acknowledgement required');
  return Object.freeze({...state,peers:Object.freeze({...state.peers,[revision]:'acknowledged'})});
}
export function acknowledgementStatus(state) {
  const pending=Object.entries(state.peers).filter(([,s])=>s!=='acknowledged').map(([p])=>p);
  return {complete:pending.length===0,pending,acknowledged:Object.keys(state.peers).length-pending.length};
}
