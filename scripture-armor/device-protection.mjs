// Automatic local static inspection. No target is executed; no scan result is
// interpreted as an instruction, approval, or permission to change system files.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {classifyBuffer} from './scan.mjs';
import scanRoots from './device-scan-roots.json' with {type:'json'};
const executeFile=promisify(execFile);
const SKIP=new Set(['.git','node_modules','.ssh','.aws','.gnupg','.codex','.scripture-armor','.kingmaker','Caches','Cache','migration-backups']);
const SECRET=/(^\.env($|\.)|identity\.json$|credentials|private[-_]?key|\.pem$|\.p12$|\.key$|id_rsa|id_ed25519)/i;
export function deviceScanRoots({home=os.homedir(),platform=process.platform}={}) {
  return (scanRoots[platform]||scanRoots.win32).map(p=>p.startsWith('~/')?path.join(home,p.slice(2)):p);
}
export async function deviceResources(directory) {
  const disk=fs.statfsSync(directory);let freePercent=100*os.freemem()/os.totalmem();
  if(process.platform==='darwin') {
    const {stdout}=await executeFile('/usr/bin/memory_pressure',['-Q'],{timeout:2000,maxBuffer:8192});
    const match=/free percentage:\s*(\d+)%/.exec(stdout);
    if(!match) throw Error('resource measurement unavailable');freePercent=Number(match[1]);
  }
  return freePercent>=35 && Number(disk.bavail)*Number(disk.bsize)>=8*1024**3;
}
export function createDeviceProtection({identityDir,roots=deviceScanRoots(),analyze,isLicensed=()=>false,
  resources=deviceResources,onEvent=()=>{},delayMs=1000,maxEntries=16,maxBytes=16*1024*1024}={}) {
  if(!path.isAbsolute(identityDir||'') || typeof analyze!=='function' || roots.some(p=>!path.isAbsolute(p))) throw Error('device protection configuration required');
  const protectedRoot=path.resolve(identityDir),reportDir=path.join(protectedRoot,'device-audit');
  const findingFiles=new Map();
  let timer=null,stopped=true,running=false,iterator=null,queue=[],cursor=0,drain=[],nextDelay=delayMs;
  // A file whose inspection ends without a verdict (the analysis threw, came
  // back limited, or was interrupted by a stop) is NOT consumed: it is
  // re-queued here and inspected again on a later tick, up to MAX_ATTEMPTS
  // retries, instead of silently dropping out of the scan's coverage while
  // the scan goes on to report completion.
  const retryQueue=[],attempts=new Map();const MAX_ATTEMPTS=3;
  function defer(file) {
    const n=(attempts.get(file)||0)+1;attempts.set(file,n);
    if(n<=MAX_ATTEMPTS)retryQueue.push(file);
  }
  let state={state:'not_started',trigger:null,checked:0,findings:0,skipped:0,repaired:0,blocked:0,
    scope:[...roots],wholeDeviceCoverageVerified:false,commandAuthority:false};
  const publish=(type,message)=>{try{onEvent(type,message);}catch{}};
  function baseline() {
    // The only automatic repair is the privacy mode of this app-owned audit
    // directory. No key store, system setting, executable, or user file changes.
    fs.mkdirSync(protectedRoot,{recursive:true,mode:0o700});
    const rootStat=fs.lstatSync(protectedRoot);
    if(!rootStat.isDirectory()||rootStat.isSymbolicLink()||process.getuid&&rootStat.uid!==process.getuid()||fs.realpathSync(protectedRoot)!==protectedRoot) throw Error('unsafe audit root');
    if(!fs.existsSync(reportDir)) fs.mkdirSync(reportDir,{mode:0o700});
    const stat=fs.lstatSync(reportDir);
    if(!stat.isDirectory() || stat.isSymbolicLink() || process.getuid && stat.uid!==process.getuid()) throw Error('unsafe audit directory');
    if(stat.mode&0o077) {
      const fd=fs.openSync(reportDir,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
      try {
        const opened=fs.fstatSync(fd);if(opened.ino!==stat.ino||opened.dev!==stat.dev) throw Error('audit directory changed');
        // Save the old mode before applying this explicitly scoped, reversible fix.
        const log=path.join(reportDir,'permission-repairs.jsonl');
        const out=fs.openSync(log,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_APPEND|(fs.constants.O_NOFOLLOW||0),0o600);
        try {const s=fs.fstatSync(out);if(!s.isFile()||s.nlink!==1||(s.mode&0o077)) throw Error('unsafe repair journal');
          fs.writeSync(out,JSON.stringify({at:new Date().toISOString(),target:'device-audit',before:stat.mode&0o777,after:0o700})+'\n');fs.fsyncSync(out);
        } finally {fs.closeSync(out);}
        fs.fchmodSync(fd,0o700);state.repaired++;publish('device-repair','Restored private permissions on the Armor audit directory.');
      } finally {fs.closeSync(fd);}
    }
  }
  function schedule() {if(!stopped&&!timer){timer=setTimeout(()=>{timer=null;void tick();},['waiting_for_login','paused_for_resources'].includes(state.state)?30000:nextDelay);timer.unref?.();}}
  async function nextFile() {
    for(let count=0;count<maxEntries;count++) {
      if(!iterator) {
        if(cursor>=queue.length) return null;
        const item=queue[cursor++];
        try {const st=fs.lstatSync(item.path);if(!st.isDirectory()||st.isSymbolicLink()) {state.skipped++;continue;}
          iterator={dir:await fs.promises.opendir(item.path),...item};
        }catch{state.blocked++;continue;}
      }
      const item=await iterator.dir.read();
      if(!item){await iterator.dir.close();iterator=null;continue;}
      const file=path.join(iterator.path,item.name);
      if(SKIP.has(item.name)||SECRET.test(item.name)||file===protectedRoot||file.startsWith(protectedRoot+path.sep)) {state.skipped++;continue;}
      if(item.isSymbolicLink()){state.skipped++;continue;}
      if(item.isDirectory()) {if(iterator.depth<6&&queue.length<4096)queue.push({path:file,depth:iterator.depth+1});else state.blocked++;continue;}
      if(item.isFile())return file;
    }
    return undefined;
  }
  async function tick() {
    if(stopped||running)return;
    running=true;nextDelay=delayMs;
    try {
      if(!isLicensed()){state.state='waiting_for_login';return;}
      if(!await resources(protectedRoot)){state.state='paused_for_resources';return;}
      state.state='scanning';
      const file=retryQueue.length?retryQueue.shift():await nextFile();
      if(file===null){state.state='completed_scoped_scan';stopped=true;publish('device-scan','Automatic scoped device inspection completed. Unreadable and deferred items remain listed.');return;}
      if(!file)return;
      const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0)|fs.constants.O_NONBLOCK);
      let temporary;
      try {
        const stat=fs.fstatSync(fd);
        if(!stat.isFile()||stat.nlink!==1||stat.size>maxBytes){state.skipped++;if(stat.size>maxBytes)state.blocked++;return;}
        const prefix=Buffer.alloc(Math.min(4096,stat.size));fs.readSync(fd,prefix,0,prefix.length,0);
        const kind=classifyBuffer(prefix,file);
        if(kind!=='binary'&&kind!=='source'){state.skipped++;return;}
        if(kind==='binary')nextDelay=Math.max(30000,delayMs);
        // Inspect an owned immutable snapshot, not a path that an untrusted
        // installer can swap for an alias while a scanner is opening it.
        const bytes=Buffer.alloc(stat.size);let offset=0;
        while(offset<bytes.length){const n=fs.readSync(fd,bytes,offset,bytes.length-offset,offset);if(!n)throw Error('file changed');offset+=n;}
        const after=fs.fstatSync(fd);
        if(after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||after.ctimeMs!==stat.ctimeMs)throw Error('file changed');
        temporary=fs.mkdtempSync(path.join(os.tmpdir(),'armor-device-check-'));fs.chmodSync(temporary,0o700);
        const copy=path.join(temporary,path.basename(file));fs.writeFileSync(copy,bytes,{mode:0o600,flag:'wx'});
        bytes.fill(0);
        if(stopped||!isLicensed()){defer(file);return;}
        let result;try{result=await analyze(copy);}catch(error){defer(file);throw error;}
        if(stopped){defer(file);return;}
        if(!result||typeof result.finding!=='boolean'){defer(file);throw Error('incomplete analysis');}
        if(result.limited===true){state.blocked++;defer(file);publish('device-deferred',`Incomplete analysis: ${path.basename(file)}. No clean verdict was issued.`);return;}
        attempts.delete(file);state.checked++;
        if(result?.finding===true){state.findings++;if(findingFiles.size<256)findingFiles.set(crypto.randomUUID(),{path:file,name:path.basename(file)});publish('device-finding',`Review required: ${path.basename(file)}. No automatic quarantine or execution.`);}
        publish('device-progress',`Automatic device inspection: ${state.checked} files checked; ${state.findings} findings; ${state.blocked} deferred or inaccessible items.`);
      }finally{fs.closeSync(fd);if(temporary)fs.rmSync(temporary,{recursive:true,force:true});}
    }catch{state.blocked++;state.state='inspection_incomplete';publish('device-error','A device check could not complete. It was not marked clean.');}
    finally{running=false;if(stopped&&iterator){try{await iterator.dir.close();}catch{}iterator=null;}for(const resolve of drain.splice(0))resolve();schedule();}
  }
  return Object.freeze({
    state:()=>({...state,scope:[...state.scope],findingItems:[...findingFiles].map(([id,f])=>({id,name:f.name}))}),
    findingPath:id=>findingFiles.get(id)?.path||null,
    start(trigger='login') {
      if(running)return;
      if(timer){if(['waiting_for_login','paused_for_resources'].includes(state.state)&&isLicensed()){clearTimeout(timer);timer=null;}else return;}
      if(state.state==='completed_scoped_scan') {
        if(!['login','activation','manual'].includes(trigger))return;
        findingFiles.clear();queue=[];cursor=0;retryQueue.length=0;attempts.clear();state.checked=0;state.findings=0;state.skipped=0;state.blocked=0;
      }
      stopped=false;state.trigger=trigger;
      try{baseline();}catch{state.state='unsafe_audit_storage';state.blocked++;return;}
      if(!queue.length)queue=roots.map(p=>({path:p,depth:0}));
      state.state=isLicensed()?'queued':'waiting_for_login';schedule();
    },
    tick,
    async stop(){stopped=true;if(timer)clearTimeout(timer);timer=null;if(running)await new Promise(resolve=>drain.push(resolve));if(iterator&&!running){await iterator.dir.close();iterator=null;}state.state='stopped';},
  });
}
