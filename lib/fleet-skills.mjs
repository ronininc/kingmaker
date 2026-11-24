// Verified, declarative Fleet skill adoption. Packages contain workflow data and
// safe fixtures only: no executable files are accepted and Add never runs a skill.
import {createHash,createPublicKey,verify} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {canonicalJson} from '../vendor/fleet/fleet-packet.mjs';
import {addConnector,listConnectors,removeConnector} from './connectors.mjs';

export const FLEET_SKILLS_SCHEMA='kingmaker.fleet-skills/1';
export const SKILL_PACKAGE_SCHEMA='kingmaker.skill-package/1';
export const CATALOG_DOMAIN='kingmaker.fleet-skills.catalog.v1';
export const PACKAGE_DOMAIN='kingmaker.fleet-skills.package.v1';
export const SUPPORTED_PERMISSIONS=new Set(['read:provided-inputs','write:artifacts','network:none']);
const ID=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION=/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const skillRoot=state=>join(state,'fleet-skills');
const installedFile=state=>join(skillRoot(state),'installed.json');

function signatureValid(domain,value,signature,publicKeyPem){try{const key=createPublicKey(publicKeyPem);return key.asymmetricKeyType==='ed25519'&&verify(null,Buffer.from(`${domain}:${canonicalJson(value)}`),key,Buffer.from(signature,'base64'));}catch{return false;}}
function safeString(value,max){return typeof value==='string'&&value.length>0&&value.length<=max;}
export function packageProblems(pkg){
 const p=[];
 if(pkg?.schema!==SKILL_PACKAGE_SCHEMA)p.push('unsupported package schema');
 if(!ID.test(pkg?.id||''))p.push('invalid skill id');if(!VERSION.test(pkg?.version||''))p.push('invalid version');
 if(!safeString(pkg?.publisher,120))p.push('publisher missing');if(!safeString(pkg?.description,500))p.push('description missing');
 if(!Array.isArray(pkg?.permissions)||pkg.permissions.some(x=>!SUPPORTED_PERMISSIONS.has(x)))p.push('unsupported permissions');
 if(!Array.isArray(pkg?.dependencies)||pkg.dependencies.some(d=>!d||!ID.test(d.id||'')||typeof d.required!=='boolean'||Object.keys(d).some(key=>!['id','required'].includes(key))))p.push('unsupported dependencies');
 if(!Array.isArray(pkg?.workflow)||!pkg.workflow.length||pkg.workflow.length>100)p.push('workflow must contain 1-100 declarative steps');
 else if(pkg.workflow.some(step=>!step||typeof step!=='object'||!['instruction','tool','verify'].includes(step.type)||!safeString(step.text,2000)||Object.keys(step).some(key=>!['type','text','tool'].includes(key))))p.push('workflow contains an unsupported step');
 if(pkg.workflow?.some(step=>step.type==='tool'&&!ID.test(step.tool||'')))p.push('invalid tool dependency');
 if(!Array.isArray(pkg?.fixtures)||pkg.fixtures.length>20||pkg.fixtures.some(f=>!f||typeof f!=='object'||!safeString(f.name,120)||!safeString(f.input,4000)||!safeString(f.expected,4000)||Object.keys(f).some(key=>!['name','input','expected'].includes(key))))p.push('fixtures are not safe declarative tests');
 const forbidden=['prompt','prompts','files','logs','credentials','code','script','command','args','env'];
 if(forbidden.some(key=>Object.hasOwn(pkg||{},key)))p.push('package contains contributor data or executable fields');
 return p;
}
export function verifySkillPackage(bytes,{entry,publicKeyPem}){
 const hash=sha256(bytes);if(hash!==entry.packageSha256)return {ok:false,error:'Package digest does not match the catalog pin.'};
 let envelope;try{envelope=JSON.parse(Buffer.from(bytes).toString('utf8'));}catch{return {ok:false,error:'Package is not valid JSON.'};}
 const {signature,package:pkg}=envelope||{};const problems=packageProblems(pkg);
 if(problems.length)return {ok:false,error:problems.join('; ')};
 if(pkg.id!==entry.id||pkg.version!==entry.version)return {ok:false,error:'Package identity does not match its catalog entry.'};
 const catalogDeps=(entry.dependencies||[]).map(d=>`${d.id}:${Boolean(d.required)}`).sort(),packageDeps=pkg.dependencies.map(d=>`${d.id}:${d.required}`).sort();if(canonicalJson(catalogDeps)!==canonicalJson(packageDeps))return {ok:false,error:'Package dependencies do not match the reviewed catalog entry.'};
 if(!signatureValid(PACKAGE_DOMAIN,pkg,signature,publicKeyPem))return {ok:false,error:'Package signature is invalid.'};
 return {ok:true,pkg,hash};
}
export function verifyFleetSkillCatalog(document,publicKeyPem){
 const {signature,...catalog}=document||{};if(catalog.schema!==FLEET_SKILLS_SCHEMA||!Array.isArray(catalog.skills))return {ok:false,error:'Unsupported Fleet Skills catalog.'};
 if(!signatureValid(CATALOG_DOMAIN,catalog,signature,publicKeyPem))return {ok:false,error:'Fleet Skills catalog signature is invalid.'};
 const ids=new Set(),skills=[];
 for(const entry of catalog.skills){const bad=!ID.test(entry?.id||'')||!VERSION.test(entry?.version||'')||!safeString(entry?.publisher,120)||!safeString(entry?.description,500)||!/^[0-9a-f]{64}$/.test(entry?.packageSha256||'')||!/^https:\/\//.test(entry?.packageUrl||'')||!Array.isArray(entry?.permissions)||!Array.isArray(entry?.dependencies)||!['reviewed','revoked'].includes(entry?.state)||ids.has(entry.id);if(bad)return {ok:false,error:`Invalid or duplicate catalog entry: ${entry?.id||'(missing)'}.`};ids.add(entry.id);skills.push(entry);}
 return {ok:true,catalog,skills};
}
function installed(state){try{const v=JSON.parse(readFileSync(installedFile(state),'utf8'));return Array.isArray(v.skills)?v.skills:[];}catch{return [];}}
function saveInstalled(state,skills){mkdirSync(skillRoot(state),{recursive:true,mode:0o700});const file=installedFile(state),tmp=`${file}.${process.pid}.tmp`;writeFileSync(tmp,JSON.stringify({skills},null,2),{mode:0o600});renameSync(tmp,file);}
const permissionExpansion=(before,next)=>next.some(p=>!before.includes(p));
const compareVersions=(a,b)=>{const core=v=>v.split('-',1)[0].split('.').map(Number);const aa=core(a),bb=core(b);for(let i=0;i<3;i++){if(aa[i]!==bb[i])return aa[i]-bb[i];}return a===b?0:a.includes('-')&&!b.includes('-')?-1:1;};
export function fleetSkillStates({state,skills}){const have=installed(state);return skills.map(entry=>{const current=have.find(x=>x.id===entry.id);let status='available',reason=null,needsApproval=false;if(entry.state==='revoked'){status='revoked';reason=entry.reason||'Publisher revoked this version.';}else if(entry.permissions?.some(p=>!SUPPORTED_PERMISSIONS.has(p))){status='blocked';reason='Unsupported permission requested.';}else if(entry.dependencies?.some(d=>d.required===true&&d.available===false)){status='blocked';reason='A required dependency is unavailable.';}else if(current){if(current.version===entry.version)status='added';else if(compareVersions(entry.version,current.version)<0){status='blocked';reason='Catalog version is older than the installed skill.';}else if(permissionExpansion(current.permissions||[],entry.permissions||[])){status='blocked';needsApproval=true;reason='Update requests more access; fresh owner approval is required.';}else status='update-available';}return {...entry,status,reason,needsApproval};});}
export function loadFleetSkillCatalog(state){
 const catalogPath=join(state,'fleet','skills-catalog.json'),keyPath=join(state,'fleet','skills-public-key.pem');
 if(!existsSync(catalogPath)||!existsSync(keyPath))return {ok:false,error:'Fleet skill publishing/sync is not configured on this install.',skills:[]};
 try{const checked=verifyFleetSkillCatalog(JSON.parse(readFileSync(catalogPath,'utf8')),readFileSync(keyPath,'utf8'));return checked.ok?{...checked,skills:fleetSkillStates({state,skills:checked.skills})}:{...checked,skills:[]};}catch(error){return {ok:false,error:String(error.message||error),skills:[]};}
}
export async function fetchFleetSkillPackage(entry,{fetchImpl=fetch,maxBytes=2*1024*1024}={}){
 if(!/^https:\/\//.test(entry?.packageUrl||''))throw new Error('Fleet package has no approved HTTPS source.');
 const response=await fetchImpl(entry.packageUrl,{redirect:'error',credentials:'omit',signal:AbortSignal.timeout(20_000)});if(!response.ok)throw new Error(`Fleet package fetch failed: HTTP ${response.status}.`);
 const declared=Number(response.headers.get('content-length')||0);if(declared>maxBytes)throw new Error('Fleet package exceeds the size limit.');
 const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>maxBytes)throw new Error('Fleet package exceeds the size limit.');return bytes;
}
function markdown(pkg){const lines=['---',`name: ${pkg.id}`,`description: ${JSON.stringify(pkg.description)}`,'---','',`# ${pkg.id}`,'',pkg.description,'','## Workflow'];for(const [i,step] of pkg.workflow.entries())lines.push('',`${i+1}. ${step.text}${step.tool?` (tool: ${step.tool})`:''}`);lines.push('','## Verification');for(const f of pkg.fixtures)lines.push('',`- ${f.name}: expected ${f.expected}`);return lines.join('\n')+'\n';}
export async function addFleetSkill({state,id,fetchPackage,approvePermissions=false}){
 const loaded=loadFleetSkillCatalog(state);if(!loaded.ok)return loaded;const entry=loaded.skills.find(x=>x.id===id);if(!entry)return {ok:false,error:'Skill is not in the verified Fleet catalog.'};
 if(entry.status==='revoked'||(entry.status==='blocked'&&!entry.needsApproval))return {ok:false,error:entry.reason};
 if(entry.needsApproval&&!approvePermissions)return {ok:false,error:entry.reason,needsApproval:true};
 const current=installed(state).find(x=>x.id===id);if(current&&permissionExpansion(current.permissions||[],entry.permissions||[])&&!approvePermissions)return {ok:false,error:'Fresh owner approval is required for the added permissions.',needsApproval:true};
 const bytes=await fetchPackage(entry);const verified=verifySkillPackage(bytes,{entry,publicKeyPem:readFileSync(join(state,'fleet','skills-public-key.pem'),'utf8')});if(!verified.ok)return verified;
 const dir=join(skillRoot(state),entry.id,entry.version);if(!existsSync(dir)){mkdirSync(dir,{recursive:true,mode:0o700});writeFileSync(join(dir,'SKILL.md'),markdown(verified.pkg),{mode:0o600});writeFileSync(join(dir,'package.json'),Buffer.from(bytes),{mode:0o600});}
 let connector=listConnectors(state).find(c=>c.kind==='skill'&&c.target===join(dir,'SKILL.md'));
 if(!connector){const added=await addConnector({kind:'skill',name:entry.id,path:dir},{state});if(!added.ok)return {ok:false,error:added.error};connector=added.connector;}
 if(current?.connectorId&&current.connectorId!==connector.id)removeConnector(state,current.connectorId);
 const all=installed(state).filter(x=>x.id!==entry.id);all.push({id:entry.id,version:entry.version,permissions:verified.pkg.permissions,packageSha256:verified.hash,connectorId:connector.id});saveInstalled(state,all);
 return {ok:true,skill:entry,connector,ran:false};
}
