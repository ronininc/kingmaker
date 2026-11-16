// Release-reviewed original generic methods, not customer projects or imported
// source. No arbitrary prose/code is proven safe by this catalog or a regex.
import {readFileSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const METHODS=Object.freeze({
 'file-review':Object.freeze({name:'file-review',description:'Review a selected file and verify the summary against it.',instructions:'Ask the owner to select a file. Read only that file locally. Draft a summary. Verify each claim against the file before returning it. Do not embed file content in this reusable method.',steps:['select-local-input','read-local-input','draft-local-summary','verify-local-summary']}),
 'output-verification':Object.freeze({name:'output-verification',description:'Verify generated output before reporting success.',instructions:'Identify the requested output contract. Run the applicable local checks. Compare the result with that contract. Report success only if the checks pass; otherwise return a bounded failure without secrets.',steps:['identify-output-contract','run-local-checks','compare-local-result','report-verified-status']}),
});
export function reviewSkillMint(spec){
 let text;try{text=JSON.stringify(spec);}catch{return {ok:false,flags:['unreviewable_input']};}
 const flags=[];
 if(/-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|ghp|github_pat|AKIA)[-_A-Za-z0-9]{12,}|(?:password|passwd|api[_ -]?key|secret|access[_ -]?token)\s*[:=]\s*\S+/i.test(text))flags.push('credential_or_secret');
 if(/\b(?:confidential|proprietary|customer|client data|internal only)\b|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/i.test(text))flags.push('private_or_customer_data');
 // Rights labels supplied with arbitrary bytes are assertions, not evidence.
 if(!spec||Object.keys(spec).some(k=>k!=='methodId')||!Object.hasOwn(METHODS,spec.methodId))flags.push('unknown_content_or_rights');
 return flags.length?{ok:false,flags:[...new Set(flags)],error:'Skill not minted. Remove credentials and private/project/source data; unknown content or rights require independent review. No input values are included in these flags.'}:{ok:true,methodId:spec.methodId};
}
export function materializeReviewedMethod(methodId){
 if(!Object.hasOwn(METHODS,methodId))throw Error('SKILL_RIGHTS_NOT_VERIFIED');
 const spec=structuredClone(METHODS[methodId]);
 return {...spec,methodId,license:'Apache-2.0',authorship:'Kingmaker release-reviewed original generic method',projectOutputsLicense:'owner-controlled; not relicensed',methodHash:digest(spec)};
}
export function buildReusableSkillPacket({methodIds=[],installationId}){
 if(!/^fi_[a-f0-9]{32}$/.test(installationId||''))throw Error('FLEET_INSTALL_ID_INVALID');
 const ids=[...new Set(methodIds)].sort();if(ids.length>16)throw Error('FLEET_SKILL_LIMIT');
 const methods=ids.map(materializeReviewedMethod);if(!methods.length)return null;
 return {schema:'kingmaker.fleet-skills/1',packetId:'fp_'+randomBytes(16).toString('hex'),installationId,methods};
}
export function validateReusableSkillPacket(packet){
 try{
 if(!packet||Object.keys(packet).sort().join(',')!=='installationId,methods,packetId,schema'||packet.schema!=='kingmaker.fleet-skills/1'||!/^fp_[a-f0-9]{32}$/.test(packet.packetId)||!/^fi_[a-f0-9]{32}$/.test(packet.installationId)||!Array.isArray(packet.methods)||!packet.methods.length||packet.methods.length>16)return {ok:false};
 const seen=new Set();for(const method of packet.methods){if(seen.has(method.methodId)||JSON.stringify(method)!==JSON.stringify(materializeReviewedMethod(method.methodId)))return {ok:false};seen.add(method.methodId);}
 return {ok:true};
 }catch{return {ok:false};}
}

// Only fixed reviewed catalog IDs are read; no user skill prose/source is copied.
export function buildMintedReusableSkillPacket({state,installationId}){
 const methodIds=[];
 for(const methodId of Object.keys(METHODS)){
  try{const file=join(state,'skills',methodId,'REUSABLE-METHOD.json'),meta=lstatSync(file);if(!meta.isFile()||meta.isSymbolicLink()||meta.size>2048)continue;
   const marker=JSON.parse(readFileSync(file,'utf8')),m=materializeReviewedMethod(methodId);
   const expected={methodId:m.methodId,methodHash:m.methodHash,license:m.license,authorship:m.authorship,projectOutputsLicense:m.projectOutputsLicense};
   if(JSON.stringify(marker)===JSON.stringify(expected))methodIds.push(methodId);
  }catch{}
 }
 return buildReusableSkillPacket({methodIds,installationId});
}
