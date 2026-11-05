import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const script=new URL('../scripts/build-app.sh',import.meta.url).pathname;
test('native producer refuses invalid or existing candidate outputs before compiling or deleting anything',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'kingmaker-output-proof-'));
 const app=path.join(root,'Kingmaker.app'),payload=path.join(root,'payload');
 fs.mkdirSync(app);fs.mkdirSync(payload);fs.writeFileSync(path.join(app,'preserve'),'app');fs.writeFileSync(path.join(payload,'preserve'),'payload');
 try {
  for(const input of [{KINGMAKER_APP_OUT:'/'},{KINGMAKER_APP_OUT:app},{KINGMAKER_APP_OUT:path.join(root,'fresh','Kingmaker.app'),KINGMAKER_PAYLOAD_OUT:'/'},{KINGMAKER_APP_OUT:path.join(root,'fresh','Kingmaker.app'),KINGMAKER_PAYLOAD_OUT:payload}]){
   const result=spawnSync('/bin/sh',[script],{env:{PATH:process.env.PATH,...input},encoding:'utf8',timeout:5000});
   assert.equal(result.status,2,result.stderr);assert.match(result.stderr,/candidate .*output/);
   assert.equal(fs.readFileSync(path.join(app,'preserve'),'utf8'),'app');assert.equal(fs.readFileSync(path.join(payload,'preserve'),'utf8'),'payload');
  }
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
