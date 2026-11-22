import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createArmorDashboard,analyzeDashboardFile} from '../dashboard.mjs';
import {renderArmorDashboard} from '../dashboard-view.mjs';
import {scanSourceText} from '../scan.mjs';
import {stageStandaloneSources} from '../build-standalone.mjs';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
const ROOT=path.resolve(new URL('..',import.meta.url).pathname);
test('analysis uses a private non-vault project directory and removes it on success or failure',async()=>{
 for(const fail of [false,true]){
  let work;
  const operation=analyzeDashboardFile('/synthetic/fixture',async(target,options)=>{
   work=options.storeDir;assert.equal(target,'/synthetic/fixture');
   assert(!work.split(path.sep).some(part=>part.startsWith('.')));
   assert.equal(fs.statSync(work).mode&0o777,0o700);
   fs.writeFileSync(path.join(work,'transient'),'fixture');
   if(fail)throw Error('synthetic engine failure');return {record:{verdict:'pass'}};
  });
  if(fail)await assert.rejects(operation,/synthetic engine failure/);else assert.equal((await operation).record.verdict,'pass');
  assert.equal(fs.existsSync(work),false);
 }
});
test('library dashboard cannot read or clear the production Keychain store by default',async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'armor-inert-store-')),original=childProcess.spawnSync,calls=[];
 childProcess.spawnSync=(command,...args)=>{if(command==='/usr/bin/security'){calls.push(args);throw Error('Fixture must not access Keychain');}return original(command,...args);};syncBuiltinESMExports();
 const server=createArmorDashboard({identityDir:path.join(temp,'identity')});
 try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
  const html=await(await fetch(origin)).text(),token=JSON.parse(/const TOKEN=("[^"]+")/.exec(html)[1]);
  const response=await fetch(origin+'/api/status',{headers:{'x-scripture-armor-token':token}});assert.equal(response.status,200);
  assert.equal((await response.json()).account.authenticated,false);assert.equal(calls.length,0);
 }finally{childProcess.spawnSync=original;syncBuiltinESMExports();await new Promise(resolve=>server.close(resolve));fs.rmSync(temp,{recursive:true,force:true});}
});
test('server/browser capability boundary is explicit, packaged and removes the cross-context composite',()=>{
 const server=fs.readFileSync(path.join(ROOT,'dashboard.mjs'),'utf8'),view=fs.readFileSync(path.join(ROOT,'dashboard-view.mjs'),'utf8');
 assert.doesNotMatch(server,/\bfetch\s*\(/);assert.doesNotMatch(view,/from ['"]node:|readFileSync|readdirSync|createArmorAccountSession|verifyEntitlement/);
 const html=renderArmorDashboard({token:'synthetic-token',logo:'',termsText:'<terms>',checkout:{download:'https://www.ronininc.org/armor/checkout?purpose=download',discordMembership:'https://www.ronininc.org/armor/checkout?purpose=discord-membership'}});
 assert.match(html,/mode:'same-origin',credentials:'omit',redirect:'error'/);assert.match(html,/API_PATHS\.has\(url\)/);assert.match(html,/&lt;terms&gt;/);
 for(const [name,source] of [['dashboard.mjs',server],['dashboard-view.mjs',view]]) {
  const r=scanSourceText(source,name,crypto.createHash('sha256').update(source).digest('hex'));assert(!r.findings.some(f=>f.rule==='behavior-covert-exfiltration'));assert(!r.findings.some(f=>['critical','high'].includes(f.severity)));
 }
 const npm=JSON.parse(fs.readFileSync(path.join(ROOT,'package.json'),'utf8'));assert(npm.files.includes('dashboard-view.mjs'));
 const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'armor-dashboard-package-'));
 try {
  const packaged=path.join(fixture,'armor');stageStandaloneSources(packaged);
  assert.equal(fs.readFileSync(path.join(packaged,'dashboard-view.mjs'),'utf8'),fs.readFileSync(path.join(ROOT,'dashboard-view.mjs'),'utf8'));
  assert.match(fs.readFileSync(path.join(packaged,'dashboard.mjs'),'utf8'),/from ['"]\.\/dashboard-view\.mjs['"]/);
 } finally { fs.rmSync(fixture,{recursive:true,force:true}); }
});
test('real local scan and clean denial preserve clean bytes; fixed-origin account transport receives no file content',async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'armor-boundary-')),identityDir=path.join(temp,'vault'),target=path.join(temp,'safe.txt'),content='SYNTHETIC-FILE-CONTENT-ONLY';fs.writeFileSync(target,content);
 const now=Math.floor(Date.now()/1000),cookie=`ronin_armor=${'d'.repeat(64)}`,remote=[];let installation;
 const json=(d,status=200,headers={})=>new Response(JSON.stringify(d),{status,headers:{'content-type':'application/json',...headers}});
 const server=createArmorDashboard({identityDir,fetchImpl:async(url,options)=>{
  assert.equal(new URL(url).origin,'https://www.ronininc.org');assert.equal(options.redirect,'manual');const action=new URL(url).pathname.split('/').pop(),body=options.body?JSON.parse(options.body):null;remote.push({action,body});
  if(action==='login')return json({ok:true,emailCodeRequired:true,email:'fixture@example.test',purpose:'login',challengeId:'fixture',expiresAt:now+300},202);
  if(action==='verify')return json({ok:true,mfaVerified:true,member:{email:'fixture@example.test',paid:true}},200,{'set-cookie':cookie+';HttpOnly;Secure;Path=/;SameSite=Strict'});
  if(action==='me')return json({ok:true,mfaVerified:true,member:{email:'fixture@example.test',paid:true,mfa_verified_at:now}});
  if(action==='reserve'){installation=body;return json({installationId:body.installationId,reserved:true,quotaReservationOnly:true,deviceAdmissionGranted:false});}
  if(action==='check'){assert.deepEqual(body,installation);return json({ok:true,installationId:body.installationId,active:true,quotaReservationOnly:true,deviceAdmissionGranted:false});}
  if(action==='entitlement'){assert.deepEqual(body,{});return json({schema:'ronin.armor-entitlement/v1',product:'scripture-armor',entitled:true,verifiedAt:now,term:{startsAt:now-10,endsAt:now+3600},discordAccess:'separate_verified_admission_required'});}
  throw Error('unexpected remote action');
 }});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 try{
  const html=await(await fetch(origin)).text(),token=JSON.parse(/const TOKEN=("[^"]+")/.exec(html)[1]);
  const post=(route,body,extra={})=>fetch(origin+route,{method:'POST',headers:{origin,'content-type':'application/json','x-scripture-armor-token':token,...extra},body:JSON.stringify(body)});
  assert.equal((await post('/api/account/login',{}, {host:'attacker.invalid'})).status,403);assert.equal(remote.length,0);
  assert.equal((await post('/api/account/login',{email:'fixture@example.test',password:'synthetic-password'})).status,200);
  assert.equal((await post('/api/account/verify',{code:'12345678'})).status,200);
  const activated=await post('/api/activate',{acceptTerms:true,confirmMigration:true});assert.equal(activated.status,200,await activated.text());
  const scanned=await post('/api/scan',{path:target});assert.equal(scanned.status,200,await scanned.text());
  const denied=await post('/api/clean',{path:target,confirm:'QUARANTINE'});assert.equal(denied.status,409,await denied.text());
  assert.equal(fs.readFileSync(target,'utf8'),content);assert.equal(fs.existsSync(path.join(identityDir,'quarantine')),false);
  assert(!JSON.stringify(remote).includes(content));assert(remote.filter(r=>r.action==='check').length>=2);
 }finally{await new Promise(resolve=>server.close(resolve));fs.rmSync(temp,{recursive:true,force:true});}
});
