// Read-only presentation of conducted results. Never executes an artifact or opens URLs.
import {realpath,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {relative,isAbsolute,basename,extname} from 'node:path';
import {pathToFileURL} from 'node:url';
export async function presentCreation(result){
 const runs=result?.runs??[];
 if(!Array.isArray(runs)||runs.length>8)throw new Error('presentation run budget');
 const nodes=[];
 for(const run of runs){
  const node={id:run.id,status:run.result?.status??'unknown',artifacts:[]};nodes.push(node);
  if(node.status!=='completed')continue;
  const root=await realpath(run.workDir),seen=new Set();
  for(const output of Object.values(run.result?.outputs??{})){
   const record=output?.ok===true?output.record:null;
   if(record?.status!=='completed')continue;
   const files=record.schema==='kingmaker.native-asset-skill/1'?record.artifacts:record.deliverable?[record.deliverable]:[];
   if(!Array.isArray(files)||files.length>128)throw new Error('presentation artifact budget');
   for(const file of files){
    if(seen.has(file.path))continue;seen.add(file.path);
    const path=await realpath(file.path),rel=relative(root,path);
    if(!rel||rel.startsWith('..')||isAbsolute(rel))throw new Error('presentation artifact outside run');
    const info=await stat(path);
    if(!info.isFile()||info.size<1||info.size>256*1024*1024||! /^[a-f0-9]{64}$/.test(file.sha256??''))throw new Error('presentation artifact invalid');
    const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);
    if(hash.digest('hex')!==file.sha256)throw new Error('presentation artifact changed');
    const ext=extname(path).toLowerCase();
    node.artifacts.push({name:basename(path),uri:pathToFileURL(path).href,sha256:file.sha256,bytes:info.size,kind:ext==='.mp4'?'video':ext==='.blend'?'editable-project':['.png','.jpg','.jpeg'].includes(ext)?'image':'file'});
   }
  }
 }
 return {schema:'kingmaker.creation-presentation/1',status:result.status,nodes,edges:nodes.slice(1).map((n,i)=>({from:nodes[i].id,to:n.id})),qualityCertified:false,limitations:['Sequential execution chart, not physical prediction or a digital twin.','Local artifact links require an explicitly supported UI consumer; this event does not prove native embedding.']};
}
