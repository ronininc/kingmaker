import test from 'node:test';
import assert from 'node:assert/strict';
import { createArmorAccountSession } from '../account-session.mjs';
import { createAccountSessionStore } from '../account-session-store.mjs';
import { createInstallationHealthReporter } from '../installation-health.mjs';
const NOW=1800000000, EMAIL='fixture@example.invalid', COOKIE='ronin_armor='+'a'.repeat(64), ID='b'.repeat(64), EXPIRES=NOW+30*86400;
const json=(data,status=200,headers={})=>Response.json(data,{status,headers});
function fixture(){
 let saved=null,denied=false,expires=EXPIRES,billingStatus=200,capacityStatus=200;const calls=[];
 const store={load:()=>saved,save:value=>{saved=structuredClone(value)},clear:()=>{saved=null}};
 const fetchImpl=async(url,options)=>{
  calls.push({url,options});const action=new URL(url).pathname.split('/').pop();
  if(denied)return json({ok:false},401);
  if(action==='login')return json({ok:true,emailCodeRequired:true,email:EMAIL,purpose:'login',challengeId:'fixture',expiresAt:NOW+300},202);
  if(action==='verify')return json({ok:true,mfaVerified:true,sessionExpiresAt:expires,member:{email:EMAIL}},200,{'set-cookie':COOKIE+'; HttpOnly; Secure; Max-Age=2592000'});
  if(action==='me')return json({ok:true,mfaVerified:true,sessionExpiresAt:expires,member:{email:EMAIL,mfa_verified_at:NOW-100000}});
  if(action==='health')return json({ok:true,receivedAt:NOW,installationId:ID,telemetryOnly:true,deviceAdmissionGranted:false});
  if(action==='check')return json({ok:true,active:true,installationId:ID,quotaReservationOnly:true,deviceAdmissionGranted:false},capacityStatus);
  if(action==='entitlement')return json({ok:false},billingStatus);
  if(action==='logout')return json({ok:true});throw Error('unexpected');
 };
 const create=()=>createArmorAccountSession({sessionStore:store,fetchImpl,installationProvider:()=>({installationId:ID,installationEvidenceRef:'local-metadata-sha256:'+ID}),now:()=>NOW});
 return{store,calls,create,saved:()=>saved,deny:()=>{denied=true},expiry:value=>{expires=value},billing:status=>{billingStatus=status},capacity:status=>{capacityStatus=status}};
}
const signin=async a=>{await a.login({email:EMAIL,password:'  Synthetic密碼  '});return a.verify({code:'12345678'})};
test('membership or capacity failure locks licensed actions without deleting a verified saved login',async()=>{
 for(const kind of ['billing','capacity'])for(const status of [403,503]){
  const f=fixture(),a=f.create();await signin(a);const saved=structuredClone(f.saved());f[kind](status);
  await assert.rejects(a.verifyEntitlement());assert.equal(a.state().authenticated,true);assert.deepEqual(f.saved(),saved);
  f.deny();await assert.rejects(a.verifyEntitlement());assert.equal(a.state().authenticated,false);assert.equal(f.saved(),null,'actual authentication revocation still clears the session');
 }
});
test('OTP session resumes after process recreation only after authoritative me, persists no password or OTP',async()=>{
 const f=fixture(),a=f.create();await signin(a);assert.equal(f.saved().expiresAt,EXPIRES);assert.equal(JSON.stringify(f.saved()).includes('Synthetic'),false);assert.equal(JSON.stringify(f.saved()).includes('12345678'),false);
 const b=f.create();assert.equal(b.state().authenticated,false);assert.equal((await b.resume()).authenticated,true);assert.equal(f.calls.at(-1).options.headers.cookie,COOKIE);assert.equal(f.calls.at(-1).url,'https://www.ronininc.org/api/armor/auth/me');assert.equal(JSON.stringify(b.state()).includes(COOKIE),false);
 await b.logout();assert.equal(f.saved(),null);assert.equal(b.state().authenticated,false);
});
test('server rejection, invalid authoritative expiry and expired stored session clear private persistence',async()=>{
 const f=fixture();await signin(f.create());f.deny();const resumed=f.create();await assert.rejects(resumed.resume());assert.equal(f.saved(),null);assert.equal(resumed.state().authenticated,false);
 const g=fixture();g.expiry(NOW);await assert.rejects(signin(g.create()));assert.equal(g.saved(),null);
 const h=fixture();h.store.save({schema:'ronin.customer-session/v1',cookie:COOKIE,email:EMAIL,expiresAt:NOW-1});assert.equal((await h.create().resume()).authenticated,false);assert.equal(h.calls.length,0);assert.equal(h.saved(),null);
});
test('health requires explicit consent, exact local installation and fixed-origin telemetry-only acknowledgement',async()=>{
 const f=fixture(),a=f.create();await signin(a);const sample={product:'launcher',platform:'macos',version:'0.3.14',state:'degraded'};
 await assert.rejects(a.reportHealth(sample),/consent/);await assert.rejects(a.reportHealth({...sample,consent:true,state:undefined}),/observed/);
 const result=await a.reportHealth({...sample,consent:true});assert.equal(result.deviceAdmissionGranted,false);const c=f.calls.at(-1);assert.equal(c.url,'https://www.ronininc.org/api/armor/account/installations/health');assert.deepEqual(JSON.parse(c.options.body),{installationId:ID,...sample});assert.equal(c.options.headers.cookie,COOKIE);assert.equal(c.options.redirect,'manual');
});
test('macOS store keeps secret off argv and never uses a plaintext or unsupported-platform fallback',()=>{
 const calls=[];let encoded='';const run=(args,input)=>{calls.push({args,input});if(args[0]==='-i'){encoded=input.match(/-w ([A-Za-z0-9+/=]+)/)[1];return{status:0,stdout:''}}if(args[0]==='find-generic-password')return{status:encoded?0:44,stdout:encoded};encoded='';return{status:0,stdout:''}};
 assert.equal(createAccountSessionStore({platform:'linux',run}),null);assert.equal(calls.length,0);
 const s=createAccountSessionStore({platform:'darwin',run}),record={schema:'ronin.customer-session/v1',cookie:COOKIE,email:EMAIL,expiresAt:EXPIRES};s.save(record);assert.deepEqual(s.load(),record);assert.equal(JSON.stringify(calls.map(c=>c.args)).includes(COOKIE),false);assert.deepEqual(calls[0].args,['-i']);s.clear();assert.equal(s.load(),null);
 assert.throws(()=>s.save({...record,password:'not-allowed'}),/Invalid/);
 const locked=createAccountSessionStore({platform:'darwin',run:()=>({status:1,stdout:''})});assert.throws(()=>locked.load(),/unavailable/);assert.throws(()=>locked.save(record),/unavailable/);
});
test('periodic reporting neither invents healthy usage nor duplicates in-flight reports; consent withdrawal stops sends',async()=>{
 let consent=false,sample={observedAt:NOW,state:'healthy',product:'kingmaker',platform:'linux',version:'4.4.3'},sent=0,release;const reporter=createInstallationHealthReporter({account:{reportHealth:async()=>{sent++;await new Promise(r=>{release=r});return{ok:true}}},sample:async()=>sample,hasConsent:()=>consent,now:()=>NOW});
 assert.equal((await reporter.tick()).reason,'consent_required');consent=true;sample={...sample,observedAt:NOW-121};assert.equal((await reporter.tick()).reason,'fresh_observation_required');sample={...sample,observedAt:NOW};const pending=reporter.tick();await new Promise(r=>setImmediate(r));assert.equal((await reporter.tick()).reason,'inactive_or_busy');assert.equal(sent,1);release();assert.equal((await pending).sent,true);consent=false;assert.equal((await reporter.tick()).sent,false);reporter.stop();assert.equal((await reporter.tick()).sent,false);
});
test('health response mismatches and server401 never become a successful activity report',async()=>{
 for(const bad of [{installationId:'c'.repeat(64)},{deviceAdmissionGranted:true},{telemetryOnly:false},{receivedAt:NOW-301}]){
  const f=fixture(),base=f.create();await signin(base);const saved=f.saved();const a=createArmorAccountSession({sessionStore:f.store,installationProvider:()=>({installationId:ID}),now:()=>NOW,fetchImpl:async(url,options)=>url.endsWith('/health')?json({ok:true,receivedAt:NOW,installationId:ID,telemetryOnly:true,deviceAdmissionGranted:false,...bad}):json({ok:true,mfaVerified:true,sessionExpiresAt:saved.expiresAt,member:{email:EMAIL,mfa_verified_at:NOW}})});
  await a.resume();await assert.rejects(a.reportHealth({consent:true,product:'launcher',platform:'macos',version:'0.3.14',state:'healthy'}),/receipt/);
 }
 const f=fixture(),a=f.create();await signin(a);f.deny();await assert.rejects(a.reportHealth({consent:true,product:'launcher',platform:'macos',version:'0.3.14',state:'healthy'}));assert.equal(a.state().authenticated,false);assert.equal(f.saved(),null);
});
test('corrupt scoped Keychain payload is removed, not accepted as a login',()=>{
 let deleted=false;const s=createAccountSessionStore({platform:'darwin',run:args=>args[0]==='find-generic-password'?{status:0,stdout:Buffer.from(JSON.stringify({schema:'ronin.customer-session/v1',cookie:COOKIE,email:EMAIL,expiresAt:EXPIRES,password:'unsafe'})).toString('base64')}:(deleted=true,{status:0,stdout:''})});assert.equal(s.load(),null);assert.equal(deleted,true);
});
