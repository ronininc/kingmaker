// Public protocol verifier only. Paid implementation and identity keys remain in Armor.
import { createPublicKey, generateKeyPairSync, diffieHellman, encapsulate, hkdfSync, createHash, createHmac, randomBytes, verify, timingSafeEqual } from 'node:crypto';
const verifiedProofs=new WeakSet();
export const isVerifiedArmorProviderProof = proof => verifiedProofs.has(proof);
const AUDIENCE = 'kingmaker.dock/1';
const DOMAIN = 'scripture-armor.dock-proof/1';
const TYPES = {x25519:'x25519',ed25519:'ed25519',mlkem768:'ml-kem-768',mldsa65:'ml-dsa-65'};
const ALGORITHMS = {ecdh:'X25519',kem:'ML-KEM-768',signature:'Ed25519',pqSignature:'ML-DSA-65'};
const sha = b => createHash('sha256').update(b).digest('hex');
function decode(s,max=8192) {
  if(typeof s!=='string'||!s.length||s.length>max||!/^[A-Za-z0-9+/]+={0,2}$/.test(s))throw Error('ARMOR_DOCK_ENCODING_INVALID');
  const b=Buffer.from(s,'base64');if(b.toString('base64')!==s)throw Error('ARMOR_DOCK_ENCODING_INVALID');return b;
}
export function validateArmorPublicIdentity(identity) {
  if(!identity||Object.keys(identity).length!==4)throw Error('ARMOR_DOCK_PIN_REQUIRED');
  const keys={};
  for(const [name,type] of Object.entries(TYPES)) {
    const bytes=decode(identity[name],12000),key=createPublicKey({key:bytes,format:'der',type:'spki'});
    if(key.asymmetricKeyType!==type||!key.export({format:'der',type:'spki'}).equals(bytes))throw Error('ARMOR_DOCK_KEY_TYPE_INVALID');
    keys[name]=key;
  }
  return keys;
}
export function createArmorDockChallenge({publicIdentity,now=Date.now}={}) {
  const identity=structuredClone(publicIdentity),keys=validateArmorPublicIdentity(identity);
  const issued=now();if(!Number.isSafeInteger(issued))throw Error('ARMOR_DOCK_CLOCK_INVALID');
  const ephemeral=generateKeyPairSync('x25519');
  const ecdh=diffieHellman({privateKey:ephemeral.privateKey,publicKey:keys.x25519});
  const kem=encapsulate(keys.mlkem768);
  const request={cmd:'dock-proof',audience:AUDIENCE,challenge:randomBytes(32).toString('hex'),ephemeralX25519:ephemeral.publicKey.export({type:'spki',format:'der'}).toString('base64'),kemCiphertext:kem.ciphertext.toString('base64')};
  const transcript=JSON.stringify({schema:'scripture-armor.dock-challenge/1',audience:request.audience,challenge:request.challenge,ephemeralX25519:request.ephemeralX25519,kemCiphertext:request.kemCiphertext});
  const challengeHash=sha(transcript),ikm=Buffer.concat([ecdh,kem.sharedKey]);
  const proofKey=Buffer.from(hkdfSync('sha256',ikm,Buffer.from(challengeHash,'hex'),Buffer.from('scripture-armor.dock-possession/1'),32));
  const expected=createHmac('sha256',proofKey).update(transcript).digest();
  ecdh.fill(0);kem.sharedKey.fill(0);ikm.fill(0);proofKey.fill(0);
  let consumed=false;
  return {request:Object.freeze(request),verify(response){
    if(consumed)throw Error('ARMOR_DOCK_CHALLENGE_CONSUMED');
    consumed=true;
    try {
      const d=response?.doc,t=now();
      if(response?.ok!==true||!d||d.schema!==DOMAIN||d.audience!==AUDIENCE||d.challenge!==request.challenge
        ||d.challengeHash!==challengeHash||!Number.isSafeInteger(d.issuedAt)||!Number.isSafeInteger(d.expiresAt)
        ||d.issuedAt<issued-5000||d.issuedAt>t+5000||d.expiresAt<=t||d.expiresAt>d.issuedAt+60000||t-issued>60000
        ||JSON.stringify(d.algorithms)!==JSON.stringify(ALGORITHMS)||JSON.stringify(d.publicIdentity)!==JSON.stringify(identity)
        ||!/^[0-9a-f]{64}$/.test(d.possessionCommitment||''))throw Error('ARMOR_DOCK_PROOF_INVALID');
      if(Object.keys(d).join(',')!=='schema,audience,challenge,issuedAt,expiresAt,algorithms,publicIdentity,challengeHash,possessionCommitment')throw Error('ARMOR_DOCK_PROOF_INVALID');
      const bytes=Buffer.from(DOMAIN+'\n'+JSON.stringify(d));
      if(!verify(null,bytes,keys.ed25519,decode(response.signatures?.ed25519))
        ||!verify(null,bytes,keys.mldsa65,decode(response.signatures?.mldsa65,10000))
        ||!timingSafeEqual(expected,Buffer.from(d.possessionCommitment,'hex')))throw Error('ARMOR_DOCK_PROOF_INVALID');
      const result=Object.freeze({schema:'kingmaker.armor-provider-proof/1',providerFingerprint:sha(JSON.stringify(identity)),audience:AUDIENCE,challenge:d.challenge,issuedAt:d.issuedAt,expiresAt:d.expiresAt,pqcPossessionVerified:true});
      verifiedProofs.add(result);return result;
    } finally {expected.fill(0);}
  },cancel(){consumed=true;expected.fill(0);}};
}

// Live transport uses only the standalone daemon's documented owner channel.
// It never imports paid source, opens an identity store, or migrates keys.
export async function requestStandaloneArmorProof({publicIdentity,home,now=Date.now,timeoutMs=3000}={}) {
  const fs=await import('node:fs/promises'),net=await import('node:net'),path=await import('node:path'),os=await import('node:os');
  const owner=path.join(home||os.homedir(),'.scripture-armor','owner');
  if(!path.isAbsolute(owner))throw Error('ARMOR_DOCK_HOME_INVALID');
  const dir=await fs.lstat(owner);
  if(!dir.isDirectory()||dir.isSymbolicLink()||(dir.mode&0o077)!==0||dir.uid!==process.getuid())throw Error('ARMOR_DOCK_OWNER_DIRECTORY_UNSAFE');
  const tokenPath=path.join(owner,'vaultd.sock.owner.token'),meta=await fs.lstat(tokenPath);
  if(!meta.isFile()||meta.isSymbolicLink()||meta.nlink!==1||meta.size>49||(meta.mode&0o077)!==0||meta.uid!==process.getuid())throw Error('ARMOR_DOCK_TOKEN_UNSAFE');
  const f=await fs.open(tokenPath,'r');let token;
  try {const after=await f.stat();if(after.ino!==meta.ino||after.dev!==meta.dev)throw Error('ARMOR_DOCK_TOKEN_CHANGED');const b=Buffer.alloc(50);const {bytesRead}=await f.read(b,0,50,0);token=b.subarray(0,bytesRead).toString('utf8').trim();b.fill(0);if(bytesRead>49||!/^[0-9a-f]{48}$/.test(token))throw Error('ARMOR_DOCK_TOKEN_INVALID');}finally{await f.close();}
  const socket=path.join(owner,'vaultd.sock.owner'),sm=await fs.lstat(socket);
  if(!sm.isSocket()||sm.isSymbolicLink()||sm.uid!==process.getuid()||(sm.mode&0o077)!==0)throw Error('ARMOR_DOCK_SOCKET_UNSAFE');
  const challenge=createArmorDockChallenge({publicIdentity,now});
  try {
    const response=await new Promise((resolve,reject)=>{
      const conn=net.createConnection(socket);let buffers=[],size=0,done=false;
      const finish=(error,value)=>{if(done)return;done=true;conn.destroy();error?reject(error):resolve(value);};
      conn.setTimeout(Math.max(1,Math.min(timeoutMs,10000)),()=>finish(Error('ARMOR_DOCK_TIMEOUT')));
      conn.on('error',()=>finish(Error('ARMOR_DOCK_UNAVAILABLE')));
      conn.on('connect',()=>{conn.write(JSON.stringify({...challenge.request,owner_token:token})+'\n');token=null;});
      conn.on('data',chunk=>{size+=chunk.length;if(size>32768)return finish(Error('ARMOR_DOCK_RESPONSE_TOO_LARGE'));buffers.push(chunk);if(chunk.includes(10)){try{const text=Buffer.concat(buffers).toString('utf8');const line=text.slice(0,text.indexOf('\n'));finish(null,JSON.parse(line));}catch{finish(Error('ARMOR_DOCK_RESPONSE_INVALID'));}}});
      conn.on('end',()=>finish(Error('ARMOR_DOCK_RESPONSE_INCOMPLETE')));
    });
    return challenge.verify(response);
  } finally {token=null;challenge.cancel();}
}
