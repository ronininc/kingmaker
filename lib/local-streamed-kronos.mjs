// Explicit admitted local adapter. No routing fallback, installation, downloads or secret lookup.
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {recordWeightVerification} from './verified-weight-registry.mjs';
const script=fileURLToPath(new URL('../scripts/run-local-streamed-kronos.py',import.meta.url));
export async function runLocalStreamedKronos({python,request,workDir,registryDir,signal}={}){
 if(signal?.aborted)throw Error('streamed runtime canceled');
 if(request?.admission?.enabled!==true)throw Error('streamed runtime explicit admission required');
 const encoded=JSON.stringify(request);if(Buffer.byteLength(encoded)>65536)throw Error('streamed runtime request budget');
 await realpath(python);const executable=resolve(python),root=await realpath(workDir),dir=await mkdtemp(join(root,'streamed-request-'));let result;
 try{
  const path=join(dir,'request.json');await writeFile(path,encoded,{mode:0o600,flag:'wx'});
  result=await new Promise((resolve,reject)=>{
   const child=spawn(executable,['-I',script,'--request',path],{stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,HOME:process.env.HOME,HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1'}});
   let out='',err='',failure=null,killTimer;
   const stop=message=>{if(failure)return;failure=new Error(message);child.kill('SIGTERM');killTimer=setTimeout(()=>child.kill('SIGKILL'),1000);};
   const abort=()=>stop('streamed runtime canceled');signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
   const timeout=setTimeout(()=>stop('streamed runtime hard deadline'),35000);
   child.stdout.on('data',b=>{if(Buffer.byteLength(out)+b.length>1024*1024)stop('streamed runtime response budget');else out+=b;});
   child.stderr.on('data',b=>{err=(err+b).slice(-2000);});
   child.on('error',e=>{failure=e;});
   child.on('close',code=>{clearTimeout(timeout);clearTimeout(killTimer);signal?.removeEventListener('abort',abort);if(failure)return reject(failure);if(code!==0)return reject(new Error('streamed runtime failed; no verification recorded'));try{resolve(JSON.parse(out));}catch{reject(Error('streamed runtime invalid receipt'));}});
  });
  const pins=request.admission.pins;
  if(result.schema!=='kingmaker.local-streamed-kronos-result/1'||result.ok!==true||result.cleanup_completed!==true||result.mode!==request.mode||result.counts?.live_weight_bytes!==0||!result.runtime?.torch||!/^[a-f0-9]{64}$/.test(result.input_sha256??''))throw Error('streamed runtime incomplete receipt');
  for(const key of ['checkpoint_sha256','config_sha256','kronos_py_sha256','module_py_sha256'])if(result.input_bindings?.[key]!==pins[key])throw Error('streamed runtime receipt binding mismatch');
  if(signal?.aborted)throw Error('streamed runtime canceled');
  if(registryDir){
   // Evidence contains hashes, shapes and metrics, never original values or model outputs.
   const {outputs,...evidence}=result;const bytes=JSON.stringify(evidence,null,2),evidencePath=join(root,`streamed-evidence-${createHash('sha256').update(bytes).digest('hex')}.json`);
   try{await writeFile(evidencePath,bytes,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}
   result.verificationLog=await recordWeightVerification({directory:registryDir,checkpointPath:request.paths.checkpoint,configPath:request.paths.config,evidencePath,evidenceSha256:createHash('sha256').update(bytes).digest('hex'),checkpointSha256:pins.checkpoint_sha256,configSha256:pins.config_sha256,runtimeId:'pytorch-cpu-kronos-streamed',runtimeVersion:result.runtime.torch,architecture:request.mode==='forecast'?'Kronos-small':'KronosTokenizer-base',sourceHashes:[pins.kronos_py_sha256,pins.module_py_sha256],scope:`${request.mode}-admitted-local-forward`});
  }
  return result;
 }finally{await rm(dir,{recursive:true,force:true});}
}
// Explicit assembly seam; caller owns activation. Unknown OS pressure fails closed.
export async function createIdleKronosVerification({python,request,workDir,registryDir,observe,busy,log}={}){
 const {createIdleWeightChurn,createMacIdleObserver}=await import('./idle-weight-churn.mjs');
 return createIdleWeightChurn({observe:observe??createMacIdleObserver({directory:workDir}),busy,log,
  run:({signal,localOnly,allowDownloads})=>{
   if(localOnly!==true||allowDownloads!==false)throw Error('idle verification must stay local');
   return runLocalStreamedKronos({python,request,workDir,registryDir,signal});
  }});
}
