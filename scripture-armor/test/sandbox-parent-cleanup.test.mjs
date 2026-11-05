import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
const HERE=path.dirname(fileURLToPath(import.meta.url));
test('closing the review host terminates its isolated worker and removes its private copy', {skip:process.platform!=='darwin',timeout:20000},async()=>{
  const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'armor-parent-shutdown-')));
  const parent=spawn(process.execPath,[path.join(HERE,'sandbox-parent-probe.mjs')],{env:{...process.env,TMPDIR:temp},stdio:['ignore','pipe','pipe']});
  const exited=once(parent,'exit');
  try{
    await Promise.race([new Promise((resolve,reject)=>{let text='';parent.stdout.on('data',c=>{text+=c;if(text.includes('READY'))resolve();});parent.on('error',reject);}),new Promise((_,reject)=>setTimeout(()=>reject(Error('fixture readiness timeout')),5000).unref())]);
    const children=execFileSync('/usr/bin/pgrep',['-P',String(parent.pid)],{encoding:'utf8'}).trim().split(/\s+/).map(Number);
    assert(children.length>0);parent.kill('SIGTERM');
    const [,signal]=await exited;assert.equal(signal,'SIGTERM');
    for(const pid of children){
      let alive=true;
      for(let i=0;i<50;i++){try{process.kill(pid,0);}catch{alive=false;break;}await new Promise(r=>setTimeout(r,20));}
      assert.equal(alive,false,'owned review worker must not outlive its host');
    }
    assert.equal(fs.readdirSync(temp).filter(n=>n.startsWith('armor-review-')).length,0);
  }finally{parent.kill('SIGTERM');fs.rmSync(temp,{recursive:true,force:true});}
});
