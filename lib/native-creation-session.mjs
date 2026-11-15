// Owner-session adapter. Speech may propose; only exact local typed review can execute.
import {cmdNativeCreate} from './native-creation-cli.mjs';
export function createNativeCreationSession({workDir,now=Date.now,command=cmdNativeCreate}={}) {
 let pending=null,busy=false;
 async function handle(text,{typed=false,local=false}={}) {
  const s=String(text).trim();
  if(!/^native (?:create|approve|cancel)\b/i.test(s))return null;
  if(busy)return {handled:true,message:'A native creation is running. Wait for its verified result.'};
  if(/^native cancel$/i.test(s)){pending=null;return {handled:true,message:'Native creation proposal canceled.'};}
  const approve=s.match(/^native approve ([a-f0-9]{64})$/i);
  if(approve){
   if(!typed||!local)return {handled:true,message:'Native creation approval must be typed in the local Kingmaker window or terminal. Speech and remote turns cannot approve.'};
   if(!pending||now()>pending.expires||approve[1]!==pending.hash){pending=null;return {handled:true,message:'No matching current proposal. Ask for a new native creation preview.'};}
   const p=pending;pending=null;busy=true;
   try{let result;await command([...p.args,'--approve',p.hash],{write:r=>result=r});return {handled:true,result,message:result.status==='completed'?`Native creation completed. Verified artifacts are in ${result.runs.map(r=>r.workDir).join(', ')}. Procedural output only, not production-quality certified.`:`Native creation ${result.status}: ${result.reason??'not completed'}`};}
   finally{busy=false;}
  }
  const request=s.match(/^native create\s+(.+)$/is)?.[1];
  if(!request)return {handled:true,message:'Use native create followed by your request, or type native approve followed by the exact review hash.'};
  pending=null;busy=true;
  try {
   const args=['--request',request,'--work-dir',workDir];let review;
   await command(args,{write:r=>review=r});
   pending={args,hash:review.reviewSha256,expires:now()+5*60*1000};
   return {handled:true,review,message:`Native creation preview: ${request}. Destination: ${review.workDir}. Methods: ${review.proposal.steps.map(s=>s.methodId).join(', ')}. Procedural proof only. No files created. To approve within five minutes, type in this local window: native approve ${review.reviewSha256}`};
  } finally {busy=false;}
 }
 return {handle};
}
