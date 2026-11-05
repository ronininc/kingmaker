// Read-only, commit-pinned repository inspection. Never checkout, install or execute repository content.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fetchPublicBytes,publicReviewURL} from './review-intake.mjs';
export function repositoryReference(input){const u=publicReviewURL(input),m=u.hostname==='github.com'&&/^\/([\w-]+)\/([\w.-]+)\/?$/.exec(u.pathname);return m?{owner:m[1],repo:m[2].replace(/\.git$/,'')}:null;}
export function createRepositoryReview({identityDir,fetchBytes=fetchPublicBytes,analyze,resources=async()=>true,isLicensed=async()=>true,now=Date.now,budgetMs=15*60*1000}={}){
 let current=null,stopped=false,running=false;
 const snapshot=()=>current?{...current.public,attempted:current.cursor,elapsedSeconds:Math.round((now()-current.started)/1000),estimateSeconds:current.public.inventoryComplete&&current.public.scanned?Math.ceil(current.scanMillis/current.public.scanned*(current.files.length-current.cursor)/1000):null}:null;
 const record=entry=>fs.appendFileSync(current.report,JSON.stringify(entry)+'\n',{mode:0o600});
 async function tick(){
  if(running||stopped||!current)return;running=true;
  try{
   if(!await isLicensed()){current.public.state='waiting_for_login';return;}
   if(!await resources()){current.public.state='paused_for_resources';return;}
   if(now()>current.deadline){current.public.state='paused_for_time_budget';return;}
   const c=current,p=c.public,base=`https://api.github.com/repos/${c.ref.owner}/${c.ref.repo}`;
   if(!p.commit){const r=await fetchBytes(base+'/commits/HEAD',{maxBytes:1024*1024}),d=JSON.parse(r.bytes.toString());r.bytes.fill(0);if(!/^[a-f0-9]{40}$/.test(d.sha||'')||!/^[a-f0-9]{40}$/.test(d.commit?.tree?.sha||''))throw Error('Cannot pin repository revision.');p.commit=d.sha;c.trees.push({sha:d.commit.tree.sha,prefix:''});record({type:'revision',repository:p.repository,commit:p.commit});return;}
   if(c.trees.length){
    p.state='inventory';const item=c.trees[0],r=await fetchBytes(base+'/git/trees/'+item.sha,{maxBytes:16*1024*1024}),d=JSON.parse(r.bytes.toString());r.bytes.fill(0);if(!Array.isArray(d.tree)||d.truncated)throw Error('Tree inventory is incomplete; no complete verdict issued.');c.trees.shift();
    for(const e of d.tree){
     if(typeof e.path!=='string'||e.path.startsWith('/')||e.path.split('/').some(s=>s==='..'||s==='.')||/[\0\r\n\\]/.test(e.path)||!/^[a-f0-9]{40}$/.test(e.sha||'')){p.deferred++;record({type:'deferred',path:String(e.path).slice(0,1024),reason:'Unsupported or unsafe tree entry.'});continue;}
     const file={...e,path:item.prefix+e.path};
     if(e.type==='tree')c.trees.push({sha:e.sha,prefix:file.path+'/'});
     else if(e.type==='blob'&&['100644','100755'].includes(e.mode))c.files.push(file);
     else{p.deferred++;record({type:'deferred',path:file.path,reason:'Symlink, submodule or unsupported mode; not followed or executed.'});}
    }
    p.totalFiles=c.files.length;p.inventoryComplete=!c.trees.length;if(p.inventoryComplete)c.scanStarted=now();return;
   }
   if(c.cursor>=c.files.length){p.state=p.deferred?'completed_with_gaps':'completed';p.complete=p.deferred===0;record({type:'summary',...snapshot()});return;}
   p.state='scanning';const fileStarted=now();const file=c.files[c.cursor];p.currentFile=file.path;
   let bytes;
   try{
    const r=await fetchBytes(`https://raw.githubusercontent.com/${c.ref.owner}/${c.ref.repo}/${p.commit}/${file.path.split('/').map(encodeURIComponent).join('/')}`);bytes=r.bytes;
    const blob=crypto.createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');if(blob!==file.sha)throw Error('Content does not match pinned Git blob.');
    const review=await analyze(bytes,path.basename(file.path));
    p.scanned++;if(review.kind==='source'){p.codeFiles++;for(const b of bytes)if(b===10)p.codeLines++;if(bytes.length&&bytes.at(-1)!==10)p.codeLines++;}
    if(review.status==='limited'){p.deferred++;}
    const findings=(review.findings||[]).filter(f=>f.severity!=='info');p.findings+=findings.length;
    const item={type:'file',path:file.path,sha256:review.contentSha256,kind:review.kind,status:review.status,findings,limitations:review.limitations||[]};record(item);
    for(const f of findings){p.recentFindings.push({...f,file:file.path});if(p.recentFindings.length>30)p.recentFindings.shift();}
   }catch(error){p.deferred++;record({type:'deferred',path:file.path,reason:error.message});}
   finally{bytes?.fill(0);c.scanMillis+=now()-fileStarted;c.cursor++;}
  }catch(error){current.public.state='paused_for_error';current.public.error=error.message;}
  finally{running=false;}
 }
 const timer=setInterval(()=>{if(current&&!['completed','completed_with_gaps','paused_for_time_budget','paused_for_error','paused_by_admin'].includes(current.public.state))void tick();},1000);timer.unref();
 return {state:snapshot,tick,
  start(input){if(current&&!['completed','completed_with_gaps'].includes(current.public.state))throw Error('Finish or cancel the current repository review first.');const ref=repositoryReference(input);if(!ref)throw Error('Use a GitHub repository root URL.');
   const id=crypto.randomUUID(),dir=path.join(identityDir,'repository-reports');fs.mkdirSync(dir,{recursive:true,mode:0o700});if(fs.lstatSync(dir).isSymbolicLink()||fs.realpathSync(dir)!==dir)throw Error('Unsafe report directory.');
   current={ref,report:path.join(dir,id+'.jsonl'),files:[],cursor:0,trees:[],started:now(),scanStarted:now(),scanMillis:0,deadline:now()+budgetMs,public:{id,title:`${ref.owner}-${ref.repo} — Repository Security Review`,repository:`${ref.owner}/${ref.repo}`,state:'inventory',commit:null,totalFiles:0,scanned:0,codeFiles:0,codeLines:0,findings:0,deferred:0,inventoryComplete:false,complete:false,recentFindings:[],authority:'device-admin-decides',targetExecuted:false}};fs.writeFileSync(current.report,JSON.stringify({type:'notice',title:current.public.title,text:'Static findings are potential risk vectors, not proof of a breach. No repository code was executed. Owner approval and removal are separate actions.'})+'\n',{mode:0o600,flag:'wx'});return snapshot();},
  pause(){if(current)current.public.state='paused_by_admin';},resume(){if(current){current.deadline=now()+budgetMs;current.public.state='queued';delete current.public.error;}},
  report(id){if(!current||current.public.id!==id)throw Error('Report not found.');return current.report;},
  close(){stopped=true;clearInterval(timer);}
 };
}
