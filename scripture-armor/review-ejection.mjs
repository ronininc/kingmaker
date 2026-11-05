// Exact-object removal after native owner confirmation. Never a disk sweep or a cleanup command from content.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {externalFile,sameExternalFile,readExternalFile} from './vault-paths.mjs';
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
export function reviewSource(input,{identityDir}={}) {
  const target=externalFile(input,{identityDir});
  const systemRoots=['/System','/Library','/bin','/sbin','/usr','/private/etc'];
  const protectedRoots=['.ssh','.codex','.aws','.kingmaker'].map(p=>path.join(os.homedir(),p));
  if(protectedRoots.some(root=>target.path===root||target.path.startsWith(root+path.sep))||/^(identity\.json|\.env(?:\..*)?)$|\.(pem|p12|key)$/i.test(path.basename(target.path)))throw Error('Protected credentials and system paths are not accepted for automatic review/ejection.');
  const st=fs.lstatSync(target.path);
  if(!target.size||target.size>16*1024*1024)throw Error('Choose one regular file up to 16 MiB.');
  const ejectable=st.uid===process.getuid?.()&&!systemRoots.some(root=>target.path===root||target.path.startsWith(root+path.sep));
  const bytes=readExternalFile(target,{identityDir});return {target,bytes,sha256:digest(bytes),ejectable};
}
export function createOriginalEjection({identityDir}={}) {
  const tickets=new Map();
  return {
    clear(){tickets.clear();},
    register(source,review) {
      for(const [id,ticket]of tickets)if(ticket.until<Date.now())tickets.delete(id);
      if(source.ejectable!==true||review.contentSha256!==source.sha256||review.format==='Sensitive key material'||!['ejected','review-needed'].includes(review.disposition)||!['critical','high'].includes(review.risk?.level))return null;
      if(tickets.size>=32)tickets.delete(tickets.keys().next().value);
      const id=crypto.randomUUID();tickets.set(id,{target:source.target,sha256:source.sha256,until:Date.now()+5*60000,risk:review.risk});return id;
    },
    eject(id) {
      const ticket=tickets.get(id);tickets.delete(id);
      if(!ticket||ticket.until<Date.now())throw Error('Removal receipt expired or already used. Review the file again.');
      const options={identityDir};sameExternalFile(ticket.target,options);
      let bytes=readExternalFile(ticket.target,options);
      try{if(digest(bytes)!==ticket.sha256)throw Error('File content changed; original was not removed.');}finally{bytes.fill(0);}
      const holding=fs.mkdtempSync(path.join(path.dirname(ticket.target.path),'.armor-ejection-'));fs.chmodSync(holding,0o700);
      const staged=path.join(holding,'source');let moved=false,removed=false;
      try {
        sameExternalFile(ticket.target,options);fs.renameSync(ticket.target.path,staged);moved=true;
        const state={...ticket.target,path:staged};sameExternalFile(state,options);bytes=readExternalFile(state,options);
        try{if(digest(bytes)!==ticket.sha256)throw Error('Staged source changed; removal stopped.');}finally{bytes.fill(0);}
        sameExternalFile(state,options);fs.unlinkSync(staged);removed=true;
        return {originalFileRemoved:true,reviewedSha256:ticket.sha256,risk:ticket.risk,
          announcement:`Original file removed after native confirmation. Danger rating: ${ticket.risk.level.toUpperCase()}. ${ticket.risk.reasons.join(' ')} The complete review workspace was destroyed; the next review uses a fresh sandbox. Unknown copies, backups and prior activity were not assessed. This does not guarantee forensic erasure on SSD storage.`};
      } catch {
        if(moved&&!removed){
          try{fs.linkSync(staged,ticket.target.path);fs.unlinkSync(staged);moved=false;}catch{throw Error('Removal stopped. The file was retained in its sibling .armor-ejection- staging folder; inspect it before continuing.');}
        }
        throw Error('Removal failed; the original file was preserved. No administrator privilege was requested.');
      } finally {try{fs.rmdirSync(holding);}catch{}}
    },
  };
}
