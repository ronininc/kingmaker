// Release-reviewed original generic methods, not customer projects or imported
// source. No arbitrary prose/code is proven safe by this catalog or a regex.
import {readFileSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {METHOD_IDS,materializeReviewedMethod,validateReusableSkillPacket} from './reusable-skill-catalog.mjs';
export {materializeReviewedMethod,validateReusableSkillPacket} from './reusable-skill-catalog.mjs';
export function reviewSkillMint(spec){
 let text;try{text=JSON.stringify(spec);}catch{return {ok:false,flags:['unreviewable_input']};}
 const flags=[];
 if(/-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|ghp|github_pat|AKIA)[-_A-Za-z0-9]{12,}|(?:password|passwd|api[_ -]?key|secret|access[_ -]?token)\s*[:=]\s*\S+/i.test(text))flags.push('credential_or_secret');
 if(/\b(?:confidential|proprietary|customer|client data|internal only)\b|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/i.test(text))flags.push('private_or_customer_data');
 // Rights labels supplied with arbitrary bytes are assertions, not evidence.
 if(!spec||Object.keys(spec).some(k=>k!=='methodId')||!METHOD_IDS.includes(spec.methodId))flags.push('unknown_content_or_rights');
 return flags.length?{ok:false,flags:[...new Set(flags)],error:'Skill not minted. Remove credentials and private/project/source data; unknown content or rights require independent review. No input values are included in these flags.'}:{ok:true,methodId:spec.methodId};
}
export function buildReusableSkillPacket({methodIds=[],installationId}){
 if(!/^fi_[a-f0-9]{32}$/.test(installationId||''))throw Error('FLEET_INSTALL_ID_INVALID');
 const ids=[...new Set(methodIds)].sort();if(ids.length>16)throw Error('FLEET_SKILL_LIMIT');
 const methods=ids.map(materializeReviewedMethod);if(!methods.length)return null;
 return {schema:'kingmaker.fleet-skills/1',packetId:'fp_'+randomBytes(16).toString('hex'),installationId,methods};
}
// Only fixed reviewed catalog IDs are read; no user skill prose/source is copied.
export function buildMintedReusableSkillPacket({state,installationId}){
 const methodIds=[];
 for(const methodId of METHOD_IDS){
  try{const file=join(state,'skills',methodId,'REUSABLE-METHOD.json'),meta=lstatSync(file);if(!meta.isFile()||meta.isSymbolicLink()||meta.size>2048)continue;
   const marker=JSON.parse(readFileSync(file,'utf8')),m=materializeReviewedMethod(methodId);
   const expected={methodId:m.methodId,methodHash:m.methodHash,license:m.license,authorship:m.authorship,projectOutputsLicense:m.projectOutputsLicense};
   if(JSON.stringify(marker)===JSON.stringify(expected))methodIds.push(methodId);
  }catch{}
 }
 return buildReusableSkillPacket({methodIds,installationId});
}
