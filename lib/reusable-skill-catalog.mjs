// Shared immutable reviewed content boundary; no filesystem, network or execution.
import {METHOD_LICENSE_TEXT,METHOD_NOTICE} from './method-component-license.mjs';
import {createHash} from 'node:crypto';
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const METHODS=Object.freeze({
 'file-review':Object.freeze({name:'file-review',description:'Review a selected file and verify the summary against it.',instructions:'Ask the owner to select a file. Read only that file locally. Draft a summary. Verify each claim against the file before returning it. Do not embed file content in this reusable method.',steps:['select-local-input','read-local-input','draft-local-summary','verify-local-summary']}),
 'output-verification':Object.freeze({name:'output-verification',description:'Verify generated output before reporting success.',instructions:'Identify the requested output contract. Run the applicable local checks. Compare the result with that contract. Report success only if the checks pass; otherwise return a bounded failure without secrets.',steps:['identify-output-contract','run-local-checks','compare-local-result','report-verified-status']}),
});
export const METHOD_IDS=Object.freeze(Object.keys(METHODS));
export function materializeReviewedMethod(methodId){
 if(!Object.hasOwn(METHODS,methodId))throw Error('SKILL_RIGHTS_NOT_VERIFIED');
 const spec=structuredClone(METHODS[methodId]);
 return {...spec,methodId,license:'Apache-2.0',licenseText:METHOD_LICENSE_TEXT,notice:METHOD_NOTICE,authorship:'Kingmaker release-reviewed original generic method',projectOutputsLicense:'owner-controlled; not relicensed',methodHash:digest(spec)};
}
export function validateReusableSkillPacket(packet){
 try{
 if(!packet||Object.keys(packet).sort().join(',')!=='installationId,methods,packetId,schema'||packet.schema!=='kingmaker.fleet-skills/1'||!/^fp_[a-f0-9]{32}$/.test(packet.packetId)||!/^fi_[a-f0-9]{32}$/.test(packet.installationId)||!Array.isArray(packet.methods)||!packet.methods.length||packet.methods.length>16)return {ok:false};
 const seen=new Set();for(const method of packet.methods){if(seen.has(method.methodId)||JSON.stringify(method)!==JSON.stringify(materializeReviewedMethod(method.methodId)))return {ok:false};seen.add(method.methodId);}
 return {ok:true};
 }catch{return {ok:false};}
}

