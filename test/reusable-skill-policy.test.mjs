import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,existsSync,readFileSync,writeFileSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {createHash} from 'node:crypto';
import {reviewSkillMint,materializeReviewedMethod,buildReusableSkillPacket,buildMintedReusableSkillPacket,validateReusableSkillPacket} from '../lib/reusable-skill-policy.mjs';
import {createSkillFolder} from '../lib/skill-create.mjs';import {absorbConnector} from '../lib/absorb.mjs';
import {openSharing,FLEET_DISCLOSURE_TEXT,FLEET_DISCLOSURE_DIGEST} from '../lib/sharing.mjs';import {fleetTransport} from '../lib/fleet-transport.mjs';
const installationId='fi_'+'a'.repeat(32);
const fresh=t=>{const s=mkdtempSync(join(tmpdir(),'skill-policy-'));t.after(()=>rmSync(s,{recursive:true,force:true}));return s;};
test('active mint refuses credentials, private content and unknown rights without echoing inputs or writing skills',t=>{
 const state=fresh(t);
 for(const input of ['password = private-password-here','api_key: abcdefghijklmnop','-----BEGIN PRIVATE KEY----- secret','customer@example.com','proprietary client project','ordinary text with no obvious secret']){
 const spec={name:'candidate',instructions:input,license:'Apache-2.0',safe:true};
 const r=createSkillFolder(state,spec);assert.equal(r.ok,false);assert.ok(r.flags.includes('unknown_content_or_rights'));assert.ok(!JSON.stringify(r).includes(input));assert.equal(existsSync(join(state,'skills','candidate')),false);
 }
 const absorbed=absorbConnector('private connector',[{name:'read',description:'password: dont-echo-me'}],{state});assert.deepEqual(absorbed.minted,[]);assert.ok(absorbed.flags[0].codes.includes('credential_or_secret'));assert.ok(!JSON.stringify(absorbed).includes('dont-echo-me'));
});
test('reviewed original method mints and exports only exact Apache component; outputs remain owner controlled',t=>{
 const state=fresh(t);assert.equal(buildMintedReusableSkillPacket({state,installationId}),null);
 const made=createSkillFolder(state,{methodId:'file-review'});assert.equal(made.ok,true);const packet=buildMintedReusableSkillPacket({state,installationId});assert.equal(validateReusableSkillPacket(packet).ok,true);assert.equal(packet.methods[0].license,'Apache-2.0');assert.match(packet.methods[0].projectOutputsLicense,/owner-controlled/);
 writeFileSync(join(made.dir,'SKILL.md'),'password = PRIVATE_PROJECT_CONTENT');const again=buildMintedReusableSkillPacket({state,installationId});assert.ok(!JSON.stringify(again).includes('PRIVATE_PROJECT_CONTENT'));
 for(const mutate of [p=>p.methods[0].instructions+='secret',p=>p.preferences=[],p=>p.methods[0].authorship='unverified author',p=>p.methods[0].license='unknown']){const p=structuredClone(packet);mutate(p);assert.equal(validateReusableSkillPacket(p).ok,false);}
 assert.throws(()=>materializeReviewedMethod('unknown'),/RIGHTS/);
});
test('actual sharing path requires new disclosure and stops on withdrawal; permissive validator cannot admit non-skill telemetry',async t=>{
 const state=fresh(t),sent=[];let resolveBuild;let packet=buildReusableSkillPacket({installationId,methodIds:['file-review']});
 const s=openSharing({state,env:{},buildPacket:async()=>packet,validate:()=>({ok:true}),send:async p=>{sent.push(p);return {ok:true};}});
 assert.equal(s.ask().defaultChoice,'no');assert.equal(createHash('sha256').update(FLEET_DISCLOSURE_TEXT).digest('hex'),FLEET_DISCLOSURE_DIGEST);
 s.answer('yes');assert.equal((await s.contribute()).sent,true);assert.equal(sent.length,1);
 packet={...packet,preferences:[{password:'never send'}]};assert.equal((await s.contribute()).sent,false);assert.equal(sent.length,1);
 const legacy=JSON.parse(readFileSync(s.recordPath));delete legacy.disclosureDigest;writeFileSync(s.recordPath,JSON.stringify(legacy));assert.equal(s.mayShare(),false);assert.ok(s.ask());
 s.answer('yes');const pending=openSharing({state,env:{},buildPacket:()=>new Promise(r=>resolveBuild=r),send:async p=>{sent.push(p);return {ok:true};}});const run=pending.contribute();pending.answer('off');resolveBuild(buildReusableSkillPacket({installationId,methodIds:['file-review']}));assert.equal((await run).sent,false);assert.equal(sent.length,1);
});
test('network sink independently refuses arbitrary data even with caller configured server',async t=>{
 const state=fresh(t);let calls=0;const transport=fleetTransport({state,env:{KINGMAKER_FLEET_URL:'https://unused.invalid',KINGMAKER_FLEET_KEY:'-----BEGIN PUBLIC KEY-----'},fetchImpl:async()=>{calls++;throw Error('not expected');}});
 assert.equal((await transport.send({installationId,prompt:'private prompt',password:'do not send'})).ok,false);assert.equal(calls,0);
});
