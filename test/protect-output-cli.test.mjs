import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {cmdProtectOutput} from '../lib/protect-output-cli.mjs';
test('explicit output command has help, rejects unsafe config and never activates implicit output routing',async t=>{
 assert.equal(await cmdProtectOutput(['--help']),0);
 await assert.rejects(cmdProtectOutput([]),/ARGUMENTS/);await assert.rejects(cmdProtectOutput(['--host','https://bad.test']),/ARGUMENTS/);
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'protection-cli-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const enrollment=path.join(dir,'update.json'),config=path.join(dir,'config.json');
 await fs.writeFile(enrollment,JSON.stringify({url:'https://evil.test',key:'fixture'}),{mode:0o600});await fs.writeFile(config,'{}',{mode:0o600});
 const args=['--input',path.join(dir,'in'),'--output',path.join(dir,'out'),'--language','js','--config',config,'--enrollment',enrollment];
 await assert.rejects(cmdProtectOutput(args),/ENROLLMENT_INVALID/);
 await fs.chmod(enrollment,0o644);await assert.rejects(cmdProtectOutput(args),/FILE_UNSAFE/);
 await fs.chmod(enrollment,0o600);await fs.rename(enrollment,enrollment+'.real');await fs.symlink(enrollment+'.real',enrollment);await assert.rejects(cmdProtectOutput(args));
 assert.deepEqual((await fs.readdir(dir)).sort(),['config.json','update.json','update.json.real']);
});

test('fresh grant transport uses fixed origin and explicit basis without transmitting plaintext or creating consent',async()=>{
 const {createOutputCapabilityTransport}=await import('../lib/protect-output-cli.mjs');
 const {generateKeyPairSync}=await import('node:crypto');
 const publicIdentity=Object.fromEntries(Object.entries({x25519:'x25519',ed25519:'ed25519',mlkem768:'ml-kem-768',mldsa65:'ml-dsa-65'}).map(([k,t])=>[k,generateKeyPairSync(t).publicKey.export({format:'der',type:'spki'}).toString('base64')]));
 const saved=globalThis.fetch,seen=[];let consent=null;
 globalThis.fetch=async(url,options)=>{seen.push({url:String(url),options,body:JSON.parse(options.body)});return new Response('{}',{status:403});};
 try{
 const cfg={installCertificate:{payload:'signed-cert-fixture'},publicIdentity,bearer:'fixture',basis:'paid'};
 const t=createOutputCapabilityTransport(cfg);
 await assert.rejects(t.readGrant(),/AUTHORITY_UNAVAILABLE/);await assert.rejects(t.readGrant(),/AUTHORITY_UNAVAILABLE/);
 assert.equal(seen.length,2);for(const s of seen){assert.equal(s.url,'https://kingmaker-updates.robbiebrown2026.workers.dev/capability-grant');assert.equal(s.options.redirect,'error');assert.deepEqual(Object.keys(s.body),['installCertificate','providerFingerprint','basis']);assert.equal(s.body.basis,'paid');assert.match(s.body.providerFingerprint,/^[a-f0-9]{64}$/);assert.equal(s.body.plaintext,undefined);}
 const f=createOutputCapabilityTransport({...cfg,basis:'fleet',readFleetConsent:()=>consent});
 await assert.rejects(f.readGrant(),/CONSENT_REQUIRED/);assert.equal(seen.length,2);
 consent={id:'explicit',version:1,acceptedAt:Date.now(),optedIn:true};await assert.rejects(f.readGrant(),/AUTHORITY_UNAVAILABLE/);assert.equal(seen.at(-1).body.basis,'fleet');
 consent.withdrawn=true;await assert.rejects(f.readGrant(),/CONSENT_REQUIRED/);assert.equal(seen.length,3);
 await assert.rejects(t.checkGrantStatus({grant:{payload:'signed-grant'},challenge:{nonce:'fresh'}}),/AUTHORITY_UNAVAILABLE/);assert.equal(seen.at(-1).url,'https://kingmaker-updates.robbiebrown2026.workers.dev/capability-status');assert.deepEqual(Object.keys(seen.at(-1).body),['installCertificate','grant','challenge']);
 assert.throws(()=>createOutputCapabilityTransport({...cfg,basis:'free'}),/BASIS_REQUIRED/);
 }finally{globalThis.fetch=saved;}
});
