// Verified, declarative Fleet skill adoption. Packages contain workflow data and
// safe fixtures only: no executable files are accepted and Add never runs a skill.
import {createHash,createPublicKey,verify} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {canonicalJson} from '../vendor/fleet/fleet-packet.mjs';
import {addConnector,savedConnectors,removeConnector} from './connectors.mjs';

export const FLEET_SKILLS_SCHEMA='kingmaker.fleet-skills/1';
export const SKILL_PACKAGE_SCHEMA='kingmaker.skill-package/1';
export const CATALOG_DOMAIN='kingmaker.fleet-skills.catalog.v1';
export const FLEET_INDEX_SCHEMA = 'kingmaker.fleet-index/1';
export const FLEET_INDEX_DOMAIN = 'kingmaker.fleet-index.v1';
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
const fleetDir = state => join(state,'fleet');
const keyFile = state => join(fleetDir(state),'skills-public-key.pem');
const acceptedFile = state => join(skillRoot(state),'accepted-catalog.json');
const feedStatusFile = state => join(skillRoot(state),'feed-status.json');
const REFRESH_MS = 60_000;
const MAX_AGE_MS = 2 * REFRESH_MS + 15_000;

function readFeedConfig(state) {
 const file = join(fleetDir(state),'skills-feed.json');
 if (!existsSync(file)) return null;
 const config = JSON.parse(readFileSync(file,'utf8'));
 const url = sourceUrl(config?.catalogUrl, config?.fixtureLoopback === true);
 if (!url || (config.fixtureLoopback === true && url.hostname !== '127.0.0.1')) {
  throw new Error('Fleet feed requires an approved HTTPS catalog URL.');
 }
 if ((config.auth !== undefined && config.auth !== 'bearer') || (config.auth === 'bearer' && url.search)) {
  throw new Error('Invalid Fleet feed authentication configuration.');
 }
 return {url,fixtureLoopback:config.fixtureLoopback === true,auth:config.auth};
}

function sourceUrl(value, fixtureLoopback = false) {
 if (typeof value !== 'string') return null;
 try {
  const url = new URL(value);
  if (url.username || url.password || url.hash) return null;
  if (url.protocol === 'https:' || (fixtureLoopback && url.protocol === 'http:' && url.hostname === '127.0.0.1')) return url;
 } catch { /* malformed URL */ }
 return null;
}

function allowedPackage(value, feed) {
 const url = sourceUrl(value,feed?.fixtureLoopback);
 return Boolean(url && (!feed?.url || (url.origin === feed.url.origin && (feed.auth !== 'bearer' || !url.search))));
}

function writeJson(file, value) {
 mkdirSync(dirname(file),{recursive:true,mode:0o700});
 const temporary = `${file}.${process.pid}.tmp`;
 writeFileSync(temporary,JSON.stringify(value),{mode:0o600});
 renameSync(temporary,file);
}

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
const ASSET_TYPES = new Set(['brain','weights','skill','tool']);
const DIGEST = /^[0-9a-f]{64}$/;
const fieldsOnly = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) &&
 Object.keys(value).every(field => fields.includes(field));

function validSource(source) {
 return fieldsOnly(source,['repo','commit','path','sha256']) && safeString(source.repo,200) &&
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source.repo || '') &&
  source.repo.split('/').every(part => part !== '.' && part !== '..') &&
  /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(source.commit || '') && DIGEST.test(source.sha256 || '') &&
  safeString(source.path,500) && !/[\\\x00-\x1f\x7f]/.test(source.path) &&
  source.path.split('/').every(part => part.length && part !== '.' && part !== '..');
}

function isAdoptable(entry) {
 return !entry.type || entry.type === 'skill' || (entry.type === 'tool' && entry.approval === 'defensive');
}

function validAction(entry, feed) {
 return DIGEST.test(entry.packageSha256 || '') && allowedPackage(entry.packageUrl,feed) &&
  validPermissions(entry.permissions) && Array.isArray(entry.dependencies);
}

export function fleetIndexProblems(index, feed = null) {
 if (!fieldsOnly(index,['schema','publishedAt','entries']) || index.schema !== FLEET_INDEX_SCHEMA ||
     typeof index.publishedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(index.publishedAt) ||
     !Number.isFinite(Date.parse(index.publishedAt)) || !Array.isArray(index.entries)) {
  return ['Unsupported Fleet index.'];
 }
 const ids = new Set();
 const problems = [];
 for (const entry of index.entries) {
  const valid = fieldsOnly(entry,['type','id','version','publisher','description','source','state','reason',
   'approval','packageUrl','packageSha256','permissions','dependencies']) &&
   ASSET_TYPES.has(entry.type) && typeof entry.id === 'string' && ID.test(entry.id) &&
   typeof entry.version === 'string' && VERSION.test(entry.version) &&
   safeString(entry.publisher,120) && safeString(entry.description,500) && validSource(entry.source) &&
   ['reviewed','revoked'].includes(entry.state) && (entry.reason === undefined || safeString(entry.reason,500)) &&
   (entry.approval === undefined || (entry.type === 'tool' && entry.approval === 'defensive')) &&
   !ids.has(entry.id);
  if (!valid || (isAdoptable(entry) ?
   !validAction(entry,feed) || entry.dependencies.some(dependency =>
    !fieldsOnly(dependency,['id','required','available']) || !ID.test(dependency.id || '') ||
    typeof dependency.required !== 'boolean' ||
    (dependency.available !== undefined && typeof dependency.available !== 'boolean')) :
   ['packageUrl','packageSha256','permissions','dependencies'].some(field => Object.hasOwn(entry,field)))) {
   problems.push(`Invalid or duplicate Fleet index entry: ${entry?.id || '(missing)'}.`);
  } else {
   ids.add(entry.id);
  }
 }
 return problems;
}

export function verifyFleetSkillCatalog(document,publicKeyPem,feed = null,{allowLegacy = !feed} = {}) {
 const {signature,...catalog} = document || {};
 if (catalog.schema === FLEET_INDEX_SCHEMA) {
  if (!signatureValid(FLEET_INDEX_DOMAIN,catalog,signature,publicKeyPem)) return {ok:false,error:'Fleet index signature is invalid.'};
  const issues = fleetIndexProblems(catalog,feed);
  return issues.length ? {ok:false,error:issues.join(' ')} : {ok:true,catalog,skills:catalog.entries};
 }
 if (!allowLegacy || catalog.schema !== FLEET_SKILLS_SCHEMA || !Array.isArray(catalog.skills) ||
     typeof catalog.publishedAt !== 'string' || !Number.isFinite(Date.parse(catalog.publishedAt))) {
  return {ok:false,error:'Unsupported Fleet Skills catalog. A managed feed requires a signed Fleet index.'};
 }
 if (!signatureValid(CATALOG_DOMAIN,catalog,signature,publicKeyPem)) return {ok:false,error:'Fleet Skills catalog signature is invalid.'};
 const ids = new Set();
 for (const entry of catalog.skills) {
  const invalid = !ID.test(entry?.id || '') || !VERSION.test(entry?.version || '') ||
   !safeString(entry?.publisher,120) || !safeString(entry?.description,500) || !validAction(entry,feed) ||
   Object.hasOwn(entry,'type') || !['reviewed','revoked'].includes(entry.state) || ids.has(entry.id);
  if (invalid) return {ok:false,error:`Invalid or duplicate catalog entry: ${entry?.id || '(missing)'}.`};
  ids.add(entry.id);
 }
 return {ok:true,catalog,skills:catalog.skills};
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
  const adoptable = isAdoptable(entry);
  let status = 'available', reason = null, needsApproval = false;
  if (entry.state === 'revoked') {
   status = 'revoked';
   reason = entry.reason || 'Publisher revoked this version.';
  } else if (!adoptable) {
   status = 'indexed';
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
  return {...entry,adoptable,status,reason,needsApproval};
 });
}

function readAccepted(state) {
 const file = acceptedFile(state);
 return existsSync(file) ? JSON.parse(readFileSync(file,'utf8')) : null;
}

function acceptCatalog(state, document, key, feed = null) {
 const checked = verifyFleetSkillCatalog(document,key,feed);
 if (!checked.ok) return checked;
 const accepted = readAccepted(state);
 if (accepted) {
  const prior = verifyFleetSkillCatalog(accepted,key,feed ? {...feed,url:null} : null,{allowLegacy:true});
  if (!prior.ok) return {ok:false,error:'Previously accepted Fleet catalog failed verification.'};
  if (prior.catalog.schema === FLEET_INDEX_SCHEMA && checked.catalog.schema !== FLEET_INDEX_SCHEMA) {
   return {ok:false,error:'Fleet index schema downgrade refused.'};
  }
  const candidateTime = Date.parse(checked.catalog.publishedAt);
  const priorTime = Date.parse(prior.catalog.publishedAt);
  if (candidateTime < priorTime || (candidateTime === priorTime && canonicalJson(prior.catalog) !== canonicalJson(checked.catalog))) {
   return {ok:false,error:'Older or conflicting Fleet Skills catalog revision.'};
  }
 }
 if (!accepted || document.signature !== accepted.signature) writeJson(acceptedFile(state),document);
 return checked;
}

export function loadFleetSkillCatalog(state) {
 try {
  const feed = readFeedConfig(state);
  const catalogPath = join(fleetDir(state),'skills-catalog.json');
  if (!feed && (!existsSync(catalogPath) || !existsSync(keyFile(state)))) {
   return {ok:false,error:'Fleet skill publishing/sync is not configured on this install.',skills:[]};
  }
  const key = readFileSync(keyFile(state),'utf8');
  if (!feed) {
   const document = JSON.parse(readFileSync(catalogPath,'utf8'));
   const checked = acceptCatalog(state,document,key);
   return checked.ok ? {...checked,skills:fleetSkillStates({state,skills:checked.skills})} : {...checked,skills:[]};
  }

  const document = readAccepted(state);
  const file = feedStatusFile(state);
  const status = existsSync(file) ? JSON.parse(readFileSync(file,'utf8')) : null;
  const checked = document && verifyFleetSkillCatalog(document,key,feed);
  const skills = checked?.ok ? fleetSkillStates({state,skills:checked.skills}) : [];
  const age = Date.now() - status?.checkedAt;
  if (status?.url !== feed.url.href || status.auth !== feed.auth || status.error || !checked?.ok ||
      status.signature !== document.signature || !(age >= 0 && age <= MAX_AGE_MS)) {
   return {ok:false,error:status?.error || checked?.error || 'Waiting for a current, verified Fleet catalog.',skills};
  }
  return {...checked,skills};
 } catch (error) {
  return {ok:false,error:String(error.message || error),skills:[]};
 }
}

function feedHeaders(state, feed) {
 if (feed?.auth !== 'bearer') return undefined;
 const file = join(fleetDir(state),'skills-feed-token');
 try {
  const stat = lstatSync(file);
  if (!stat.isFile() || (stat.mode & 0o077)) throw new Error();
  const token = readFileSync(file,'utf8').trim();
  if (!/^[A-Za-z0-9._~-]{32,}$/.test(token)) throw new Error();
  return { Authorization: `Bearer ${token}` };
 } catch {
  throw new Error('Fleet bearer credential is missing or is not a private token file.');
 }
}

async function fetchFleetBytes(url, label, {fetchImpl = fetch, maxBytes = 2 * 1024 * 1024, headers} = {}) {
 const response = await fetchImpl(url,{redirect:'error',credentials:'omit',headers,cache:'no-store',signal:AbortSignal.timeout(10_000)});
 if (!response.ok) throw new Error(`${label} fetch failed: HTTP ${response.status}.`);
 if (!response.body) throw new Error(`${label} response has no body.`);
 const chunks = [];
 let size = 0;
 for await (const chunk of response.body) {
  size += chunk.byteLength;
  if (size > maxBytes) throw new Error(`${label} exceeds the size limit.`);
  chunks.push(chunk);
 }
 return Buffer.concat(chunks,size);
}

async function refreshFleetSkillCatalog(state) {
 let feed;
 try {
  feed = readFeedConfig(state);
  if (!feed) return loadFleetSkillCatalog(state);
  const key = readFileSync(keyFile(state),'utf8');
  const bytes = await fetchFleetBytes(feed.url,'Fleet catalog',{headers:feedHeaders(state,feed)});
  const current = readFeedConfig(state);
  if (current?.url.href !== feed.url.href || current.fixtureLoopback !== feed.fixtureLoopback || current.auth !== feed.auth ||
      key !== readFileSync(keyFile(state),'utf8')) throw new Error('Fleet feed configuration changed during refresh.');
  const document = JSON.parse(bytes.toString('utf8'));
  const checked = acceptCatalog(state,document,key,feed);
  if (!checked.ok) throw new Error(checked.error);
  writeJson(feedStatusFile(state),{url:feed.url.href,auth:feed.auth,checkedAt:Date.now(),signature:document.signature});
 } catch (error) {
  const message = `Fleet refresh failed: ${error.message || error}`;
  if (!feed) return {ok:false,error:message,skills:[]};
  try {
   writeJson(feedStatusFile(state),{url:feed.url.href,auth:feed.auth,error:message});
  } catch {
   return {ok:false,error:message,skills:[]};
  }
 }
 return loadFleetSkillCatalog(state);
}

export function startFleetSkillRefresh(state, onCatalog, {intervalMs = REFRESH_MS} = {}) {
 let pending = null, stopped = false;
 const refresh = () => {
  if (!stopped && !pending) {
   pending = refreshFleetSkillCatalog(state).then(view => {
    if (!stopped) onCatalog(view);
    return view;
   }).finally(() => { pending = null; });
  }
  return pending;
 };
 void refresh();
 const timer = setInterval(() => {
  if (existsSync(join(fleetDir(state),'skills-feed.json'))) void refresh();
 },intervalMs);
 timer.unref();
 return {refresh,stop:() => { stopped = true; clearInterval(timer); }};
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
export async function fetchFleetSkillPackage(entry,{state,fetchImpl,maxBytes} = {}) {
 const feed = state ? readFeedConfig(state) : null;
 if (!allowedPackage(entry?.packageUrl,feed)) throw new Error('Fleet package has no approved source.');
 return fetchFleetBytes(entry.packageUrl,'Fleet package',{fetchImpl,maxBytes,headers:feedHeaders(state,feed)});
}
function markdown(pkg){const lines=['---',`name: ${pkg.id}`,`description: ${JSON.stringify(pkg.description)}`,'---','',`# ${pkg.id}`,'',pkg.description,'','## Workflow'];for(const [i,step] of pkg.workflow.entries())lines.push('',`${i+1}. ${step.text}${step.tool?` (tool: ${step.tool})`:''}`);lines.push('','## Verification');for(const f of pkg.fixtures)lines.push('',`- ${f.name}: expected ${f.expected}`);return lines.join('\n')+'\n';}
export async function addFleetSkill({state,id,fetchPackage = entry => fetchFleetSkillPackage(entry,{state}),approvalPin = null}) {
 const loaded = loadFleetSkillCatalog(state);
 if (!loaded.ok) return loaded;
 const entry = loaded.skills.find(skill => skill.id === id);
 if (!entry) return {ok:false,error:'Skill is not in the verified Fleet catalog.'};
 if (!entry.adoptable) return {ok:false,error:'This Fleet asset is a metadata reference and cannot be added.'};
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
