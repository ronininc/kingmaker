// Pure, in-memory preparation for the native rotation transaction. This module
// never reads an identity file, writes plaintext, authorizes, commits, or sends.
import crypto from 'node:crypto';
import {generateIdentityRecord,identityFromRecord,publicBlock,parsePublicBlock,fingerprintOfRaw} from './armor.mjs';
import {publicRevision,transitionBytes} from './key-transition.mjs';
import {sealRetiredDecryption,openRetiredDecryption,rebindRetiredDecryption} from './retired-key-recovery.mjs';
const SCHEMA='scripture-armor.runtime-key-snapshot/1';
const MAX=8*1024*1024;
const hex=v=>typeof v==='string' && /^[a-f0-9]{64}$/.test(v);
function exact(v,fields) {
  if (!v || Object.getPrototypeOf(v)!==Object.prototype || Object.keys(v).length!==fields.length ||
      fields.some(k=>!Object.hasOwn(v,k))) throw Error('rotation candidate: invalid snapshot shape');
}
export function validateKeySnapshot(snapshot) {
  exact(snapshot,['schema','deviceId','epoch','identity','retired']);
  if (snapshot.schema!==SCHEMA || !hex(snapshot.deviceId) || !Number.isSafeInteger(snapshot.epoch) || snapshot.epoch<0 ||
      !Array.isArray(snapshot.retired) || snapshot.retired.length>128 || Buffer.byteLength(JSON.stringify(snapshot))>MAX) throw Error('rotation candidate: invalid snapshot');
  const identity=identityFromRecord(snapshot.identity), seen=new Set([publicRevision(publicBlock(identity))]);
  for (const entry of snapshot.retired) {
    exact(entry,['publicIdentity','package']);
    const revision=publicRevision(entry.publicIdentity), pub=parsePublicBlock(entry.publicIdentity);
    if (seen.has(revision)) throw Error('rotation candidate: repeated retired generation');
    seen.add(revision);
    const recovered=openRetiredDecryption(entry.package,identity);
    if (recovered.sealFp!==fingerprintOfRaw(Buffer.from(pub.seal_pub,'base64url')) ||
        recovered.kemFp!==fingerprintOfRaw(Buffer.from(pub.kem_pub,'base64'))) throw Error('rotation candidate: retired public binding mismatch');
  }
  return identity;
}
export function initialKeySnapshot(record,deviceId) {
  const snapshot={schema:SCHEMA,deviceId,epoch:0,identity:structuredClone(record),retired:[]};
  validateKeySnapshot(snapshot); return snapshot;
}
export function prepareKeyRotation(snapshot,{now=Math.floor(Date.now()/1000)}={}) {
  const current=validateKeySnapshot(snapshot);
  if (!Number.isSafeInteger(now) || now<0 || now>Number.MAX_SAFE_INTEGER-300 || snapshot.epoch>=Number.MAX_SAFE_INTEGER || snapshot.retired.length>=128) throw Error('rotation candidate: time or generation limit');
  const record=generateIdentityRecord(current.label), next=identityFromRecord(record);
  const retired=snapshot.retired.map(entry=>({publicIdentity:entry.publicIdentity,
    package:rebindRetiredDecryption(entry.package,current,next)}));
  retired.push({publicIdentity:publicBlock(current),package:sealRetiredDecryption(current,next)});
  const replacement={schema:SCHEMA,deviceId:snapshot.deviceId,epoch:snapshot.epoch+1,identity:record,retired};
  validateKeySnapshot(replacement);
  const revision=publicRevision(publicBlock(next));
  const document={schema:'scripture-armor.key-transition/1',deviceId:snapshot.deviceId,epoch:replacement.epoch,
    previous:publicRevision(publicBlock(current)),replacement:publicBlock(next),nonce:crypto.randomBytes(32).toString('hex'),issuedAt:now,expiresAt:now+300};
  const transition=transitionBytes(document);
  return {snapshot:Buffer.from(JSON.stringify(replacement)),transition,revision,
    publicProof:{...document,replacementSignature:crypto.sign(null,transition,next.signPriv).toString('base64'),
      replacementPQSignature:crypto.sign(null,transition,next.mldsaPriv).toString('base64')}};
}
