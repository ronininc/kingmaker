import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {checkForUpdate,applyUpdate} from '../lib/update.mjs';
import {generateReleaseKeypair,signManifestBytes} from '../lib/release-signing.mjs';
import {manifest,receipt,sha} from './fixtures/update-provenance.mjs';
const keys=generateReleaseKeypair();const engine='#!/bin/bash\necho ok\n';
function setup(){const dataDir=mkdtempSync(join(tmpdir(),'km-update-revision-'));const appRoot=join(dataDir,'Kingmaker.app');receipt(dataDir,appRoot,manifest(),keys.privateKeyPem);return{verifyInstalledImpl:()=>true,dataDir,appRoot,current:'0.3.0',publicKeyPem:keys.publicKeyPem};}
function host(m,{signature,engineBytes=engine,pointer=m}={}){const b=JSON.stringify(m);return async url=>{const path=new URL(url).pathname;const body=path==='/latest.json'?JSON.stringify({version:pointer.version,tag:pointer.tag}):path.endsWith('kingmaker-manifest.json.sig')?(signature??signManifestBytes(Buffer.from(b),keys.privateKeyPem)):path.endsWith('kingmaker-manifest.json')?b:path.endsWith('engine.sh')?engineBytes:'engine-signature';return{ok:true,json:async()=>JSON.parse(body),text:async()=>body,arrayBuffer:async()=>Buffer.from(body)};};}
const config={url:'https://fixture.invalid',key:'test-only'};
for(const [name,m,expected] of [
 ['new authenticated same-version revision',manifest('0.3.0','2026-10-18T02:00:00Z','new'),'signed-revision'],
 ['identical no-op',manifest(),'identical'],
 ['same-version rollback',manifest('0.3.0','2026-10-17T02:00:00Z','oldest'),'rollback'],
 ['semver rollback',manifest('0.2.9'),'rollback'],
 ['semver upgrade',manifest('0.3.1'),'version-upgrade'],
 ['ambiguous ordering',manifest('0.3.0','2026-10-18T01:00:00.000Z','different'),'unordered-revision'],
 ['missing ordering',manifest('0.3.0','bad','different'),'unordered-revision']]){
 test(name,async()=>{const r=await checkForUpdate(config,{...setup(),fetchImpl:host(m)});assert.equal(r.reason,expected);assert.equal(r.available,['signed-revision','version-upgrade'].includes(expected));});
}
test('unknown or locally changed build is not overwritten, including semver upgrade',async()=>{
 const o=setup();writeFileSync(join(o.appRoot,'Contents/MacOS/Kingmaker'),'local patch');
 for(const m of [manifest('0.3.0','2026-10-18T02:00:00Z','new'),manifest('0.3.1')])assert.equal((await checkForUpdate(config,{...o,fetchImpl:host(m)})).reason,'unknown-provenance');
});
test('invalid signature and unsigned pointer substitution fail',async()=>{
 const o=setup();await assert.rejects(checkForUpdate(config,{...o,fetchImpl:host(manifest(),{signature:'invalid'})}),/signature/);
 await assert.rejects(checkForUpdate(config,{...o,fetchImpl:host(manifest(),{pointer:manifest('0.3.1')})}),/pointer/);
});
test('apply rechecks authenticated identity, bytes, and local provenance without advancing receipt',async()=>{
 const o=setup(),m=manifest('0.3.0','2026-10-18T02:00:00Z','new'),fetchImpl=host(m);
 const offer=await checkForUpdate(config,{...o,fetchImpl});const before=readFileSync(join(o.dataDir,'installed-release.json'),'utf8');let starts=0;
 const args={...o,home:o.dataDir,wakeWord:'Nova',pin:null,fetchImpl,spawnImpl:()=>{starts++;return{unref(){}}}};
 await assert.rejects(applyUpdate(config,offer,{...args,fetchImpl:host(m,{engineBytes:'corrupt'})}),/does not match/);
 await assert.rejects(applyUpdate(config,offer,{...args,fetchImpl:host({...m,createdAt:'2026-10-18T03:00:00Z'})}),/changed after checking/);
 await assert.rejects(applyUpdate(config,offer,{...args,spawnImpl:()=>{throw Error('spawn failed')}}),/spawn failed/);
 assert.equal(readFileSync(join(o.dataDir,'installed-release.json'),'utf8'),before);
 await applyUpdate(config,offer,args);assert.equal(starts,1);assert.equal(readFileSync(join(o.dataDir,'installed-release.json'),'utf8'),before,'starting is not installation');
 writeFileSync(join(o.appRoot,'Contents/MacOS/Kingmaker'),'local patch');await assert.rejects(applyUpdate(config,offer,args),/unknown-provenance/);
});

test('payload edit without updating its manifest also invalidates local provenance',async()=>{
 const o=setup();writeFileSync(join(o.appRoot,'Contents/Resources/sol-ghost/sample.mjs'),'edit');
 assert.equal((await checkForUpdate(config,{...o,fetchImpl:host(manifest('0.3.1'))})).reason,'unknown-provenance');
});
test('invalid installed seal is unknown even when receipt and payload match',async()=>{assert.equal((await checkForUpdate(config,{...setup(),verifyInstalledImpl:()=>false,fetchImpl:host(manifest('0.3.1'))})).reason,'unknown-provenance');});
test('local rebuild during engine download aborts before spawn',async()=>{
 const o=setup(),m=manifest('0.3.0','2026-10-18T02:00:00Z','new'),f=host(m),offer=await checkForUpdate(config,{...o,fetchImpl:f});let started=false;
 await assert.rejects(applyUpdate(config,offer,{...o,home:o.dataDir,wakeWord:'Nova',pin:null,fetchImpl:async(...args)=>{const r=await f(...args);if(args[0].endsWith('/engine.sh'))writeFileSync(join(o.appRoot,'Contents/MacOS/Kingmaker'),'rebuilt during download');return r;},spawnImpl:()=>{started=true;return{unref(){}}}}),/changed during download/);assert.equal(started,false);
});
