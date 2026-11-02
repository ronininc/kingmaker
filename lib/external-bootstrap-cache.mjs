import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function createExternalBootstrapCache({path,key}={}){
  if(!path||path===':memory:'||!Buffer.isBuffer(key)||key.length!==32)throw new Error('EXTERNAL_BOOTSTRAP_CACHE_CONFIG');
  const dir=dirname(path),safe=(p,t)=>{const s=lstatSync(p);if(s.isSymbolicLink()||(t==='dir'?!s.isDirectory():!s.isFile())||typeof process.getuid==='function'&&s.uid!==process.getuid()||(s.mode&0o077)!==0)throw new Error('EXTERNAL_BOOTSTRAP_CACHE_UNSAFE_PATH')};
  mkdirSync(dir,{recursive:true,mode:0o700});safe(dir,'dir');if(existsSync(path))safe(path,'file');const old=process.umask(0o077);let db;
  try{db=new DatabaseSync(path);db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS bootstrap(attempt_id TEXT PRIMARY KEY,cipher BLOB NOT NULL,nonce BLOB NOT NULL,tag BLOB NOT NULL);')}finally{process.umask(old)}
  const secure=()=>{for(const f of[path,`${path}-wal`,`${path}-shm`])if(existsSync(f)){chmodSync(f,0o600);safe(f,'file')}};secure();
  return{
    put(attemptId,value){const prior=this.get(attemptId);if(prior){if(JSON.stringify(prior)!==JSON.stringify(value))throw new Error('EXTERNAL_BOOTSTRAP_CACHE_CONFLICT');return prior}const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(Buffer.from(attemptId));const bytes=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]),tag=cipher.getAuthTag();db.prepare('INSERT INTO bootstrap VALUES(?,?,?,?)').run(attemptId,bytes,nonce,tag);secure();return structuredClone(value)},
    get(attemptId){const r=db.prepare('SELECT * FROM bootstrap WHERE attempt_id=?').get(attemptId);if(!r)return null;try{const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(r.nonce));decipher.setAAD(Buffer.from(attemptId));decipher.setAuthTag(Buffer.from(r.tag));return JSON.parse(Buffer.concat([decipher.update(Buffer.from(r.cipher)),decipher.final()]).toString('utf8'))}catch{throw new Error('EXTERNAL_BOOTSTRAP_CACHE_AUTH') }},
    close(){db.close();secure()},
  };
}
