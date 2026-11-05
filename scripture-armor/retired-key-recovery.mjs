// Encrypted, decryption-only recovery material for a retired identity.
// No filesystem, command line, network, enrollment, or rotation trigger.
import crypto from 'node:crypto';
import {sealPlaintext,parseScriptureFile,verifyFrameSignature,unsealFileKey,armorDecode,openSealedFile,fingerprintOfRaw} from './armor.mjs';

const fields=['schema','seal_pub','seal_priv','kem_pub','kem_priv'];
function assertRecord(record) {
  if (!record || Object.getPrototypeOf(record)!==Object.prototype ||
      Object.keys(record).length!==fields.length || fields.some(k=>!Object.hasOwn(record,k)) ||
      record.schema!=='scripture-armor.retired-decryption/1' ||
      fields.some(k=>typeof record[k]!=='string') || JSON.stringify(record).length>16000) throw Error('retired-key-recovery: invalid record');
}
function decode(record) {
  assertRecord(record);
  const rawPrivate=Buffer.from(record.seal_priv,'base64url');
  if (rawPrivate.length!==32) throw Error('retired-key-recovery: invalid X25519 key');
  const der=Buffer.concat([Buffer.from('302e020100300506032b656e04220420','hex'),rawPrivate]);
  const sealPriv=crypto.createPrivateKey({format:'der',type:'pkcs8',key:der});
  rawPrivate.fill(0);der.fill(0);
  const kemPriv=crypto.createPrivateKey({format:'der',type:'pkcs8',key:Buffer.from(record.kem_priv,'base64')});
  const sealPub=crypto.createPublicKey(sealPriv).export({format:'jwk'}).x;
  const kemPub=crypto.createPublicKey(kemPriv).export({format:'der',type:'spki'}).toString('base64');
  if (kemPriv.asymmetricKeyType!=='ml-kem-768' || sealPub!==record.seal_pub || kemPub!==record.kem_pub) throw Error('retired-key-recovery: public/private key mismatch');
  // Deliberately omit all signing fields and private signing KeyObjects.
  return Object.freeze({sealPriv,kemPriv,sealFp:fingerprintOfRaw(Buffer.from(sealPub,'base64url')),kemFp:fingerprintOfRaw(Buffer.from(kemPub,'base64'))});
}
export function sealRetiredDecryption(oldIdentity,newIdentity) {
  if (oldIdentity.sealFp===newIdentity.sealFp || oldIdentity.kemFp===newIdentity.kemFp ||
      oldIdentity.signFp===newIdentity.signFp || oldIdentity.mldsaFp===newIdentity.mldsaFp) throw Error('retired-key-recovery: all replacement keys must change');
  const record={schema:'scripture-armor.retired-decryption/1',seal_pub:oldIdentity.seal_pub,
    seal_priv:oldIdentity.seal_priv,kem_pub:oldIdentity.kem_pub,kem_priv:oldIdentity.kem_priv};
  decode(record);
  const clear=Buffer.from(JSON.stringify(record));
  try {
    const sealed=sealPlaintext(clear,newIdentity,newIdentity);
    const restored=openRetiredDecryption(sealed.text,newIdentity);
    if (restored.sealFp!==oldIdentity.sealFp || restored.kemFp!==oldIdentity.kemFp) throw Error('retired-key-recovery: verification failed');
    return sealed.text;
  } finally { clear.fill(0); }
}
function readRetiredRecord(text,currentIdentity) {
  if (typeof text!=='string' || Buffer.byteLength(text)>128000) throw Error('retired-key-recovery: oversized package');
  const {frame,body}=parseScriptureFile(text);
  if (frame.v!==4 || frame.sender_sign_fp!==currentIdentity.signFp ||
      frame.sender_mldsa_fp!==currentIdentity.mldsaFp || frame.recipient_seal_fp!==currentIdentity.sealFp ||
      frame.recipient_kem_fp!==currentIdentity.kemFp || !verifyFrameSignature(frame,body)) throw Error('retired-key-recovery: authenticated current-generation package required');
  const key=unsealFileKey(currentIdentity,frame);
  let clear;
  try {
    clear=openSealedFile(key,frame,armorDecode(body,Buffer.from(frame.armor_seed,'base64')));
    if (clear.length>16000) throw Error('retired-key-recovery: oversized record');
    const record=JSON.parse(clear.toString('utf8')); decode(record); return record;
  } finally { key.fill(0); clear?.fill(0); }
}

export function openRetiredDecryption(text,currentIdentity) {
  return decode(readRetiredRecord(text,currentIdentity));
}
// Re-encrypt a historical decryption-only record to the next generation. Old
// signing keys are neither needed nor carried forward; no plaintext is written.
export function rebindRetiredDecryption(text,currentIdentity,nextIdentity) {
  if (currentIdentity.sealFp === nextIdentity.sealFp || currentIdentity.kemFp === nextIdentity.kemFp ||
      currentIdentity.signFp === nextIdentity.signFp || currentIdentity.mldsaFp === nextIdentity.mldsaFp) throw Error('retired-key-recovery: all replacement keys must change');
  const record=readRetiredRecord(text,currentIdentity), expected=decode(record);
  const clear=Buffer.from(JSON.stringify(record));
  try {
    const sealed=sealPlaintext(clear,nextIdentity,nextIdentity);
    const actual=openRetiredDecryption(sealed.text,nextIdentity);
    if (actual.sealFp !== expected.sealFp || actual.kemFp !== expected.kemFp) throw Error('retired-key-recovery: rebinding verification failed');
    return sealed.text;
  } finally {clear.fill(0);}
}
