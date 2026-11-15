// Local asset admission only. No download, installation, authentication or automatic import.
import { realpath, statfs, open, mkdtemp, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, sep, isAbsolute, extname, join } from 'node:path';
const fail = s => { throw new Error(`film-assets: ${s}`); };
const str = (x,n=500) => typeof x==='string' && x.trim() && x.length<=n && !/[\x00-\x1f]/.test(x);
const idOK = x => str(x,80) && /^[A-Za-z0-9_-]+$/.test(x);
const positive = x => Number.isSafeInteger(x) && x>0;
const formats = { mesh:['.glb','.fbx'], texture:['.png','.jpg','.jpeg','.exr'], hdri:['.hdr','.exr'], motion:['.fbx'] };
export function validateAssetManifest(raw) {
  if (!raw || raw.schema!=='kingmaker.asset-manifest/1' || !Array.isArray(raw.assets) || !raw.assets.length || raw.assets.length>128) fail('invalid manifest');
  const ids=new Set();
  const assets=raw.assets.map(a=>{
    if(!a || !idOK(a.id) || ids.has(a.id)) fail('invalid or duplicate asset id'); ids.add(a.id);
    if(!Object.hasOwn(formats,a.kind)) fail('unsupported asset kind');
    if(!str(a.path,512) || isAbsolute(a.path) || a.path.includes('\\') || a.path.split('/').some(x=>!x || x==='.' || x==='..') || !formats[a.kind].includes(extname(a.path).toLowerCase())) fail('unsafe or unsupported asset path');
    if(!positive(a.bytes) || !/^[a-f0-9]{64}$/.test(a.sha256)) fail('exact size and SHA256 required');
    if(!str(a.title) || !str(a.author)) fail('title and author required');
    let source;try{source=new URL(a.source);}catch{fail('source URL required');}
    if(source.protocol!=='https:' || source.username || source.password) fail('public HTTPS source URL required');
    // Other licenses require separate reviewed policy, not model-authored approval flags.
    if(!['CC0-1.0','CC-BY-4.0'].includes(a.license)) fail('license not admitted; review separately');
    if(!str(a.changes)) fail('state modifications, or none');
    const dependencies=a.dependencies ?? [];
    if(!Array.isArray(dependencies) || dependencies.length>128 || dependencies.some(x=>!idOK(x)) || new Set(dependencies).size!==dependencies.length) fail('invalid dependencies');
    return {id:a.id,kind:a.kind,path:a.path,bytes:a.bytes,sha256:a.sha256,title:a.title,author:a.author,source:source.href,license:a.license,licenseUrl:a.license==='CC0-1.0'?'https://creativecommons.org/publicdomain/zero/1.0/':'https://creativecommons.org/licenses/by/4.0/',changes:a.changes,dependencies:[...dependencies]};
  });
  const byId=new Map(assets.map(a=>[a.id,a]));
  const active=new Set(),visited=new Set();
  function visit(id){if(active.has(id)) fail('dependency cycle');if(visited.has(id))return;const a=byId.get(id);if(!a)fail('missing dependency');active.add(id);a.dependencies.forEach(visit);active.delete(id);visited.add(id);}
  assets.forEach(a=>visit(a.id));
  return {schema:raw.schema,assets};
}
export function assetAttribution(manifest) {
  return validateAssetManifest(manifest).assets.map(a=>`${a.title} — ${a.author}\nSource: ${a.source}\nLicense: ${a.license} (${a.licenseUrl})\nChanges: ${a.changes}`).join('\n\n')+'\n';
}
export async function admitLocalAssets({manifest,assetRoot,maxBytes=64*1024*1024}={}) {
  const checked=validateAssetManifest(manifest);
  if(!positive(maxBytes) || maxBytes>1024*1024*1024) fail('invalid admission budget');
  if(checked.assets.reduce((n,a)=>n+a.bytes,0)>maxBytes) fail('manifest exceeds byte budget');
  const root=await realpath(assetRoot), files=[];
  for(const a of checked.assets){
    const path=await realpath(resolve(root,a.path));
    if(!path.startsWith(root+sep)) fail('asset escapes root');
    const file=await open(path,'r');
    try {
      const before=await file.stat();
      if(!before.isFile() || before.size!==a.bytes) fail('asset size/type mismatch');
      const hash=createHash('sha256');
      for await(const chunk of file.createReadStream({autoClose:false}))hash.update(chunk);
      const after=await file.stat();
      if(before.size!==after.size || before.mtimeMs!==after.mtimeMs || hash.digest('hex')!==a.sha256)fail('asset digest changed or mismatched');
    } finally {await file.close();}
    files.push({...a,absolutePath:path});
  }
  return {status:'inputs-verified',assetRoot:root,manifest:checked,files,attribution:assetAttribution(checked),limitations:['License metadata is a recorded claim, not independent proof of rights.','File bytes verified; format validity and visual quality are not established.','Adapter must recheck digest immediately before import; files can change after admission.']};
}
export function validateAssetJob(raw,manifest) {
  const assets=validateAssetManifest(manifest).assets;
  const byId=new Map(assets.map(a=>[a.id,a]));
  if(raw?.kind==='mpfb-rigify'){
    if(raw.rig!=='rigify' || raw.preset!=='neutral-adult') fail('allowlisted MPFB preset and rigify rig required');
    // Presets are mapped to trusted local scripts by the adapter; never Python from the model.
    return {kind:raw.kind,preset:raw.preset,rig:'rigify'};
  }
  if(raw?.kind==='pbr-material'){
    const channels=['baseColor','normal','roughness','metallic','displacement'];
    if(!raw.maps || typeof raw.maps!=='object' || !raw.maps.baseColor || Object.keys(raw.maps).some(x=>!channels.includes(x))) fail('invalid PBR maps');
    const maps={};
    for(const [channel,id] of Object.entries(raw.maps)){
      if(byId.get(id)?.kind!=='texture') fail('PBR map must reference an admitted texture');
      maps[channel]={assetId:id,colorSpace:channel==='baseColor'?'sRGB':'Non-Color'};
    }
    if(raw.normalConvention && !['OpenGL','DirectX'].includes(raw.normalConvention))fail('invalid normal convention');
    return {kind:raw.kind,maps,normalConvention:raw.normalConvention??'OpenGL'};
  }
  fail('unsupported asset adapter job');
}
export async function prepareAssetJob({request,manifest,assetRoot,maxBytes}={}) {
  const job=validateAssetJob(request,manifest);
  const inputs=await admitLocalAssets({manifest,assetRoot,maxBytes});
  return {status:'prepared-not-executed',job,inputs,requiredAdapter:job.kind,qualityCertified:false};
}
// Caller injects an explicitly authorized adapter; no PATH discovery or implicit add-on activation.
// Adapter must bound subprocess time/disk, use trusted scripts and recheck input hashes before import.
// It returns a new asset manifest whose bytes live under the unique output directory.
export async function runAssetAdapter({prepared,adapter,outputRoot,maxOutputBytes=64*1024*1024}={}) {
  if(typeof adapter!=='function')fail('explicit authorized adapter required');
  if(prepared?.status!=='prepared-not-executed')fail('prepared input required');
  if(!positive(maxOutputBytes)||maxOutputBytes>1024*1024*1024)fail('invalid output budget');
  // Re-admit supplied inputs rather than trusting a fabricated status object.
  const manifest=validateAssetManifest(prepared.inputs?.manifest);
  const job=validateAssetJob(prepared.job.kind==='pbr-material'?{kind:prepared.job.kind,maps:Object.fromEntries(Object.entries(prepared.job.maps).map(([k,v])=>[k,v.assetId])),normalConvention:prepared.job.normalConvention}:prepared.job,manifest);
  const inputs=await admitLocalAssets({manifest,assetRoot:prepared.inputs.assetRoot,maxBytes:64*1024*1024});
  const root=await realpath(outputRoot), disk=await statfs(root);
  if(disk.bavail*disk.bsize<maxOutputBytes+256*1024*1024)fail('insufficient space for output budget plus reserve');
  const outputDir=await mkdtemp(join(root,'asset-job-'));
  const result=await adapter({job,inputs,outputDir,maxOutputBytes});
  const outputs=await admitLocalAssets({manifest:result?.manifest,assetRoot:outputDir,maxBytes:maxOutputBytes});
  await writeFile(join(outputDir,'ATTRIBUTION.txt'),inputs.attribution+'\n'+outputs.attribution);
  return {status:'adapter-artifacts-verified',outputDir,outputs,qualityCertified:false,limitations:['Artifact integrity is not character rig, material, animation or render validation.','No full scene integration or cinematic quality certification.']};
}
