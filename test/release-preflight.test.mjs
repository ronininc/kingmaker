import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { parseArgs, preflight } from '../scripts/release-preflight.mjs';
import { REQUIRED_RUNTIMES } from '../scripts/release-parts.mjs';
import { ESSENTIAL } from '../lib/payload.mjs';
import { signManifestBytes } from '../lib/release-signing.mjs';

const sha = (x) => createHash('sha256').update(x).digest('hex');
const sourceCommit='a'.repeat(40), engineCommit='b'.repeat(40), leaf='C'.repeat(40);
const signer='Developer ID Application: Example';
const result = (status, stdout='', stderr='') => ({status,stdout,stderr});
const cannotPrint='sensitive synthetic marker';
const host = {platform:'darwin',arch:'arm64'};
const checks = (o) => Object.fromEntries(o.checks.map((c) => [c.id,c.status]));
const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'km-release-preflight-'));
  t.after(() => rmSync(root,{recursive:true,force:true}));
  const options={source:join(root,'source'),sourceCommit,engineSource:join(root,'engine-source'),engineCommit,
    app:join(root,'Kingmaker.app'),buildReceipt:join(root,'build-receipt.json'),scratch:join(root,'scratch'),staging:join(root,'staging'),checkNotary:true};
  for (const d of ['source','engineSource','scratch','staging']) mkdirSync(options[d],{recursive:true});
  const put = (file, content) => { mkdirSync(dirname(file),{recursive:true}); writeFileSync(file, content); };
  const json = (file,obj) => put(file,JSON.stringify(obj)+'\n');
  json(join(options.source,'package.json'),{version:'4.5.3'});
  const resources=join(options.app,'Contents','Resources');
  for (const n of REQUIRED_RUNTIMES) mkdirSync(join(resources,n),{recursive:true});
  put(join(resources,'kingmaker-runtime','app','dist','index.html'),'fixture');
  const runtime=join(resources,'sol-ghost');
  const files=ESSENTIAL.map((p) => {put(join(runtime,p),'fixture'); return {path:p,sha256:sha('fixture'),size:7};});
  const note={schema:'kingmaker.payload/1',version:'4.5.3',files};
  json(join(runtime,'payload.json'),note);
  put(join(options.app,'Contents','MacOS','KingmakerEngine'),'signed fixture');
  json(options.buildReceipt,{sourceCommit,engineCommit,appVersion:'4.5.3',engineBuild:'fixture-build',engineSha256:sha('signed fixture')});
  const part={name:'Kingmaker-4.5.3.tar.gz.part01',size:5,sha256:sha('part!')};
  const launcher={name:'Ronin Launcher.app',bundleId:'org.ronininc.launcher',version:'0.3.18',archive:'Ronin-Launcher-0.3.18-arm64.zip',format:'zip',url:null,size:8,sha256:sha('launcher'),required:true,sourceRepo:'example/launcher',sourceCommit:'d'.repeat(40)};
  const manifest={schema:'kingmaker.release/1',tag:'v4.5.3',repo:'example/kingmaker',version:'4.5.3',
    app:{name:'Kingmaker.app',size:part.size,sha256:part.sha256,solomonBuild:'fixture-build'},
    requires:{arch:'arm64',macos:'15.0'},parts:[part],launcher,
    issuance:{tree:{repo:'example/kingmaker',commit:sourceCommit,version:'4.5.3'},
      installer:{repo:'example/kingmaker',commit:sourceCommit,version:'4.5.3'},
      launcher:{repo:launcher.sourceRepo,commit:launcher.sourceCommit,version:launcher.version}}};
  const manifestPath=join(options.staging,'kingmaker-manifest.json');
  const sign=(m)=>{const raw=Buffer.from(JSON.stringify(m)+'\n');put(manifestPath,raw);put(manifestPath+'.sig',signManifestBytes(raw,privateKey));};
  sign(manifest);
  put(join(options.staging,part.name),'part!');
  put(join(options.staging,launcher.archive),'launcher');
  const env={KINGMAKER_SIGN_IDENTITY:signer,KINGMAKER_NOTARY_PROFILE:cannotPrint,KINGMAKER_ENROLL_URL:'https://updates.example',KINGMAKER_ENROLL_CODE:cannotPrint};
  const command=(name,args)=>{
    if (name.endsWith('git')) return result(0,args.includes('status') ? '' : (args[1]===options.source ? sourceCommit : engineCommit));
    if (name.endsWith('codesign')) return result(0,'','Authority=Kingmaker Release\nflags=0x10000(runtime)\n');
    if (name.endsWith('security')) return result(0, '1) '+leaf+' "Kingmaker Release"\n2) '+'E'.repeat(40)+' "'+signer+'"');
    if (name.endsWith('plutil')) return result(0,'{"CFBundleShortVersionString":"4.5.3","KingmakerEngineBuild":"fixture-build"}');
    if (name.endsWith('du')) return result(0,'2048\tignored');
    return result(0,cannotPrint,cannotPrint);
  };
  const deps={env,host,command,pin:{sha1:leaf},publicKey:()=>publicKey.export({format:'pem',type:'spki'}),
    fsCapacity:()=>({bavail:10_000_000,bsize:4096})};
  return {options,deps,manifestPath,manifest,sign,put,runtime,part};
}

test('exact owner-build prerequisites never imply publication or disclose values', async(t)=>{
  const f=fixture(t);
  const o=await preflight(f.options,f.deps);
  assert.equal(o.readyForOwnerBuild,true,JSON.stringify(o));
  assert.equal(o.readyForPublication,false);
  assert.ok(o.publicationBlockers.some((s)=>s.includes('inner app')));
  assert.doesNotMatch(JSON.stringify(o),new RegExp(cannotPrint));
});
test('strict app leaf, capacity and notary are independent gates', async(t)=>{
  const f=fixture(t);
  const command=f.deps.command;
  f.deps.command=(cmd,args)=>args.includes('--verify') ? result(1,'',cannotPrint) : command(cmd,args);
  f.deps.fsCapacity=()=>({bavail:1,bsize:4096});
  f.options.checkNotary=false;
  const o=await preflight(f.options,f.deps);
  assert.equal(o.readyForOwnerBuild,false);
  const c=checks(o);
  for (const k of ['app-code-signature','scratch-capacity','staging-capacity','outer-notary']) assert.equal(c[k],'blocked');
  assert.equal(c['developer-id'],'pass');
  assert.doesNotMatch(JSON.stringify(o),new RegExp(cannotPrint));
});
test('valid detached signature does not cover altered staged files or wrong source', async(t)=>{
  const f=fixture(t);
  f.put(join(f.options.staging,f.part.name),'stale');
  let c=checks(await preflight(f.options,f.deps));
  assert.equal(c['offline-signature'],'pass');
  assert.equal(c['staged-assets'],'blocked');
  f.sign({...f.manifest,issuance:{...f.manifest.issuance,tree:{...f.manifest.issuance.tree,commit:'f'.repeat(40)}}});
  c=checks(await preflight(f.options,f.deps));
  assert.equal(c['offline-signature'],'pass');
  assert.equal(c['manifest-policy'],'blocked');
  f.put(f.manifestPath,'{}');
  c=checks(await preflight(f.options,f.deps));
  assert.equal(c['offline-signature'],'blocked');
});
test('production metadata cannot be inferred from Linux or unconfigured flags', async()=>{
  const called=[];
  const o=await preflight({}, {env:{}, host:{platform:'linux',arch:'x64'}, command:(...a)=>{called.push(a);return result(1);},pin:null});
  assert.equal(o.readyForOwnerBuild,false);
  assert.equal(o.readyForPublication,false);
  assert.equal(checks(o).host,'blocked');
  assert.deepEqual(called,[]);
  assert.throws(()=>parseArgs(['--minimum-free-gib','0']));
  assert.throws(()=>parseArgs(['--key','ignored']));
});

test('host phase can pass before any app, signed manifest, enrollment configuration or notary key read', async (t) => {
  const f=fixture(t);
  rmSync(f.options.app,{recursive:true});
  rmSync(f.options.staging,{recursive:true});
  delete f.options.buildReceipt;
  delete f.deps.env.KINGMAKER_ENROLL_URL;
  delete f.deps.env.KINGMAKER_ENROLL_CODE;
  f.deps.publicKey=()=>{ assert.fail('host must not read even the manifest public key'); };
  f.options.phase='host';
  f.options.checkNotary=false;
  f.options.runtimeDir=join(f.options.source,'runtime');
  f.options.runtimePlan=join(f.options.source,'runtime-plan.json');
  f.put(join(f.options.engineSource,'desktop','run-electron-builder.mjs'),'fixture code');
  const inputs=REQUIRED_RUNTIMES.map((kind,i)=>{
    const file='input-'+i+'.tar.gz';
    f.put(join(f.options.runtimeDir,file),kind);
    return {kind,file,size:Buffer.byteLength(kind),sha256:sha(kind)};
  });
  f.put(f.options.runtimePlan,JSON.stringify({sourceCommit,engineCommit,inputs}));
  const r=await preflight(f.options,f.deps);
  assert.equal(r.phase,'host');
  assert.equal(r.readyForOwnerBuild,true,JSON.stringify(r));
  assert.equal(r.readyForPublication,false);
  assert.equal(checks(r)['outer-notary'],'not-checked');
  assert.ok(!r.checks.some((c)=>['staged-assets','offline-signature','enrollment-config','app-code-signature'].includes(c.id)));
  f.put(join(f.options.runtimeDir,inputs[0].file),'stale bytes');
  const blocked=await preflight(f.options,f.deps);
  assert.equal(blocked.readyForOwnerBuild,false);
  assert.equal(checks(blocked)['runtime-inputs'],'blocked');
  assert.throws(()=>parseArgs(['--phase','unknown']));
  assert.equal(parseArgs(['--phase','host']).phase,'host');
});
