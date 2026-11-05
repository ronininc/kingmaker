import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {generateIdentityRecord,identityFromRecord,publicBlock,sealPlaintext,parseScriptureFile,unsealFileKey,armorDecode,openSealedFile} from '../armor.mjs';
import {sealRetiredDecryption,openRetiredDecryption} from '../retired-key-recovery.mjs';
import {publicRevision,verifyTransition} from '../key-transition.mjs';
import {initialKeySnapshot,prepareKeyRotation} from '../rotation-candidate.mjs';
const armor=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
test('native rotation commits a real Armor identity and a verifiable public transition together', {skip:process.platform!=='darwin',timeout:90000},()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'armor-native-rotation-'));
  try {
    const oldRecord=generateIdentityRecord('rotation-fixture'),old=identityFromRecord(oldRecord);
    const initialState=initialKeySnapshot(oldRecord,crypto.randomBytes(32).toString('hex'));
    const candidate=prepareKeyRotation(initialState);
    const nextState=JSON.parse(candidate.snapshot),next=identityFromRecord(nextState.identity);
    const previous=publicRevision(publicBlock(old)),revision=candidate.revision;
    const transition=candidate.publicProof,payload=candidate.transition;
    const recovery=nextState.retired[0].package;
    const packageBefore=sealPlaintext(Buffer.from('inert credential fixture'),old,old);
    const initial=Buffer.from(JSON.stringify(initialState)),snapshot=candidate.snapshot;
    const executable=path.join(folder,'native-proof');
    execFileSync('swiftc',['-j','1','-D','ARMOR_AUTH_TESTS',
      ...['mac/LocalKeyAuthorization.swift','mac/ProtectedIdentityVault.swift','mac/ProtectedGenerationStore.swift','mac/NativeKeyRotation.swift','test/native-rotation-transaction.swift'].map(f=>path.join(armor,f)),
      '-framework','LocalAuthentication','-framework','Security','-o',executable],{stdio:'pipe',timeout:60000});
    const result=JSON.parse(execFileSync(executable,[],{input:JSON.stringify({initial:initial.toString('base64'),snapshot:snapshot.toString('base64'),transition:payload.toString('base64'),previous,revision}),encoding:'utf8',timeout:20000}));
    const document={...transition,authoritySignature:result.signature};
    const updated=verifyTransition(document,{deviceId:transition.deviceId,epoch:0,publicIdentity:publicBlock(old),rotationAuthority:result.authority});
    assert.equal(updated.publicIdentity,publicBlock(next));
    assert.equal(result.epoch,1);assert.equal(result.revision,revision);
    assert.equal(result.snapshotHash,crypto.createHash('sha256').update(snapshot).digest('hex'));
    assert.equal(result.checks.length,7);
    const retired=openRetiredDecryption(recovery,next);
    assert.equal(retired.sealFp,old.sealFp);assert.equal(retired.signPriv,undefined);assert.equal(retired.mldsaPriv,undefined);
    // The old package remains authentic and retains a decryption-only recovery
    // route; no retired signing authority is included in the new snapshot.
    const {frame,body}=parseScriptureFile(packageBefore.text);
    const fileKey=unsealFileKey(retired,frame);
    try {assert.equal(openSealedFile(fileKey,frame,armorDecode(body,Buffer.from(frame.armor_seed,'base64'))).toString(),'inert credential fixture');}
    finally {fileKey.fill(0);}
    initial.fill(0);snapshot.fill(0);
  } finally {fs.rmSync(folder,{recursive:true,force:true});}
});
