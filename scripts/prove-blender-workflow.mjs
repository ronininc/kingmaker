import {compileDemonstration,executeWorkflow} from '../lib/blender-workflow.mjs';
import {writeFile} from 'node:fs/promises';
const workDir=process.argv[2];
const transcript='Create a cube named Panel at [0,0,0] with scale [1,0.15,1.4]. Bevel Panel edges width 0.04 with 3 segments. Give Panel color [0.08,0.16,0.22], roughness 0.35, metallic 0.7. Position camera at [5,-7,4], target [0,0,0], lens 50. Add an area light named Key at [2,-4,5], energy 700 and size 4.';
const method=await compileDemonstration({transcript,source:{reference:'local:original-demonstration-fixture',rights:'user-authored',rightsBasis:'Original fixture authored for this local verification, not a fetched tutorial.'},compose:async({transcript,contract})=>{
 const schema='create {op,id,kind,position,scale}; bevel {op,id,width,segments}; material {op,id,color,roughness,metallic}; camera {op,position,target,lens}; light {op,id,position,energy,size}';
 const r=await fetch('http://127.0.0.1:11434/api/generate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'qwen3:1.7b',prompt:`${contract} Exact schema: {schema:"kingmaker.blender-workflow/1",operations:[...]}. Allowed operation fields: ${schema}. Transcript: ${transcript}`,stream:false,format:'json',think:false,keep_alive:0,options:{temperature:0,num_ctx:4096,num_predict:1200}}),signal:AbortSignal.timeout(90000)});
 const result=await r.json();if(!result.done)throw Error('incomplete generation');await writeFile(workDir+'/model-response.json',JSON.stringify(result));return JSON.parse(result.response);
}});
await writeFile(workDir+'/method.json',JSON.stringify(method,null,2));
const prepared=await executeWorkflow({method,workDir,blender:'/Applications/Blender.app/Contents/MacOS/Blender',render:false});
const final=await executeWorkflow({method:{schema:'kingmaker.blender-workflow/1',operations:[{op:'transform',id:'Panel',position:[.2,0,0],rotation:[0,0,10],scale:[1,.15,1.4]}]},workDir,project:prepared.project,blender:'/Applications/Blender.app/Contents/MacOS/Blender',render:true,device:'AUTO'});
await writeFile(workDir+'/proof.json',JSON.stringify({transcript,prepared,final},null,2));console.log(JSON.stringify({prepared:prepared.state,final:final.state,render:final.directory+'/render.png'},null,2));
