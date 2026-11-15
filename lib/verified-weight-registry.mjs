// Local verification history, never weight admission, training, or a credential store.
import {mkdir,readFile,writeFile,rename,realpath,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
const hash=x=>createHash('sha256').update(x).digest('hex');
const canonical=x=>JSON.stringify(x,Object.keys(x).sort());
async function fileBinding(path,maxBytes){
 const resolved=await realpath(path),before=await stat(resolved);
 if(!before.isFile()||before.size<1||before.size>maxBytes)throw Error('weight registry file budget');
 const h=createHash('sha256');for await(const chunk of createReadStream(resolved))h.update(chunk);
 const after=await stat(resolved);if(after.size!==before.size||after.mtimeMs!==before.mtimeMs)throw Error('weight registry file changed');
 return {path:resolved,bytes:before.size,sha256:h.digest('hex')};
}
function identity({checkpointSha256,configSha256,runtimeId,runtimeVersion,architecture,sourceHashes,scope}){
 if(!/^[a-f0-9]{64}$/.test(checkpointSha256??'')||!/^[a-f0-9]{64}$/.test(configSha256??''))throw Error('weight registry requires checkpoint/config hashes');
 if(![runtimeId,runtimeVersion,architecture,scope].every(x=>typeof x==='string'&&x.length>0&&x.length<=160))throw Error('weight registry runtime/scope invalid');
 if(!Array.isArray(sourceHashes)||!sourceHashes.length||sourceHashes.length>16||sourceHashes.some(x=>!/^[a-f0-9]{64}$/.test(x)))throw Error('weight registry source hashes invalid');
 return {checkpointSha256,configSha256,runtimeId,runtimeVersion,architecture,sourceHashes:[...sourceHashes].sort(),scope};
}
export function weightVerificationKey(details){return hash(canonical(identity(details)));}
export async function recordWeightVerification({directory,checkpointPath,configPath,evidencePath,evidenceSha256,...details}){
 const id=identity(details),key=weightVerificationKey(id);
 const checkpoint=await fileBinding(checkpointPath,256*1024*1024),config=await fileBinding(configPath,1024*1024),evidence=await fileBinding(evidencePath,1024*1024);
 if(checkpoint.sha256!==id.checkpointSha256||config.sha256!==id.configSha256||evidence.sha256!==evidenceSha256)throw Error('weight registry binding mismatch');
 const parsed=JSON.parse(await readFile(evidence.path,'utf8'));
 if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('weight registry evidence must be an object');
 const record={schema:'kingmaker.weight-verification-log/1',key,identity:id,checkpoint,config,evidence,recordedAt:new Date().toISOString(),admissionGranted:false,meaning:'Caller-supplied scoped execution evidence; not independent security, quality, license or general compatibility certification.'};
 await mkdir(directory,{recursive:true,mode:0o700});const root=await realpath(directory),path=join(root,key+'.json'),temp=join(root,'.'+randomUUID()+'.tmp');
 try{await writeFile(temp,JSON.stringify(record,null,2),{flag:'wx',mode:0o600});await rename(temp,path);}catch(e){throw e;}
 return {key,path,record};
}
export async function findWeightVerification({directory,...details}){
 const key=weightVerificationKey(details);let record;
 try{const path=join(directory,key+'.json');if((await stat(path)).size>65536)return null;record=JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}
 if(record.schema!=='kingmaker.weight-verification-log/1'||record.key!==key||weightVerificationKey(record.identity)!==key||record.admissionGranted!==false||record.checkpoint?.sha256!==record.identity.checkpointSha256||record.config?.sha256!==record.identity.configSha256)return null;
 try{for(const [name,max] of [['checkpoint',256*1024*1024],['config',1024*1024],['evidence',1024*1024]]){const actual=await fileBinding(record[name].path,max);if(actual.sha256!==record[name].sha256||actual.bytes!==record[name].bytes)return null;}}catch{return null;}
 return {key,record,reusableEvidence:true,admissionGranted:false};
}
