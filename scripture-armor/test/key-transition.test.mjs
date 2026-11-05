import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createIdentity,publicBlock} from '../armor.mjs';
import {publicRevision,transitionBytes,verifyTransition,beginAcknowledgements,acknowledgeTransition,acknowledgementStatus} from '../key-transition.mjs';

test('independent authority, replacement proof, epochs and authenticated offline acknowledgements',{timeout:10000},()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'armor-key-transition-fixture-'));
  try {
    const old=createIdentity(path.join(dir,'old'),'fixture'),next=createIdentity(path.join(dir,'next'),'fixture');
    const peer=createIdentity(path.join(dir,'peer'),'peer'),unknown=createIdentity(path.join(dir,'unknown'),'unknown');
    const authority=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'}),wrong=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});
    const jwk=authority.publicKey.export({format:'jwk'});
    const raw=Buffer.concat([Buffer.from([4]),Buffer.from(jwk.x,'base64url'),Buffer.from(jwk.y,'base64url')]).toString('base64');
    const state={deviceId:crypto.randomBytes(32).toString('hex'),epoch:0,publicIdentity:publicBlock(old),rotationAuthority:raw};
    const doc={schema:'scripture-armor.key-transition/1',deviceId:state.deviceId,epoch:1,previous:publicRevision(state.publicIdentity),replacement:publicBlock(next),nonce:crypto.randomBytes(32).toString('hex'),issuedAt:100,expiresAt:200};
    const payload=transitionBytes(doc);
    const signed={...doc,authoritySignature:crypto.sign('sha256',payload,authority.privateKey).toString('base64'),replacementSignature:crypto.sign(null,payload,next.signPriv).toString('base64'),replacementPQSignature:crypto.sign(null,payload,next.mldsaPriv).toString('base64')};
    const updated=verifyTransition(signed,state,150);
    assert.equal(updated.epoch,1);assert.equal(updated.publicIdentity,publicBlock(next));
    assert.equal(updated.rotationAuthority,raw);assert.equal(state.epoch,0);
    assert.throws(()=>verifyTransition(signed,updated,150),/epoch mismatch/);
    assert.throws(()=>verifyTransition(signed,state,200),/validity window/);
    assert.throws(()=>verifyTransition(signed,state,99),/validity window/);
    assert.throws(()=>verifyTransition({...signed,deviceId:'f'.repeat(64)},state,150),/mismatch/);
    assert.throws(()=>verifyTransition({...signed,epoch:3},state,150),/mismatch/);
    assert.throws(()=>verifyTransition({...signed,nonce:'a'.repeat(64)},state,150),/authority/);
    assert.throws(()=>verifyTransition({...signed,authoritySignature:crypto.sign('sha256',payload,wrong.privateKey).toString('base64')},state,150),/authority/);
    // An attacker holding the old classical AND PQ signing keys still cannot
    // replace the independently enrolled device-owner rotation authority.
    assert.throws(()=>verifyTransition({...signed,authoritySignature:crypto.sign(null,payload,old.signPriv).toString('base64')},state,150));
    assert.throws(()=>verifyTransition({...signed,replacementSignature:crypto.sign(null,payload,old.signPriv).toString('base64')},state,150),/possession/);
    assert.throws(()=>verifyTransition({...signed,replacementPQSignature:crypto.sign(null,payload,old.mldsaPriv).toString('base64')},state,150),/possession/);
    assert.throws(()=>verifyTransition({...signed,approved:true},state,150),/unexpected fields/);
    const leaked=JSON.parse(Buffer.from(doc.replacement,'base64'));leaked.sign_priv='forbidden';
    assert.throws(()=>transitionBytes({...doc,replacement:Buffer.from(JSON.stringify(leaked)).toString('base64')}),/unexpected fields/);
    const peerRevision=publicRevision(publicBlock(peer)),offlineRevision=publicRevision(publicBlock(unknown));
    const pending=beginAcknowledgements(updated.transitionId,[peerRevision,offlineRevision]);
    assert.deepEqual(acknowledgementStatus(pending),{complete:false,pending:[peerRevision,offlineRevision],acknowledged:0});
    function receipt(id){const r={schema:'scripture-armor.key-transition-ack/1',transitionId:updated.transitionId,peerRevision:publicRevision(publicBlock(id))};const p=Buffer.from(JSON.stringify(Object.values(r)));return {...r,signature:crypto.sign(null,p,id.signPriv).toString('base64'),pqSignature:crypto.sign(null,p,id.mldsaPriv).toString('base64')};}
    const accepted=acknowledgeTransition(pending,receipt(peer),publicBlock(peer));
    assert.deepEqual(acknowledgementStatus(accepted),{complete:false,pending:[offlineRevision],acknowledged:1});
    assert.throws(()=>acknowledgeTransition(accepted,receipt(peer),publicBlock(peer)),/replayed/);
    assert.throws(()=>acknowledgeTransition(pending,{...receipt(peer),pqSignature:receipt(unknown).pqSignature},publicBlock(peer)),/authenticated/);
    assert.throws(()=>acknowledgeTransition(beginAcknowledgements(updated.transitionId,[peerRevision]),receipt(unknown),publicBlock(unknown)),/unexpected/);
    const complete=acknowledgeTransition(accepted,receipt(unknown),publicBlock(unknown));
    assert.equal(acknowledgementStatus(complete).complete,true);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
