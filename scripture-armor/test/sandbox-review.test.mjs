import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {reviewUploadedFile,macReviewPolicy} from '../sandbox-review.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url));
test('uploaded text gets a real isolated static review with no execution or authority', {skip:process.platform!=='darwin',timeout:30000},async()=>{
  const result=await reviewUploadedFile(Buffer.from('{"inert":true}'),'renamed.data');
  assert.equal(result.sandbox,'macos-seatbelt');assert.equal(result.format,'JSON');
  assert.equal(result.priority,19);assert.equal(result.targetExecuted,false);assert.equal(result.commandAuthority,false);assert.equal(result.rea.verdict,'clean');
});
test('the actual OS policy denies outside file reads and loopback network connections', {skip:process.platform!=='darwin',timeout:15000},()=>{
  const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'armor-sandbox-proof-'))),root=path.join(temp,'sandbox');
  fs.mkdirSync(root,{mode:0o700});fs.mkdirSync(path.join(root,'scratch'),{mode:0o700});
  const secret=path.join(temp,'outside-fixture');fs.writeFileSync(secret,'synthetic-only');
  try{
    const node=fs.realpathSync(process.execPath),policy=macReviewPolicy({node,codeRoot:HERE,root});
    for(const [file,args] of [['sandbox-read-probe.mjs',[secret]],['sandbox-network-probe.mjs',[]]]){
      execFileSync('/usr/bin/sandbox-exec',['-p',policy,node,path.join(HERE,file),...args],{stdio:'pipe',timeout:5000,env:{PATH:'/usr/bin:/bin',HOME:os.homedir()}});
    }
    assert.equal(fs.readFileSync(secret,'utf8'),'synthetic-only');
  } finally {fs.rmSync(temp,{recursive:true,force:true});}
});
