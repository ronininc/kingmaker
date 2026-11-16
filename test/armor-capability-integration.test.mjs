import assert from 'node:assert/strict';import test from 'node:test';
import {generateKeyPairSync,sign,createHash,diffieHellman,decapsulate,hkdfSync,createHmac,createPublicKey} from 'node:crypto';
import {createArmorDockChallenge} from '../lib/armor-dock-provider.mjs';
import {createUnifiedCapabilityAccess} from '../lib/unified-capability-access.mjs';
const keys=Object.fromEntries(Object.entries({x25519:'x25519',ed25519:'ed25519',mlkem768:'ml-kem-768',mldsa65:'ml-dsa-65'}).map(([n,t])=>[n,generateKeyPairSync(t)]));
const identity=Object.fromEntries(Object.entries(keys).map(([n,k])=>[n,k.publicKey.export({format:'der',type:'spki'}).toString('base64')]));
const clock=1800000000000,hash=s=>createHash('sha256').update(s).digest('hex');
function response(r){
 const transcript=JSON.stringify({schema:'scripture-armor.dock-challenge/1',audience:r.audience,challenge:r.challenge,ephemeralX25519:r.ephemeralX25519,kemCiphertext:r.kemCiphertext});
 const dh=diffieHellman({privateKey:keys.x25519.privateKey,publicKey:createPublicKey({key:Buffer.from(r.ephemeralX25519,'base64'),format:'der',type:'spki'})});
 const kem=decapsulate(keys.mlkem768.privateKey,Buffer.from(r.kemCiphertext,'base64'));
 const doc={schema:'scripture-armor.dock-proof/1',audience:r.audience,challenge:r.challenge,issuedAt:clock,expiresAt:clock+60000,algorithms:{ecdh:'X25519',kem:'ML-KEM-768',signature:'Ed25519',pqSignature:'ML-DSA-65'},publicIdentity:identity,challengeHash:hash(transcript),possessionCommitment:createHmac('sha256',Buffer.from(hkdfSync('sha256',Buffer.concat([dh,kem]),Buffer.from(hash(transcript),'hex'),Buffer.from('scripture-armor.dock-possession/1'),32))).update(transcript).digest('hex')};
 const bytes=Buffer.from('scripture-armor.dock-proof/1\n'+JSON.stringify(doc));
 return {ok:true,doc,signatures:{ed25519:sign(null,bytes,keys.ed25519.privateKey).toString('base64'),mldsa65:sign(null,bytes,keys.mldsa65.privateKey).toString('base64')}};
}
const authority=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const envelope=c=>{const payload=JSON.stringify(c);return {alg:'ES256',payload,sig:sign('sha256',Buffer.from(payload),authority.privateKey).toString('base64')};};
function fixture(basis='paid'){
 let consent={id:'consent-fixture',version:1,optedIn:true,acceptedAt:clock-1};
 const installation={installId:'fixture-install',deviceSha256:'a'.repeat(64)};
 const api=createUnifiedCapabilityAccess({installation,publicIdentity:identity,now:()=>clock,readFleetConsent:()=>consent,certKeyPem:authority.publicKey.export({type:'spki',format:'pem'})});
 const claims={schema:'ronin.capability-grant/1',issuer:'ronin-update-host',product:'kingmaker',grantId:'fixture-grant',...installation,providerFingerprint:hash(JSON.stringify(identity)),basis,capabilities:['ronin.skill-base','scripture-armor.pqc'],issuedAt:clock-1,expiresAt:clock+600000,...(basis==='fleet'?{consent:{id:'consent-fixture',version:1}}:{})};
 const grant=envelope(claims);
 const status=(patch={})=>{const c=api.begin(grant);return envelope({schema:'ronin.capability-status/1',issuer:'ronin-update-host',grantId:claims.grantId,...installation,nonce:c.nonce,grantDigest:c.grantDigest,current:true,revoked:false,issuedAt:clock,expiresAt:clock+60000,...patch});};
 return {api,grant,status,withdraw:()=>consent={...consent,optedIn:false}};
}
test('hybrid possession, dual signature, pins and one-shot challenge verified',()=>{
 const c=createArmorDockChallenge({publicIdentity:identity,now:()=>clock});const r=response(c.request);assert.equal(c.verify(r).pqcPossessionVerified,true);assert.throws(()=>c.verify(r),/CONSUMED/);
 for(const mutate of [r=>r.doc.challenge='b'.repeat(64),r=>r.signatures.mldsa65=r.signatures.ed25519,r=>r.doc.expiresAt=clock,r=>r.doc.possessionCommitment='a'.repeat(64)]){
 const x=createArmorDockChallenge({publicIdentity:identity,now:()=>clock});const bad=response(x.request);mutate(bad);assert.throws(()=>x.verify(bad));}
});
test('same Armor capability requires signed paid or explicitly opted-in fleet grant plus real PQ proof',async()=>{
 for(const basis of ['paid','fleet']){
 const f=fixture(basis),c=createArmorDockChallenge({publicIdentity:identity,now:()=>clock}),proof=c.verify(response(c.request));
 assert.equal((await f.api.authorize({capability:'scripture-armor.pqc',grant:f.grant,status:f.status(),providerProof:proof})).basis,basis);
 assert.equal(f.api.baseAccess().basis,'free');
 await assert.rejects(f.api.authorize({capability:'scripture-armor.pqc',grant:f.grant,status:f.status(),providerProof:{...proof}}),/VERIFIED_PQC/);
 if(basis==='fleet'){f.withdraw();await assert.rejects(f.api.authorize({capability:'ronin.skill-base',grant:f.grant,status:f.status()}),/CONSENT/);}
 }
});
test('unsigned, expired/revoked and replayed grants cannot unlock features',async()=>{
 const f=fixture(),s=f.status();await f.api.authorize({capability:'ronin.skill-base',grant:f.grant,status:s});
 await assert.rejects(f.api.authorize({capability:'ronin.skill-base',grant:f.grant,status:s}),/REPLAY/);
 await assert.rejects(f.api.authorize({capability:'ronin.skill-base',grant:f.grant,status:f.status({revoked:true})}),/STATUS_INVALID/);
 await assert.rejects(f.api.authorize({capability:'ronin.skill-base',grant:f.grant,status:f.status({expiresAt:clock})}),/STATUS_INVALID/);
 await assert.rejects(f.api.authorize({capability:'ronin.skill-base',grant:{...f.grant,payload:f.grant.payload+' '},status:f.status()}),/SIGNATURE/);
});

test('production owner socket adapter verifies real hybrid proof without identity-file access',async t=>{
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path'),net=await import('node:net');
 const {requestStandaloneArmorProof}=await import('../lib/armor-dock-provider.mjs');
 const home=await fs.mkdtemp('/tmp/adc-');t.after(()=>fs.rm(home,{recursive:true,force:true}));
 const owner=path.join(home,'.scripture-armor','owner');await fs.mkdir(owner,{recursive:true,mode:0o700});await fs.chmod(owner,0o700);
 await fs.writeFile(path.join(owner,'vaultd.sock.owner.token'),'a'.repeat(48)+'\n',{mode:0o600});
 const socket=path.join(owner,'vaultd.sock.owner');let seen;
 const server=net.createServer(conn=>{let text='';conn.on('data',b=>{text+=b;if(text.includes('\n')){seen=JSON.parse(text);conn.end(JSON.stringify(response(seen))+'\n');}});});
 await new Promise(r=>server.listen(socket,r));await fs.chmod(socket,0o600);t.after(()=>new Promise(r=>server.close(r)));
 const proof=await requestStandaloneArmorProof({publicIdentity:identity,home,now:()=>clock});
 assert.equal(proof.pqcPossessionVerified,true);assert.equal(seen.owner_token,'a'.repeat(48));
 assert.equal((await fs.readdir(path.join(home,'.scripture-armor'))).join(','),'owner');
 await fs.chmod(path.join(owner,'vaultd.sock.owner.token'),0o644);
 await assert.rejects(requestStandaloneArmorProof({publicIdentity:identity,home,now:()=>clock}),/TOKEN_UNSAFE/);
});
