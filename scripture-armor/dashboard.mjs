#!/usr/bin/env node
import { renderArmorDashboard } from './dashboard-view.mjs';
import { readProtectionStatus } from './protection-status.mjs';
import { createDeviceProtection, deviceResources } from './device-protection.mjs';
import { reviewUploadedFile } from './sandbox-review.mjs';
import { appendProtectionFeed,readProtectionFeed } from './protection-feed.mjs';
import { preparePackagedAnalysisRuntime } from './analysis-runtime.mjs';
import {createRepositoryReview,repositoryReference} from './repository-review.mjs';
import {retrieveReviewLink,publicReviewURL} from './review-intake.mjs';
import {createOriginalEjection,reviewSource} from './review-ejection.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createIdentity, defaultIdentityDir, loadIdentity } from './armor.mjs';
import { hasCurrentAcceptance, recordAcceptance, TERMS_TEXT } from './terms.mjs';
import { scanFile, classifyBuffer } from './scan.mjs';
import { migrateCredentials, previewMigration } from './credential-vault.mjs';
import { createAccountSessionStore } from './account-session-store.mjs';
import { createArmorAccountSession } from './account-session.mjs';
import { activateArmor } from './activation-flow.mjs';
import { hasPaidActivation, recordPaidActivation } from './paid-activation.mjs';
import { assertProductIdentityDir, canonicalPath } from './product-paths.mjs';
import { externalFile, sameExternalFile } from './vault-paths.mjs';
import { installationMetadata } from './installation-metadata.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export async function analyzeDashboardFile(target, analyze = scanFile) {
  // Ghidra refuses project locations with dot-prefixed path components.
  // Keep transient projects separate from the hidden identity/vault directory.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'scripture-armor-analysis-'));
  try {
    fs.chmodSync(work, 0o700);
    return await analyze(target, { storeDir: work });
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
export function createArmorDashboard(options = {}) {
// Library/fixture instances are inert by default. Only the native entry point
// explicitly opts into the real OS store; tests must never clear a live login.
const account = createArmorAccountSession({ sessionStore: options.sessionStore ?? null, fetchImpl: options.fetchImpl || globalThis.fetch, installationProvider: () => installationMetadata(identityDir) });
const identityDir = assertProductIdentityDir(options.identityDir || defaultIdentityDir());
const nativeReviewToken=options.nativeReviewToken||null;
const originalEjection=createOriginalEjection({identityDir});
let protection = { connected: false, state: 'checking', activeAirlocks: 0, runningActivations: 0, wholeDeviceCoverageVerified: false };
let protectionCheckedAt = 0;
let protectionCheck = null;
async function refreshProtection() {
  if (Date.now() - protectionCheckedAt < 10000) return;
  if (!protectionCheck) protectionCheck = readProtectionStatus(identityDir).then(value => { protection = value; protectionCheckedAt = Date.now(); }).finally(() => { protectionCheck = null; });
  await protectionCheck;
}
const migrationManifest = options.migrationManifest || null;

const token = crypto.randomBytes(24).toString('base64url');
const feedFile = path.join(identityDir, 'dashboard-feed.jsonl');
const quarantineDir = path.join(identityDir, 'quarantine');
let analysisBusy = false, deviceLeaseUntil = 0, deviceRenewing = null, wasAuthenticated = false;
async function exclusiveAnalysis(operation) {
  if(analysisBusy) throw Error('Another protection analysis is running.');
  analysisBusy=true;try{return await operation();}finally{analysisBusy=false;}
}
const device = options.deviceProtection === true ? createDeviceProtection({
  identityDir, ...(options.deviceRoots ? {roots:options.deviceRoots} : {}),
  resources:async dir=>!repositoryReview?.state()||['completed','completed_with_gaps','paused_by_admin'].includes(repositoryReview.state().state)?!analysisBusy && await (options.deviceResources||deviceResources)(dir):false,
  isLicensed:()=>account.state().authenticated && Date.now()<deviceLeaseUntil,
  onEvent:(type,message)=>feed(type,message),
  analyze:target=>exclusiveAnalysis(async()=>{
    const bytes=fs.readFileSync(target);
    try {
      const result=await reviewUploadedFile(bytes,path.basename(target),{
        readRoots:reviewToolRoots(bytes,path.basename(target)),protectedRoots:[identityDir,identityDir+'.installation']});
      return {finding:result.activeContent||result.format==='Sensitive key material'||result.findings.some(f=>f.severity!=='info')||
        Boolean(result.rea&&result.rea.verdict!=='clean')||Boolean(result.binary&&!['pass','not-applicable'].includes(result.binary.verdict)),limited:result.status==='limited'};
    }finally{bytes.fill(0);}
  }),
}) : null;
const repositoryReview=createRepositoryReview({identityDir,...(options.repositoryFetchBytes?{fetchBytes:options.repositoryFetchBytes}:{}),
  resources:async()=>!analysisBusy&&await(options.deviceResources||deviceResources)(identityDir),
  isLicensed:async()=>{await resumeDeviceChecks();return account.state().authenticated&&Date.now()<deviceLeaseUntil&&status().activated;},
  analyze:(bytes,name)=>exclusiveAnalysis(()=>reviewUploadedFile(bytes,name,{readRoots:reviewToolRoots(bytes,name),protectedRoots:[identityDir,identityDir+'.installation']})),
});
function reviewToolRoots(bytes,name) {
  if(classifyBuffer(bytes.subarray(0,16384),name)!=='binary'||!fs.existsSync(path.join(HERE,'BUNDLE.json')))return [];
  const tools=[preparePackagedAnalysisRuntime({bundleRoot:HERE})],jdk=path.join(HERE,'tools','jdk');
  if(fs.existsSync(jdk))tools.push(jdk);return tools;
}
async function resumeDeviceChecks(trigger='resume') {
  if(!device)return;
  if(!account.state().authenticated){deviceLeaseUntil=0;return;}
  if(Date.now()<deviceLeaseUntil-5000){device.start(trigger);return;}
  if(!deviceRenewing) deviceRenewing=(async()=>{
    try {
      const entitlement=await account.verifyEntitlement();
      if(!status().activated) return;
      deviceLeaseUntil=Math.min(Date.now()+60000,Number(entitlement.term.endsAt)*1000);
      if(Number.isFinite(deviceLeaseUntil)&&deviceLeaseUntil>Date.now())device.start(trigger);
    } catch {deviceLeaseUntil=0;}
    finally {deviceRenewing=null;}
  })();
  await deviceRenewing;
}
const armorCheckout = Object.freeze({
  download: 'https://www.ronininc.org/armor/checkout?purpose=download',
  discordMembership: 'https://www.ronininc.org/armor/checkout?purpose=discord-membership',
});

async function runRea(target) {
  const candidates = [path.join(HERE, 'rea', 'rea.mjs'), path.join(HERE, '..', 'lib', 'rea.mjs')];
  const modulePath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!modulePath) throw new Error('REA_NOT_FOUND: the required REA scanner is not packaged');
  const { inspect } = await import(pathToFileURL(modulePath));
  return inspect([target]);
}

function feed(type, message, extra = {}) {
  fs.mkdirSync(identityDir, { recursive: true, mode: 0o700 });
  appendProtectionFeed(feedFile,{ at: new Date().toISOString(), type, message, ...extra });
}

function readFeed() {return readProtectionFeed(feedFile);}

function json(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': data.length, 'cache-control': 'no-store' });
  res.end(data);
}

async function body(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 64 * 1024) throw new Error('request too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('Invalid JSON request.'); }
}

function status() {
  const identity = loadIdentity(identityDir);
  let migration = { count: 0, entries: [] };
  try { migration = previewMigration(migrationManifest, { identityDir }); } catch (error) { migration = { count: 0, entries: [], error: error.message }; }
  return {
    activated: Boolean(account.state().authenticated && identity && hasCurrentAcceptance(identityDir, 'owner') && hasPaidActivation(identityDir, identity)),
    account: account.state(),
    protection,
    repositoryReview:repositoryReview.state(),
    deviceScan: device?.state() || {state:'not_enabled',wholeDeviceCoverageVerified:false},
    label: identity?.label || null,
    migration,
    feed: readFeed(),
  };
}

function safeTarget(input) {
  return externalFile(String(input || ''), { identityDir });
}

async function reviewLinkResponse(input,res) {
    try{publicReviewURL(input.url);}catch(error){return json(res,400,{ok:false,error:error.message});}
    if(repositoryReference(input.url)){await device?.stop();const repositoryJob=repositoryReview.start(input.url);return json(res,202,{ok:true,repositoryJob});}
    if(!await(options.deviceResources||deviceResources)(identityDir))return json(res,503,{ok:false,error:'Review paused to preserve memory and disk headroom.'});
    await device?.stop();let intake;
    try {
      const result=await exclusiveAnalysis(async()=>{
        intake=await retrieveReviewLink(input.url);
        return reviewUploadedFile(intake.bytes,intake.name,{readRoots:reviewToolRoots(intake.bytes,intake.name),protectedRoots:[identityDir,identityDir+'.installation']});
      });
      if(intake.source.partial){
        result.status='limited';result.limitations.push(intake.source.scope);
        if(result.risk.level==='low')result.risk.level='unknown';
        result.announcement='Partial webpage review only. The first 16 MiB was inspected; the remainder was not retrieved. No complete-page safety verdict is issued. '+result.announcement;
      }
      feed('link-review',`Public ${intake.source.kind} review: ${result.disposition}, danger ${result.risk.level}. No linked content was executed.`);
      return json(res,200,{ok:true,review:result,source:intake.source});
    }finally{intake?.bytes.fill(0);device?.start('resume');}
}

async function api(req, res, url) {
  if(req.method==='POST'&&['/api/review/native-file','/api/review/native-report','/api/review/native-finding','/api/review/native-retain','/api/review/native-link','/api/review/eject-original'].includes(url.pathname)) {
    const claimed=String(req.headers['x-armor-native-review-token']||'');
    if(!/^[a-f0-9]{64}$/.test(nativeReviewToken||'')||!/^[a-f0-9]{64}$/.test(claimed)||!crypto.timingSafeEqual(Buffer.from(claimed),Buffer.from(nativeReviewToken)))return json(res,403,{ok:false,error:'Native review authorization required.'});
    try{await account.verifyEntitlement();}catch{return json(res,403,{ok:false,error:'Sign in and activate before native file review.'});}
    if(!status().activated)return json(res,409,{ok:false,error:'Activate Scripture Armor first.'});
    const input=await body(req);
    if(url.pathname==='/api/review/native-report'){
      const file=repositoryReview.report(input.id);res.writeHead(200,{'content-type':'application/x-ndjson','cache-control':'no-store'});fs.createReadStream(file).pipe(res);return;
    }
    if(url.pathname==='/api/review/native-retain'){
      if(Object.keys(input).length!==1||typeof input.text!=='string'||!input.text.trim()||input.text.length>32768)return json(res,400,{ok:false,error:'Select up to 32 KiB of useful text.'});
      if(!await(options.deviceResources||deviceResources)(identityDir))return json(res,503,{ok:false,error:'Retained-text review is waiting for memory and disk headroom. Try again shortly.'});
      await device?.stop();const bytes=Buffer.from(input.text,'utf8');
      try{const review=await exclusiveAnalysis(()=>reviewUploadedFile(bytes,'retained-notes.txt',{protectedRoots:[identityDir,identityDir+'.installation']}));
        if(review.disposition==='ejected'||review.status==='limited'||review.activeContent)return json(res,422,{ok:false,error:'Selected text still contains risk patterns or could not be fully inspected. Edit it before saving. The original has not been removed.'});
        return json(res,200,{ok:true,retainedText:input.text});
      }finally{bytes.fill(0);device?.start('resume');}
    }
    if(url.pathname==='/api/review/native-finding'){
      if(Object.keys(input).length!==1||typeof input.id!=='string'||!device?.findingPath(input.id))return json(res,404,{ok:false,error:'Finding expired. Scan the device again.'});
      input.path=device.findingPath(input.id);
    }
    if(url.pathname==='/api/review/native-link')return reviewLinkResponse(input,res);
    if(url.pathname==='/api/review/eject-original') {
      if(input.confirm!=='PERMANENTLY_REMOVE_REVIEWED_FILE')return json(res,400,{ok:false,error:'Native owner confirmation is required.'});
      await device?.stop();
      try{const ejection=await exclusiveAnalysis(()=>originalEjection.eject(input.id));feed('original-ejected',ejection.announcement);return json(res,200,{ok:true,ejection});}
      finally{device?.start('resume');}
    }
    if(!await(options.deviceResources||deviceResources)(identityDir))return json(res,503,{ok:false,error:'Review paused to preserve memory and disk headroom.'});
    await device?.stop();let source;
    try {
      const review=await exclusiveAnalysis(async()=>{
        if(options.nativeReviewRoot){const root=fs.realpathSync(options.nativeReviewRoot),file=fs.realpathSync(input.path);if(!file.startsWith(root+path.sep))throw Error('Native fixture review is restricted to its disposable file scope.');}
        source=reviewSource(input.path,{identityDir});
        return reviewUploadedFile(source.bytes,path.basename(source.target.path),{readRoots:reviewToolRoots(source.bytes,path.basename(source.target.path)),protectedRoots:[identityDir,identityDir+'.installation']});
      });
      const sourceEjectionId=originalEjection.register(source,review);
      feed('native-file-review',`Native file review: ${review.disposition}, danger ${review.risk.level}. Original removal requires confirmation.`);
      return json(res,200,{ok:true,review,sourceEjectionId,nativeSourcePath:source.target.path});
    }finally{source?.bytes.fill(0);device?.start('resume');}
  }
  if (req.headers['x-scripture-armor-token'] !== token) return json(res, 403, { ok: false, error: 'forbidden' });
  if (req.method === 'GET' && url.pathname === '/api/account/me') {
    try { await account.ensureAuthenticated(); return json(res, 200, { ok: true, ...account.state() }); }
    catch { return json(res, 401, { ok: false, ...account.state(), error: 'Sign in and verify your email code.' }); }
  }
  if (req.method === 'POST' && /^\/api\/account\/(register|login|verify|resend|logout)$/.test(url.pathname)) {
    const action = url.pathname.split('/').pop();
    try {
      if(['register','login','logout'].includes(action))originalEjection.clear();
      const result=await account[action](await body(req));
      if(action==='logout'){deviceLeaseUntil=0;wasAuthenticated=false;await device?.stop();}
      else if(result.authenticated){wasAuthenticated=true;await resumeDeviceChecks('login');}
      return json(res,200,{ok:true,...result});
    }
    catch (error) { return json(res, 403, { ok: false, error: error.message, ...account.state() }); }
  }
  if (req.method === 'POST' && /^\/api\/installation\/(revoke|resume)$/.test(url.pathname)) {
    try {
      const action = url.pathname.endsWith('/revoke') ? 'revokeInstallation' : 'resumeInstallation';
      const result=await account[action]();
      if(action==='revokeInstallation'){originalEjection.clear();deviceLeaseUntil=0;await device?.stop();}
      else await resumeDeviceChecks('login');
      return json(res,200,result);
    } catch (error) { return json(res, 403, { ok: false, error: error.message }); }
  }
  if(req.method==='POST'&&url.pathname==='/api/review/repository-control'){
    await account.verifyEntitlement();const input=await body(req);
    if(input.action==='pause')repositoryReview.pause();else if(input.action==='resume')repositoryReview.resume();else return json(res,400,{ok:false,error:'Choose pause or resume.'});
    return json(res,200,{ok:true,repositoryJob:repositoryReview.state()});
  }
  if (req.method === 'GET' && url.pathname === '/api/status') {
    await refreshProtection();
    try { await account.resume(); } catch { /* unavailable secure storage or expired remote session stays signed out */ }
    const authenticated=account.state().authenticated;
    await resumeDeviceChecks(authenticated&&!wasAuthenticated?'login':'resume');
    wasAuthenticated=authenticated;
    return json(res, 200, { ok: true, ...status() });
  }
  if (req.method === 'POST' && url.pathname === '/api/installation/health') {
    try {
      const input = await body(req), platform = { darwin: 'macos', win32: 'windows', linux: 'linux' }[process.platform];
      return json(res, 200, await account.reportHealth({ ...input, product: 'scripture-armor', platform }));
    } catch (error) { return json(res, 403, { ok: false, error: error.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/activate') {
    const input = await body(req);
    try { await account.ensureAuthenticated(); } catch { return json(res, 401, { ok: false, error: 'Sign in and verify your email code before activation.' }); }
    if (input.acceptTerms !== true || input.confirmMigration !== true) return json(res, 400, { ok: false, error: 'activation requires terms and migration confirmation' });
    try { await account.reserveInstallation(); }
    catch (error) { return json(res, error.status === 409 ? 409 : 403, { ok: false, error: error.message }); }
    const currentIdentity = loadIdentity(identityDir);
    const alreadyActive = Boolean(currentIdentity && hasCurrentAcceptance(identityDir, 'owner') && hasPaidActivation(identityDir, currentIdentity));
    let activated;
    try {
      if (alreadyActive) await account.verifyEntitlement();
      activated = await activateArmor({
        input,
        alreadyActive,
        verifyEntitlement: () => account.verifyEntitlement(),
        ensureIdentity: () => loadIdentity(identityDir) || createIdentity(identityDir, input.label || os.hostname()),
        acceptTerms: () => { if (!hasCurrentAcceptance(identityDir, 'owner')) recordAcceptance(identityDir, 'owner'); },
        migrateCredentials: () => migrationManifest ? migrateCredentials({ identityDir, manifestFile: migrationManifest, allowPlaintextBackup: input.allowPlaintextBackup === true }) : { imported: [] },
        recordFeed: ({ migrated }) => feed('activation', 'Scripture Armor activated', { migrated }),
        recordPaidActivation: (identity, entitlement) => recordPaidActivation(identityDir, identity, entitlement),
      });
    } catch (error) { return json(res, /terms and migration/.test(error.message) ? 400 : 403, { ok: false, error: error.message }); }
    await resumeDeviceChecks('activation');
    return json(res, 200, { ok: true, activated: true, migrated: activated.migrated, entitlement: activated.entitlement });
  }
  if (req.method === 'POST' && url.pathname === '/api/review/upload') {
    try {await account.verifyEntitlement();} catch {return json(res,403,{ok:false,error:'Sign in and activate before file review.'});}
    if(!status().activated)return json(res,409,{ok:false,error:'Activate Scripture Armor first.'});
    if(!/^application\/octet-stream(?:;|$)/i.test(req.headers['content-type']||''))return json(res,415,{ok:false,error:'Upload one file as binary data.'});
    let name;try{name=decodeURIComponent(String(req.headers['x-armor-filename']||''));}catch{return json(res,400,{ok:false,error:'Invalid file name.'});}
    if(!name||name.length>256||name!==path.basename(name)||/[\0\r\n]/.test(name)||/^(?:identity\.json|\.env(?:\..*)?)$|\.(?:pem|p12|key)$/i.test(name))return json(res,400,{ok:false,error:'Choose a review file, not a private key or credential store.'});
    const chunks=[];let count=0;
    for await(const chunk of req){count+=chunk.length;if(count>16*1024*1024)return json(res,413,{ok:false,error:'The single-file limit is 16 MiB.'});chunks.push(chunk);}
    const upload=Buffer.concat(chunks);
    try {
      if(!await (options.deviceResources||deviceResources)(identityDir))return json(res,503,{ok:false,error:'Review paused to preserve memory and disk headroom.'});
      await device?.stop();
      const result=await exclusiveAnalysis(async()=>{
        return reviewUploadedFile(upload,name,{readRoots:reviewToolRoots(upload,name),protectedRoots:[identityDir,identityDir+'.installation']});
      });
      feed('file-review',`Sandbox review of ${name}: ${result.disposition}, danger ${result.risk.level}. Uploaded content was not executed.`);
      return json(res,200,{ok:true,review:result});
    }finally{upload.fill(0);for(const chunk of chunks)chunk.fill(0);device?.start('resume');}
  }
  if(req.method==='POST'&&url.pathname==='/api/review/link') {
    try{await account.verifyEntitlement();}catch{return json(res,403,{ok:false,error:'Sign in and activate before link review.'});}
    if(!status().activated)return json(res,409,{ok:false,error:'Activate Scripture Armor first.'});
    const input=await body(req);
    return reviewLinkResponse(input,res);
  }
  if (req.method === 'POST' && url.pathname === '/api/device/scan') {
    if(!device)return json(res,503,{ok:false,error:'Automatic device scanning is not enabled in this runtime.'});
    await resumeDeviceChecks('manual');
    if(!account.state().authenticated||Date.now()>=deviceLeaseUntil)return json(res,403,{ok:false,error:'Sign in and activate this installation before analysis.'});
    return json(res,202,{ok:true,deviceScan:device.state()});
  }
  if (req.method === 'POST' && url.pathname === '/api/scan') {
    try { await account.verifyEntitlement(); } catch (error) { return json(res, account.state().authenticated ? 403 : 401, { ok: false, error: error.message || 'A verified account and current membership are required.' }); }
    if (!status().activated) return json(res, 409, { ok: false, error: 'activate Scripture Armor first' });
    const input = await body(req);
    const targetState = safeTarget(input.path), target = targetState.path;
    const {rea,cls,record} = await exclusiveAnalysis(async()=>{
      const rea=await runRea(target);return {rea,...await analyzeDashboardFile(target)};
    });
    feed('scan', `Scanned ${path.basename(target)}: Armor ${record.verdict}, REA ${rea.verdict}`, { path: target, class: cls, verdict: record.verdict, rea: rea.verdict });
    return json(res, 200, { ok: true, class: cls, record, rea });
  }
  if (req.method === 'POST' && url.pathname === '/api/clean') {
    try { await account.verifyEntitlement(); } catch (error) { return json(res, account.state().authenticated ? 403 : 401, { ok: false, error: error.message || 'A verified account and current membership are required.' }); }
    if (!status().activated) return json(res, 409, { ok: false, error: 'activate Scripture Armor first' });
    const input = await body(req);
    if (input.confirm !== 'QUARANTINE') return json(res, 400, { ok: false, error: 'clean requires QUARANTINE confirmation' });
    const targetState = safeTarget(input.path), target = targetState.path;
    const {rea,cls,record} = await exclusiveAnalysis(async()=>{
      const rea=await runRea(target);return {rea,...await analyzeDashboardFile(target)};
    });
    if ((record.verdict === 'pass' || record.verdict === 'not-applicable') && rea.verdict === 'clean') return json(res, 409, { ok: false, error: 'clean refused: current Armor and REA scans found nothing to quarantine', record, rea });
    fs.mkdirSync(quarantineDir, { recursive: true, mode: 0o700 });
    sameExternalFile(targetState, { identityDir });
    const destination = path.join(quarantineDir, `${Date.now()}-${path.basename(target)}`);
    fs.renameSync(target, destination);
    feed('clean', `Quarantined ${path.basename(target)}`, { path: target, quarantine: destination, class: cls, verdict: record.verdict });
    return json(res, 200, { ok: true, quarantined: true, original: target, destination, record, rea });
  }
  return json(res, 404, { ok: false, error: 'not found' });
}

const logo = (() => { try { return fs.readFileSync(path.join(HERE, 'ui', 'scripture-armor-crest-ronin.png')).toString('base64'); } catch { return ''; } })();
const html = renderArmorDashboard({ token, logo, termsText: TERMS_TEXT, checkout: armorCheckout });

let mutationBusy = false;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    const localOrigin = `http://127.0.0.1:${server.address()?.port}`;
    if (req.headers.host !== new URL(localOrigin).host) return json(res, 403, { ok: false, error: 'invalid local host' });
    if (req.method === 'POST') {
      if (req.headers.origin !== localOrigin || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')) return json(res, 403, { ok: false, error: 'local origin required' });
      if (mutationBusy) return json(res, 409, { ok: false, error: 'Wait for the current request to finish.' });
      mutationBusy = true;
      try { return await api(req, res, url); } finally { mutationBusy = false; }
    }
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' || url.pathname !== '/') { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'" });
    res.end(html);
  } catch (error) { json(res, 500, { ok: false, error: error.message }); }
});
server.on('listening',()=>device?.start('installation'));
server.on('close',()=>{repositoryReview.close();void device?.stop();});
return server;
}

if (process.argv[1] && canonicalPath(process.argv[1]) === canonicalPath(fileURLToPath(import.meta.url))) {
  if(fs.existsSync(path.join(HERE,'BUNDLE.json'))) process.env.SCRIPTURE_GHIDRA_HOME=preparePackagedAnalysisRuntime({bundleRoot:HERE});
  process.env._JAVA_OPTIONS='-Xmx512m -XX:ActiveProcessorCount=1 -XX:ParallelGCThreads=1 -XX:ConcGCThreads=1';
  const args = process.argv.slice(2);
  const option = (name, fallback) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; };
  const port = Number(option('--port', process.env.SCRIPTURE_ARMOR_UI_PORT || 8788));
  const server = createArmorDashboard({ deviceProtection:true, nativeReviewToken:process.env.SCRIPTURE_ARMOR_NATIVE_REVIEW_TOKEN||null, sessionStore:createAccountSessionStore(), identityDir: option('--identity-dir', defaultIdentityDir()), migrationManifest: option('--migration-manifest', process.env.SCRIPTURE_ARMOR_MIGRATION_MANIFEST || null) });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Scripture Armor UI: http://127.0.0.1:${server.address().port}/`);
    console.log('Loopback only. The API requires this process\'s one-time token.');
  });
}
