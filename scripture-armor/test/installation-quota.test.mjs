import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installationMetadata } from '../installation-metadata.mjs';
import { createArmorAccountSession } from '../account-session.mjs';
import { createArmorDashboard } from '../dashboard.mjs';
const EMAIL='quota@example.test',COOKIE='ronin_armor='+'d'.repeat(64),NOW=Math.floor(Date.now()/1000),dirs=[];
const temp=()=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'armor-install-quota-'));dirs.push(d);return d;};
test.after(()=>{for(const d of dirs)fs.rmSync(d,{recursive:true,force:true});});
const json=(data,status=200,headers={})=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json',...headers}});
function transport(reserve){const seen=[];return{seen,fetch:async(url,options)=>{
 seen.push({url,options,body:options.body?JSON.parse(options.body):null});assert.equal(new URL(url).origin,'https://www.ronininc.org');assert.equal(options.redirect,'manual');
 if(url.endsWith('/login'))return json({ok:true,emailCodeRequired:true,email:EMAIL,purpose:'login',challengeId:'synthetic-challenge',expiresAt:NOW+300},202);
 if(url.endsWith('/verify'))return json({ok:true,mfaVerified:true,member:{email:EMAIL}},200,{'set-cookie':COOKIE+';HttpOnly;Secure;SameSite=Strict;Path=/'});
 if(url.endsWith('/me'))return json({ok:true,mfaVerified:true,member:{email:EMAIL,mfa_verified_at:NOW}});
 if(url.endsWith('/reserve')){assert.equal(options.headers.cookie,COOKIE);const result=await reserve(url,options);if(!result.ok)return result;return json({installationId:JSON.parse(options.body).installationId,...await result.json()},result.status);}
 throw new Error('Unexpected test transport route');
}};}
const signIn=async account=>{await account.login({email:EMAIL,password:'synthetic-password'});await account.verify({code:'12345678'});};
test('per-installation ID persists outside identity, is 256-bit random metadata and rejects aliases',()=>{
 const root=temp(),identity=path.join(root,'vault'),first=installationMetadata(identity),again=installationMetadata(identity);
 assert.deepEqual(first,again);assert.match(first.installationId,/^[a-f0-9]{64}$/);assert.match(first.installationEvidenceRef,/^local-metadata-sha256:[a-f0-9]{64}$/);assert.equal(fs.existsSync(identity),false);
 const dir=identity+'.installation',file=path.join(dir,'installation.json');assert.equal(fs.statSync(dir).mode&0o777,0o700);assert.equal(fs.statSync(file).mode&0o777,0o600);
 const alias=path.join(root,'alias');fs.symlinkSync(dir,alias+'.installation');assert.throws(()=>installationMetadata(alias),/directory/);
});
test('private MFA cookie reserves only the fixed billing endpoint; no body credential or admission flag accepted',async()=>{
 for(const status of [200,201]){
  const f=transport(()=>json({reserved:true,quotaReservationOnly:true,deviceAdmissionGranted:false},status)),metadata=installationMetadata(path.join(temp(),'vault')),account=createArmorAccountSession({fetchImpl:f.fetch,installationProvider:()=>metadata});await signIn(account);
  assert.deepEqual(await account.reserveInstallation({...metadata,authCookie:'ignored',deviceAdmissionGranted:true}),{reserved:true,quotaReservationOnly:true,deviceAdmissionGranted:false});
  const call=f.seen.at(-1);assert.equal(call.url,'https://www.ronininc.org/api/armor/license/installations/reserve');assert.deepEqual(call.body,metadata);assert.equal(call.options.headers.origin,'https://www.ronininc.org');
 }
 const f=transport(()=>json({reserved:true,quotaReservationOnly:true,deviceAdmissionGranted:true})),account=createArmorAccountSession({fetchImpl:f.fetch,installationProvider:()=>installationMetadata(path.join(temp(),'vault'))});await signIn(account);await assert.rejects(account.reserveInstallation(installationMetadata(path.join(temp(),'vault'))),/capacity/);
});
test('quota errors and unresponsive reservation transport remain bounded and do not grant capacity',async()=>{
 const metadata=installationMetadata(path.join(temp(),'vault'));
 for(const reserve of [()=>json({error:'untrusted body'},409),()=>new Promise(()=>{})]){
  const f=transport(reserve),account=createArmorAccountSession({fetchImpl:f.fetch,timeoutMs:25,installationProvider:()=>metadata});await signIn(account);await assert.rejects(account.reserveInstallation(metadata),error=>/limit reached|timed out/.test(error.message));
 }
});
test('quota409 stops dashboard activation before identity, terms, migration or paid-marker effects',async()=>{
 const root=temp(),identityDir=path.join(root,'vault'),f=transport(()=>json({error:'limit'},409));
 const server=createArmorDashboard({identityDir,fetchImpl:f.fetch});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 try{
  const html=await(await fetch(origin)).text(),token=JSON.parse(/const TOKEN=("[^"]+")/.exec(html)[1]);
  const post=(route,body)=>fetch(origin+route,{method:'POST',headers:{origin,'content-type':'application/json','x-scripture-armor-token':token},body:JSON.stringify(body)});
  assert.equal((await post('/api/account/login',{email:EMAIL,password:'synthetic-password'})).status,200);assert.equal((await post('/api/account/verify',{code:'12345678'})).status,200);
  const response=await post('/api/activate',{acceptTerms:true,confirmMigration:true,installationId:'f'.repeat(64),installationEvidenceRef:'not trusted'});assert.equal(response.status,409);assert.equal(fs.existsSync(identityDir),false);
  const reservation=f.seen.find(c=>c.url.endsWith('/reserve'));assert.deepEqual(reservation.body,installationMetadata(identityDir));assert.notEqual(reservation.body.installationId,'f'.repeat(64));
  assert.equal(fs.existsSync(path.join(identityDir,'paid-activation.json')),false);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
test('each protected operation rechecks the trusted installation and rejects revocation before any file work',async()=>{
 const root=temp(),identityDir=path.join(root,'vault'),metadata=installationMetadata(identityDir);let checks=0,entitlements=0;
 const f=transport(()=>json({reserved:true,quotaReservationOnly:true,deviceAdmissionGranted:false}));
 const transportFetch=async(url,options)=>{
  if(url.endsWith('/check')){checks++;assert.equal(options.headers.cookie,COOKIE);assert.deepEqual(JSON.parse(options.body),metadata);return json({error:'revoked'},403);}
  if(url.endsWith('/entitlement')){entitlements++;throw new Error('Must never reach generic entitlement after revoked installation');}
  return f.fetch(url,options);
 };
 const server=createArmorDashboard({identityDir,fetchImpl:transportFetch});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 try{
  const html=await(await fetch(origin)).text(),token=JSON.parse(/const TOKEN=("[^"]+")/.exec(html)[1]);
  const post=(route,body)=>fetch(origin+route,{method:'POST',headers:{origin,'content-type':'application/json','x-scripture-armor-token':token},body:JSON.stringify(body)});
  for(const route of ['/api/scan','/api/clean']){
   await post('/api/account/login',{email:EMAIL,password:'synthetic-password'});await post('/api/account/verify',{code:'12345678'});
   const result=await post(route,{path:path.join(root,'does-not-exist'),confirm:'QUARANTINE',installationId:'f'.repeat(64),authCookie:'fake'});assert.equal(result.status,401);
  }
  assert.equal(checks,2);assert.equal(entitlements,0);assert.equal(fs.existsSync(identityDir),false);assert.deepEqual(installationMetadata(identityDir),metadata);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
test('missing trusted installation provider cannot be replaced by caller metadata',async()=>{
 const f=transport(()=>{throw new Error('must not reserve');}),account=createArmorAccountSession({fetchImpl:f.fetch});await signIn(account);
 await assert.rejects(account.reserveInstallation(installationMetadata(path.join(temp(),'vault'))),/Trusted local installation/);
});
