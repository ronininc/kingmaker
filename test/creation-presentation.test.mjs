import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {presentCreation} from '../lib/creation-presentation.mjs';
test('presentation verifies artifacts and preserves incomplete workflow nodes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'presentation-'));
 try{const path=join(root,'a b.png');await writeFile(path,'fixture');
 const sha256=createHash('sha256').update('fixture').digest('hex');
 const result={status:'incomplete',runs:[{id:'a',workDir:root,result:{status:'completed',outputs:{assets:{ok:true,record:{schema:'kingmaker.native-asset-skill/1',status:'completed',artifacts:[{path,sha256}]}}}}},{id:'b',result:{status:'incomplete'}}]};
 const p=await presentCreation(result);assert.equal(p.nodes[0].artifacts[0].kind,'image');assert.match(p.nodes[0].artifacts[0].uri,/a%20b.png$/);assert.equal(p.nodes[1].status,'incomplete');assert.equal(p.qualityCertified,false);assert.deepEqual(p.edges,[{from:'a',to:'b'}]);
 await writeFile(path,'changed');await assert.rejects(presentCreation(result),/changed/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('presentation refuses symlink escape',async()=>{
 const root=await mkdtemp(join(tmpdir(),'presentation-'));const outside=await mkdtemp(join(tmpdir(),'presentation-out-'));
 try{await writeFile(join(outside,'x'),'x');await symlink(join(outside,'x'),join(root,'x'));await assert.rejects(presentCreation({runs:[{workDir:root,result:{status:'completed',outputs:{a:{ok:true,record:{schema:'kingmaker.native-asset-skill/1',status:'completed',artifacts:[{path:join(root,'x')}]}}}}}]}),/outside/);}finally{await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});
