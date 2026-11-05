import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
export function createExternalEvidenceJournal({path}={}){
  if(!path||path===':memory:')throw new Error('EXTERNAL_EVIDENCE_PRIVATE_PATH_REQUIRED');
  const dir=dirname(path),safe=(p,t)=>{const s=lstatSync(p);if(s.isSymbolicLink()||(t==='dir'?!s.isDirectory():!s.isFile())||typeof process.getuid==='function'&&s.uid!==process.getuid()||(s.mode&0o077)!==0)throw new Error('EXTERNAL_EVIDENCE_UNSAFE_PATH')};
  mkdirSync(dir,{recursive:true,mode:0o700});safe(dir,'dir');if(existsSync(path))safe(path,'file');const old=process.umask(0o077);let db;
  try{db=new DatabaseSync(path);db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS outbound(attempt_id TEXT PRIMARY KEY,digest TEXT NOT NULL,prepared_json TEXT NOT NULL,evidence_json TEXT NOT NULL,status TEXT NOT NULL);")}finally{process.umask(old)}
  const secure=()=>{for(const f of[path,`${path}-wal`,`${path}-shm`])if(existsSync(f)){chmodSync(f,0o600);safe(f,'file')}};secure();
  return{
    get(id){const r=db.prepare('SELECT * FROM outbound WHERE attempt_id=?').get(id);if(!r)return null;const s=JSON.parse(r.prepared_json);return{digest:r.digest,prepared:s.prepared,authorization:s.authorization,evidence:JSON.parse(r.evidence_json),status:r.status}},
    stage(id,prepared,evidence,authorization){const encoded=JSON.stringify({prepared,authorization}),ev=JSON.stringify(evidence),prior=this.get(id);if(prior){if(prior.digest!==prepared.expectedDigest||JSON.stringify({prepared:prior.prepared,authorization:prior.authorization})!==encoded)throw new Error('EXTERNAL_EVIDENCE_JOURNAL_CONFLICT');return prior}db.prepare("INSERT INTO outbound VALUES(?,?,?,?,'pending')").run(id,prepared.expectedDigest,encoded,ev);secure();return this.get(id)},
    complete(id,digest){const r=this.get(id);if(!r||r.digest!==digest)throw new Error('EXTERNAL_EVIDENCE_JOURNAL_CONFLICT');db.prepare("UPDATE outbound SET status='completed' WHERE attempt_id=?").run(id);secure();return this.get(id)},
    close(){db.close();secure()},
  };
}
