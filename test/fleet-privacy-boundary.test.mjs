import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {sanitizeForFleet} from '../vendor/fleet/fleet-packet.mjs';
import {sealEnvelope,validateEnvelope} from '../lib/fleet-learning.mjs';
import {openSharing} from '../lib/sharing.mjs';
const draft={installationId:'fi_'+'a'.repeat(32),runtimeVersion:'4.5.3',device:{platform:'darwin',arch:'arm64',totalMemBytes:8*1024**3}};
test('raw private report and extra fields rejected despite false privacy flag',()=>{
 const raw={modelId:'fixture',prompt:'private@example.test',customerDataIncluded:false};
 assert.throws(()=>sealEnvelope(raw),/CLOSED_PACKET/);
 for(const env of [null,{}, {payload:raw,customerDataIncluded:false,sentAt:new Date().toISOString()}])assert.equal(validateEnvelope(env).valid,false);
 const p=sanitizeForFleet(draft).packet;const good=sealEnvelope(p);
 assert.equal(validateEnvelope(good).valid,true);assert.equal(validateEnvelope({...good,secret:'private'}).valid,false);
 p.prompt='private';assert.equal(validateEnvelope(good).valid,true,'sealed payload detached');
});
test('real sanitizer and outbound sink exclude private fixture fields; no permissive validator override',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'fleet-boundary-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const secret='secret-person@example.test';
 const packet=sanitizeForFleet({...draft,prompt:secret,files:[secret],device:{...draft.device,hostname:secret},preferences:[{statement:`email ${secret}`}]}).packet;
 const sent=[];let outgoing=packet;
 const s=openSharing({state:dir,env:{},buildPacket:async()=>outgoing,validate:()=>({ok:true}),send:async p=>{sent.push(JSON.stringify(p));return {ok:true};}});
 s.answer('yes please no');await s.contribute();assert.equal(sent.length,0,'ambiguous prefix is not opt in');
 s.answer('yes');await s.contribute();assert.equal(sent.length,1);assert.ok(!sent[0].includes(secret));
 outgoing={...packet,prompt:secret};assert.equal((await s.contribute()).sent,false);assert.equal(sent.length,1);
 outgoing=packet;s.answer('off');await s.contribute();assert.equal(sent.length,1);
});
test('withdrawal while a packet is building prevents send',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'fleet-withdraw-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));let finish;let sends=0;
 const s=openSharing({state:dir,env:{},buildPacket:()=>new Promise(r=>finish=r),send:async()=>{sends++;return {ok:true};}});
 s.answer('yes');const pending=s.contribute();s.answer('off');finish(sanitizeForFleet(draft).packet);assert.equal((await pending).sent,false);assert.equal(sends,0);
});
