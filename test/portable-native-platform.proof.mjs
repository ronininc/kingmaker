// Native OS proof entrypoint for manual CI; no model downloads or service startup.
import assert from 'node:assert/strict';import {mkdtempSync,mkdirSync,cpSync,writeFileSync,rmSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildPayload} from '../scripts/build-payload.mjs';import {verifyUnit} from '../platform/portable-verify.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const work=mkdtempSync(join(tmpdir(),'kingmaker-native-platform-'));
try{
 const p=buildPayload({out:join(work,'payload')}),unit=join(work,'unit'),extract=join(work,'extract');mkdirSync(unit);mkdirSync(extract);execFileSync('tar',['-xf',p.tar,'-C',extract]);cpSync(join(extract,'sol-ghost'),join(unit,'engine'),{recursive:true});
 const platform=process.platform==='win32'?'windows':'linux';
 writeFileSync(join(unit,'UNIT.json'),JSON.stringify({schema:'kingmaker.unit/1',unit:'kingmaker',version:p.version,platform,arch:'x64'}));
 cpSync(join(root,'platform/portable-verify.mjs'),join(unit,'portable-verify.mjs'));
 const files=platform==='windows'?['kingmaker.cmd','install.ps1']:['kingmaker','install.sh'];for(const file of files)cpSync(join(root,'platform',platform,file),join(unit,file));
 const home=join(work,'home'),dest=join(work,'installed');mkdirSync(home);const env={...process.env,HOME:home,KINGMAKER_ENGINE_HOME:dest};
 let result;
 if(platform==='windows'){
  // Default execution policy retained: if unsigned local test scripts are blocked, report rather than bypass.
  execFileSync('pwsh',['-NoLogo','-NoProfile','-NonInteractive','-File',join(unit,'install.ps1')],{env,stdio:'inherit',timeout:60000});
  result=execFileSync('cmd.exe',['/d','/c','kingmaker.cmd','version'],{cwd:dest,env,encoding:'utf8',timeout:30000});
 }else{
  execFileSync('/bin/sh',[join(unit,'install.sh')],{env,stdio:'inherit',timeout:60000});
  result=execFileSync(join(dest,'kingmaker'),['version'],{env,encoding:'utf8',timeout:30000});
 }
 assert.equal(result.trim(),p.version);assert.equal(verifyUnit(dest,platform).version,p.version);
 writeFileSync(join(dest,'engine/package.json'),'{}');assert.throws(()=>verifyUnit(dest,platform));
 console.log(JSON.stringify({ok:true,host:process.platform,arch:process.arch,node:process.versions.node,version:p.version,nativeInstallerExecuted:true,payloadTamperRejected:true,noModelDownloads:true}));
}finally{rmSync(work,{recursive:true,force:true});}
