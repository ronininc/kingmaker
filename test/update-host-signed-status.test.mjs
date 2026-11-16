import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { createInstallCertificateStatusProvider, createInstallCertificateStatusProviderForFixture, INSTALL_STATUS_ORIGIN } from '../lib/launcher-crm-identity-client.mjs';
const source = readFileSync(new URL('../update-host/worker.js', import.meta.url));
const worker = (await import('data:text/javascript;base64,' + source.toString('base64'))).default;
const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const pem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
const pub = keys.publicKey.export({ type: 'spki', format: 'pem' });
const bearer = 'synthetic-device-bearer';
const keySha = createHash('sha256').update(bearer).digest('hex');
const claims = { schema:'ronin.install-cert/1', issuer:'ronin-update-host', installId:'12345678-1234-1234-1234-123456789012', deviceSha256:'a'.repeat(64), bundleId:'com.ronininc.solghost', releaseTag:'v4.5.3', keySha, issuedAt:new Date(Date.now()-1000).toISOString() };
const certificate = (overrides={}) => { const payload=JSON.stringify({...claims,...overrides}); return {payload,sig:sign('sha256',Buffer.from(payload),keys.privateKey).toString('base64'),alg:'ES256'}; };
const environment = ({revoked=false,tag='v4.5.3',record=true}={}) => ({ CERT_SIGNING_KEY:pem, DEVICES:{async get(k){return k===`key:${keySha}`&&record?{device:claims.deviceSha256,revoked}:null;}}, RELEASES:{async get(){return{async json(){return {tag};}};}} });
const request=(body,token=bearer) => new Request(`${INSTALL_STATUS_ORIGIN}/install-cert-status`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)});
const body=()=>({nonce:'n'.repeat(32),installCertificate:certificate()});
async function status(env=environment(),b=body(),token=bearer){return worker.fetch(request(b,token),env);}
test('actual host signs bound fresh status; actual client verifies roundtrip',async()=>{
 process.env.NODE_ENV='test';process.env.KINGMAKER_DOUBLE_FIXTURE_GATE='1';
 let seen;
 const provider=createInstallCertificateStatusProviderForFixture({baseUrl:INSTALL_STATUS_ORIGIN,bearer,fetchImpl:async(url,opts)=>{seen={url:String(url),opts};return worker.fetch(new Request(url,opts),environment());}},pub);
 const actual=await provider({installCertificate:certificate(),...claims});
 assert.deepEqual(actual,{current:true,revoked:false,installId:claims.installId,keySha,releaseTag:claims.releaseTag});
 assert.equal(seen.url,`${INSTALL_STATUS_ORIGIN}/install-cert-status`);assert.equal(seen.opts.method,'POST');assert.equal(seen.opts.redirect,'error');
 const r=await status();assert.equal(r.headers.get('cache-control'),'no-store');const e=await r.json();assert(verify('sha256',Buffer.from(e.payload),pub,Buffer.from(e.sig,'base64')));const c=JSON.parse(e.payload);assert.equal(c.expiresAt-c.issuedAt,60);assert.equal(c.nonce,'n'.repeat(32));
});
test('revoked or superseded enrollment never reports current',async()=>{
 for(const opts of [{revoked:true},{tag:'v4.5.4'}]){const r=await status(environment(opts));assert.equal(r.status,200);const c=JSON.parse((await r.json()).payload);assert.equal(c.current,false);assert.equal(c.revoked,opts.revoked||false);}
});
test('forged certificate, wrong bearer/device, unknown record refused',async()=>{
 const tampered=body();tampered.installCertificate.payload+=' ';
 for(const [b,token,env] of [[tampered,bearer,environment()],[body(),'other',environment()],[{...body(),installCertificate:certificate({deviceSha256:'b'.repeat(64)})},bearer,environment()],[body(),bearer,environment({record:false})]])assert.equal((await status(env,b,token)).status,401);
});
test('missing signer/latest and oversized or invalid request fail closed',async()=>{
 const env=environment();delete env.CERT_SIGNING_KEY;assert.equal((await status(env)).status,503);
 assert.equal((await status(environment({tag:'unknown'}))).status,503);
 assert.equal((await status(environment(),{...body(),nonce:'bad'})).status,400);
 assert.equal((await status(environment(),{...body(),extra:'x'.repeat(33000)})).status,413);
});
test('production provider allows only committed destination and no injected transport or trust',()=>{
 assert.equal(typeof createInstallCertificateStatusProvider({bearer}), 'function');
 for(const config of [{bearer,baseUrl:'https://evil.test'},{bearer,fetchImpl:()=>{}},{bearer,now:()=>0}])assert.throws(()=>createInstallCertificateStatusProvider(config),/TRUST_OVERRIDE_FORBIDDEN/);
 assert.throws(()=>createInstallCertificateStatusProvider(),/CONFIG_INVALID/);
});
