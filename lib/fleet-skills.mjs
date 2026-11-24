// Verified, declarative Fleet skill adoption. Packages contain workflow data and
// safe fixtures only: no executable files are accepted and Add never runs a skill.
import {createHash,createPublicKey,verify} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {canonicalJson} from '../vendor/fleet/fleet-packet.mjs';
import {addConnector,savedConnectors,removeConnector} from './connectors.mjs';

export const FLEET_SKILLS_SCHEMA='kingmaker.fleet-skills/1';
export const SKILL_PACKAGE_SCHEMA='kingmaker.skill-package/1';
export const CATALOG_DOMAIN='kingmaker.fleet-skills.catalog.v1';
export const PACKAGE_DOMAIN='kingmaker.fleet-skills.package.v1';
export const SUPPORTED_PERMISSIONS=new Set(['read:provided-inputs','write:artifacts','network:none']);
const ID=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION=/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const skillRoot=state=>join(state,'fleet-skills');
const validPermissions = permissions => Array.isArray(permissions) &&
 permissions.every(permission => typeof permission === 'string') && new Set(permissions).size === permissions.length;
const samePermissions = (left, right) => validPermissions(left) && validPermissions(right) &&
 left.length === right.length && left.every(permission => right.includes(permission));
const installedFile=state=>join(skillRoot(state),'installed.json');

function signatureValid(domain,value,signature,publicKeyPem){try{const key=createPublicKey(publicKeyPem);return key.asymmetricKeyType==='ed25519'&&verify(null,Buffer.from(`${domain}:${canonicalJson(value)}`),key,Buffer.from(signature,'base64'));}catch{return false;}}
function safeString(value,max){return typeof value==='string'&&value.length>0&&value.length<=max;}
export function packageProblems(pkg){
 const p=[];
 if(pkg?.schema!==SKILL_PACKAGE_SCHEMA)p.push('unsupported package schema');
 if(!ID.test(pkg?.id||''))p.push('invalid skill id');if(!VERSION.test(pkg?.version||''))p.push('invalid version');
 if(!safeString(pkg?.publisher,120))p.push('publisher missing');if(!safeString(pkg?.description,500))p.push('description missing');
 if(!validPermissions(pkg?.permissions)||pkg.permissions.some(x=>!SUPPORTED_PERMISSIONS.has(x)))p.push('unsupported permissions');
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
 if (!samePermissions(pkg.permissions, entry.permissions)) return {ok:false,error:'Package permissions do not match the signed catalog entry.'};
 const catalogDeps=(entry.dependencies||[]).map(d=>`${d.id}:${Boolean(d.required)}`).sort(),packageDeps=pkg.dependencies.map(d=>`${d.id}:${d.required}`).sort();if(canonicalJson(catalogDeps)!==canonicalJson(packageDeps))return {ok:false,error:'Package dependencies do not match the reviewed catalog entry.'};
 if(!signatureValid(PACKAGE_DOMAIN,pkg,signature,publicKeyPem))return {ok:false,error:'Package signature is invalid.'};
 return {ok:true,pkg,hash};
}
export function verifyFleetSkillCatalog(document,publicKeyPem){
 const {signature,...catalog}=document||{};if(catalog.schema!==FLEET_SKILLS_SCHEMA||!Array.isArray(catalog.skills)||typeof catalog.publishedAt!=='string'||!Number.isFinite(Date.parse(catalog.publishedAt)))return {ok:false,error:'Unsupported Fleet Skills catalog.'};
 if(!signatureValid(CATALOG_DOMAIN,catalog,signature,publicKeyPem))return {ok:false,error:'Fleet Skills catalog signature is invalid.'};
 const ids=new Set(),skills=[];
 for(const entry of catalog.skills){const bad=!ID.test(entry?.id||'')||!VERSION.test(entry?.version||'')||!safeString(entry?.publisher,120)||!safeString(entry?.description,500)||!/^[0-9a-f]{64}$/.test(entry?.packageSha256||'')||!/^https:\/\//.test(entry?.packageUrl||'')||!validPermissions(entry?.permissions)||!Array.isArray(entry?.dependencies)||!['reviewed','revoked'].includes(entry?.state)||ids.has(entry.id);if(bad)return {ok:false,error:`Invalid or duplicate catalog entry: ${entry?.id||'(missing)'}.`};ids.add(entry.id);skills.push(entry);}
 return {ok:true,catalog,skills};
}
function installed(state){try{const v=JSON.parse(readFileSync(installedFile(state),'utf8'));return Array.isArray(v.skills)?v.skills:[];}catch{return [];}}
function saveInstalled(state,skills){mkdirSync(skillRoot(state),{recursive:true,mode:0o700});const file=installedFile(state),tmp=`${file}.${process.pid}.tmp`;writeFileSync(tmp,JSON.stringify({skills},null,2),{mode:0o600});renameSync(tmp,file);}
const permissionExpansion=(before,next)=>next.some(p=>!before.includes(p));
const compareVersions=(a,b)=>{const core=v=>v.split('-',1)[0].split('.').map(Number);const aa=core(a),bb=core(b);for(let i=0;i<3;i++){if(aa[i]!==bb[i])return aa[i]-bb[i];}return a===b?0:a.includes('-')&&!b.includes('-')?-1:1;};
function approvedPermissions(record) {
 return record.approvedPermissions || [];
}

export function fleetSkillStates({state,skills}) {
 const have = installed(state);
 return skills.map(entry => {
  const current = have.find(record => record.id === entry.id);
  let status = 'available', reason = null, needsApproval = false;
  if (entry.state === 'revoked') {
   status = 'revoked';
   reason = entry.reason || 'Publisher revoked this version.';
  } else if (entry.permissions.some(permission => !SUPPORTED_PERMISSIONS.has(permission))) {
   status = 'blocked';
   reason = 'Unsupported permission requested.';
  } else if (entry.dependencies.some(dependency => dependency?.required === true && dependency.available === false)) {
   status = 'blocked';
   reason = 'A required dependency is unavailable.';
  } else if (current) {
   if (compareVersions(entry.version,current.version) < 0) {
    status = 'blocked';
    reason = 'Catalog version is older than the installed skill.';
   } else if (entry.version === current.version && entry.packageSha256 !== current.packageSha256) {
    status = 'blocked';
    reason = 'The catalog changed the package digest without a version increase.';
   } else if (permissionExpansion(approvedPermissions(current),entry.permissions)) {
    status = 'blocked';
    needsApproval = true;
    reason = 'This package requests access beyond the recorded approval.';
   } else if (current.version === entry.version && current.packageSha256 === entry.packageSha256 &&
              samePermissions(current.permissions,entry.permissions) &&
              savedConnectors(state).some(connector => connector.id === current.connectorId && connector.enabled)) {
    status = 'added';
   } else {
    status = 'update-available';
   }
  }
  return {...entry,status,reason,needsApproval};
 });
}

export function loadFleetSkillCatalog(state) {
 const catalogPath = join(state,'fleet','skills-catalog.json');
 const keyPath = join(state,'fleet','skills-public-key.pem');
 const acceptedPath = join(skillRoot(state),'accepted-catalog.json');
 if (!existsSync(catalogPath) || !existsSync(keyPath)) {
  return {ok:false,error:'Fleet skill publishing/sync is not configured on this install.',skills:[]};
 }
 try {
  const publicKeyPem = readFileSync(keyPath,'utf8');
  const document = JSON.parse(readFileSync(catalogPath,'utf8'));
  const checked = verifyFleetSkillCatalog(document,publicKeyPem);
  if (!checked.ok) return {...checked,skills:[]};
  const accepted = existsSync(acceptedPath) ? JSON.parse(readFileSync(acceptedPath,'utf8')) : null;
  if (accepted) {
   const prior = verifyFleetSkillCatalog(accepted,publicKeyPem);
   if (!prior.ok) return {ok:false,error:'Previously accepted Fleet catalog failed verification.',skills:[]};
   const candidateTime = Date.parse(checked.catalog.publishedAt);
   const priorTime = Date.parse(prior.catalog.publishedAt);
   if (candidateTime < priorTime || (candidateTime === priorTime && canonicalJson(prior.catalog) !== canonicalJson(checked.catalog))) {
    return {ok:false,error:'Older or conflicting Fleet Skills catalog revision.',skills:[]};
   }
  }
  if (!accepted || document.signature !== accepted.signature) {
   mkdirSync(skillRoot(state),{recursive:true,mode:0o700});
   const temporary = `${acceptedPath}.${process.pid}.tmp`;
   writeFileSync(temporary,JSON.stringify(document),{mode:0o600});
   renameSync(temporary,acceptedPath);
  }
  return {...checked,skills:fleetSkillStates({state,skills:checked.skills})};
 } catch (error) {
  return {ok:false,error:String(error.message || error),skills:[]};
 }
}

export function readFleetSkillForInvocation(state, connector) {
 if (!state || !connector.target || !isAbsolute(connector.target)) {
  return connector.fleetSkill ? {ok:false,error:'Fleet skill invocation requires its original install state.'} : null;
 }
 const relativeTarget = relative(resolve(skillRoot(state)),resolve(connector.target));
 const parts = relativeTarget.split(sep);
 if (parts[0] === '..' || isAbsolute(relativeTarget)) {
  return connector.fleetSkill ? {ok:false,error:'Fleet skill is outside its original install state.'} : null;
 }
 const [id,version,file] = parts;
 if (parts.length !== 3 || file !== 'SKILL.md') return {ok:false,error:'Unrecognized Fleet skill path.'};
 const catalog = loadFleetSkillCatalog(state);
 if (!catalog.ok) return catalog;
 const entry = catalog.skills.find(skill => skill.id === id);
 if (!entry || entry.status !== 'added' || entry.version !== version) {
  return {ok:false,error:entry?.reason || 'This Fleet skill is no longer current and authorized.'};
 }
 const current = installed(state).find(record => record.id === id && record.connectorId === connector.id);
 if (!current) return {ok:false,error:'This Fleet connector is no longer installed.'};
 try {
  const bytes = readFileSync(join(dirname(connector.target),'package.json'));
  const publicKeyPem = readFileSync(join(state,'fleet','skills-public-key.pem'),'utf8');
  const verified = verifySkillPackage(bytes,{entry,publicKeyPem});
  return verified.ok ? {ok:true,skill:markdown(verified.pkg)} : verified;
 } catch (error) {
  return {ok:false,error:String(error.message || error)};
 }
}
export async function fetchFleetSkillPackage(entry,{fetchImpl=fetch,maxBytes=2*1024*1024}={}){
 if(!/^https:\/\//.test(entry?.packageUrl||''))throw new Error('Fleet package has no approved HTTPS source.');
 const response=await fetchImpl(entry.packageUrl,{redirect:'error',credentials:'omit',signal:AbortSignal.timeout(20_000)});if(!response.ok)throw new Error(`Fleet package fetch failed: HTTP ${response.status}.`);
 const declared=Number(response.headers.get('content-length')||0);if(declared>maxBytes)throw new Error('Fleet package exceeds the size limit.');
 const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>maxBytes)throw new Error('Fleet package exceeds the size limit.');return bytes;
}
function markdown(pkg){const lines=['---',`name: ${pkg.id}`,`description: ${JSON.stringify(pkg.description)}`,'---','',`# ${pkg.id}`,'',pkg.description,'','## Workflow'];for(const [i,step] of pkg.workflow.entries())lines.push('',`${i+1}. ${step.text}${step.tool?` (tool: ${step.tool})`:''}`);lines.push('','## Verification');for(const f of pkg.fixtures)lines.push('',`- ${f.name}: expected ${f.expected}`);return lines.join('\n')+'\n';}
export async function addFleetSkill({state,id,fetchPackage,approvalPin = null}) {
 const loaded = loadFleetSkillCatalog(state);
 if (!loaded.ok) return loaded;
 const entry = loaded.skills.find(skill => skill.id === id);
 if (!entry) return {ok:false,error:'Skill is not in the verified Fleet catalog.'};
 if (entry.status === 'revoked' || (entry.status === 'blocked' && !entry.needsApproval)) return {ok:false,error:entry.reason};
 if (entry.needsApproval && approvalPin !== entry.packageSha256) return {ok:false,error:entry.reason,needsApproval:true};
 const bytes = await fetchPackage(entry);

 // Refresh may change the reviewed package or revoke it while the download is in progress.
 const latest = loadFleetSkillCatalog(state);
 if (!latest.ok) return latest;
 if (canonicalJson(loaded.catalog) !== canonicalJson(latest.catalog)) return {ok:false,error:'Fleet catalog changed during Add. Review the current entry and try again.'};
 const currentEntry = latest.skills.find(skill => skill.id === id);
 if (currentEntry.needsApproval && approvalPin !== entry.packageSha256) return {ok:false,error:currentEntry.reason,needsApproval:true};
 const verified = verifySkillPackage(bytes,{entry,publicKeyPem:readFileSync(join(state,'fleet','skills-public-key.pem'),'utf8')});
 if (!verified.ok) return verified;

 const current = installed(state).find(record => record.id === id);
 const dir = join(skillRoot(state),id,entry.version);
 const target = join(dir,'SKILL.md');
 mkdirSync(dir,{recursive:true,mode:0o700});
 writeFileSync(target,markdown(verified.pkg),{mode:0o600});
 writeFileSync(join(dir,'package.json'),bytes,{mode:0o600});
 let connector = savedConnectors(state).find(item => item.kind === 'skill' && item.target === target && item.enabled);
 if (!connector) {
  const added = await addConnector({kind:'skill',name:id,path:dir,fleetSkill:true},{state});
  if (!added.ok) return {ok:false,error:added.error};
  connector = added.connector;
 }
 const all = installed(state).filter(record => record.id !== id);
 all.push({id,version:entry.version,permissions:verified.pkg.permissions,approvedPermissions:entry.permissions,
  packageSha256:verified.hash,connectorId:connector.id});
 saveInstalled(state,all);
 if (current?.connectorId && current.connectorId !== connector.id) removeConnector(state,current.connectorId);
 return {ok:true,skill:entry,connector,ran:false};
}
