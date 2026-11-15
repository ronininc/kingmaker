import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash} from 'node:crypto';import {recordWeightVerification,findWeightVerification} from '../lib/verified-weight-registry.mjs';
const h=x=>createHash('sha256').update(x).digest('hex');
test('persistent scoped weight evidence reuses exact runtime only and detects tampering',async()=>{
 const root=await mkdtemp(join(tmpdir(),'weight-log-'));try{
 const checkpointPath=join(root,'weights'),configPath=join(root,'config'),evidencePath=join(root,'receipt');await writeFile(checkpointPath,'weights');await writeFile(configPath,'{}');await writeFile(evidencePath,'{"status":"fixture"}');
 const details={checkpointSha256:h('weights'),configSha256:h('{}'),runtimeId:'cpu-fixture',runtimeVersion:'1',architecture:'fixture',sourceHashes:[h('source')],scope:'forward-fixture'};
 const directory=join(root,'log');await recordWeightVerification({directory,checkpointPath,configPath,evidencePath,evidenceSha256:h('{"status":"fixture"}'),...details});
 const found=await findWeightVerification({directory,...details});assert.equal(found.reusableEvidence,true);assert.equal(found.admissionGranted,false);assert.equal(await findWeightVerification({directory,...details,runtimeVersion:'2'}),null);
 await writeFile(checkpointPath,'changed');assert.equal(await findWeightVerification({directory,...details}),null);
 }finally{await rm(root,{recursive:true,force:true});}
});
