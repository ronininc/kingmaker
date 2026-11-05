import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createIdentity,sealPlaintext,parseScriptureFile,unsealFileKey,armorDecode,openSealedFile} from '../armor.mjs';
import {sealRetiredDecryption,openRetiredDecryption} from '../retired-key-recovery.mjs';

test('retired encryption keys recover old v4 data but contain no old signing authority',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'armor-retired-keys-fixture-'));
  try {
    const old=createIdentity(path.join(dir,'old'),'old-fixture'),next=createIdentity(path.join(dir,'next'),'next-fixture');
    const plaintext=Buffer.from('inert pre-rotation credential fixture');
    const before=sealPlaintext(plaintext,old,old);
    const archive=sealRetiredDecryption(old,next);
    for(const secret of [old.seal_priv,old.kem_priv,old.sign_priv,old.mldsa_priv])assert.equal(archive.includes(secret),false);
    const retired=openRetiredDecryption(archive,next);
    assert.deepEqual(Object.keys(retired).sort(),['kemFp','kemPriv','sealFp','sealPriv']);
    assert.equal(retired.sealFp,old.sealFp);assert.equal(retired.kemFp,old.kemFp);
    const {frame,body}=parseScriptureFile(before.text),key=unsealFileKey(retired,frame);
    try{assert.deepEqual(openSealedFile(key,frame,armorDecode(body,Buffer.from(frame.armor_seed,'base64'))),plaintext);}finally{key.fill(0);}
    assert.throws(()=>unsealFileKey(next,frame));
    assert.throws(()=>crypto.sign(null,Buffer.from('new command'),retired.signPriv));
    assert.throws(()=>openRetiredDecryption(archive,old),/current-generation/);
    assert.throws(()=>sealRetiredDecryption(old,old),/all replacement/);
    const modified=archive.replace(/("sig":")([A-Za-z0-9+/])/,(_,prefix,c)=>prefix+(c==='A'?'B':'A'));
    assert.notEqual(modified,archive);assert.throws(()=>openRetiredDecryption(modified,next));
    const outsider=sealPlaintext(Buffer.from('{}'),old,next);
    assert.throws(()=>openRetiredDecryption(outsider.text,next),/current-generation/);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
