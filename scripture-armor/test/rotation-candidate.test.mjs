import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {generateIdentityRecord,identityFromRecord,publicBlock,sealPlaintext,parseScriptureFile,unsealFileKey,armorDecode,openSealedFile,identityTag} from '../armor.mjs';
import {initialKeySnapshot,prepareKeyRotation,validateKeySnapshot} from '../rotation-candidate.mjs';
import {openRetiredDecryption} from '../retired-key-recovery.mjs';
import {verifyTransition} from '../key-transition.mjs';
function fixture(){return initialKeySnapshot(generateIdentityRecord('inert-rotation-fixture'),crypto.randomBytes(32).toString('hex'));}
test('in-memory identity generation validates every classical and post-quantum key pair',()=>{
  const record=generateIdentityRecord('inert'), identity=identityFromRecord(record);
  assert.equal(identity.label,'inert');
  assert.throws(()=>identityFromRecord({...record,approved:true}),/invalid/);
  assert.throws(()=>identityFromRecord({...record,integrity:'wrong'}),/invalid/);
  const another=generateIdentityRecord('inert');
  for(const field of ['seal_pub','sign_pub','kem_pub','mldsa_pub']) {
    const wrong={...record,[field]:another[field]};wrong.integrity=identityTag(wrong);
    assert.throws(()=>identityFromRecord(wrong),/invalid or mismatched/);
  }
});
test('two rotations preserve old encrypted data without retaining retired signing authority',()=>{
  const before=fixture(), pristine=JSON.stringify(before), old=validateKeySnapshot(before);
  const saved=sealPlaintext(Buffer.from('inert historical credential'),old,old);
  const first=prepareKeyRotation(before), firstState=JSON.parse(first.snapshot);
  assert.equal(JSON.stringify(before),pristine);
  const second=prepareKeyRotation(firstState), current=JSON.parse(second.snapshot), identity=validateKeySnapshot(current);
  assert.equal(current.deviceId,before.deviceId);assert.equal(current.epoch,2);assert.equal(current.retired.length,2);
  for(const key of ['seal_pub','sign_pub','kem_pub','mldsa_pub']) assert.notEqual(identity[key],old[key]);
  for(const secret of ['sign_priv','mldsa_priv']) assert.equal(second.snapshot.includes(Buffer.from(old[secret])),false);
  const recovered=openRetiredDecryption(current.retired[0].package,identity);
  assert.equal(recovered.signPriv,undefined);assert.equal(recovered.mldsaPriv,undefined);
  const {frame,body}=parseScriptureFile(saved.text),fileKey=unsealFileKey(recovered,frame);
  try {assert.equal(openSealedFile(fileKey,frame,armorDecode(body,Buffer.from(frame.armor_seed,'base64'))).toString(),'inert historical credential');}
  finally {fileKey.fill(0);first.snapshot.fill(0);second.snapshot.fill(0);}
});
test('replacement proofs verify with an independently enrolled authority and reject changed public metadata',()=>{
  const state=fixture(),identity=validateKeySnapshot(state),draft=prepareKeyRotation(state);
  const authority=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'}),jwk=authority.publicKey.export({format:'jwk'});
  const pin=Buffer.concat([Buffer.from([4]),Buffer.from(jwk.x,'base64url'),Buffer.from(jwk.y,'base64url')]).toString('base64');
  const document={...draft.publicProof,authoritySignature:crypto.sign('sha256',draft.transition,authority.privateKey).toString('base64')};
  const enrolled={deviceId:state.deviceId,epoch:0,publicIdentity:publicBlock(identity),rotationAuthority:pin};
  assert.equal(verifyTransition(document,enrolled).epoch,1);
  assert.throws(()=>verifyTransition({...document,epoch:2},enrolled),/mismatch/);
  draft.snapshot.fill(0);
});
test('snapshot preparation refuses unknown fields, corrupt recovery and unsafe generations',()=>{
  const state=fixture();
  for(const change of [{approved:true},{epoch:-1},{epoch:Number.MAX_SAFE_INTEGER},{deviceId:'claimed-admin'}]) {
    assert.throws(()=>prepareKeyRotation({...state,...change}));
  }
  const candidate=prepareKeyRotation(state),next=JSON.parse(candidate.snapshot);
  next.retired[0].package='inert corrupt fixture';
  assert.throws(()=>prepareKeyRotation(next));candidate.snapshot.fill(0);
});
