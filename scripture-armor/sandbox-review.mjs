import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {classifyBuffer} from './scan.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url));
const q=value=>JSON.stringify(value);
const liveReviews=new Map();
function cleanupReviews(){
  for(const [pid,root] of liveReviews){try{process.kill(-pid,'SIGKILL');}catch{}try{fs.rmSync(root,{recursive:true,force:true});}catch{}}
}
function removeReviewHandlers(){process.removeListener('exit',cleanupReviews);process.removeListener('SIGTERM',onReviewTerm);process.removeListener('SIGINT',onReviewInterrupt);}
function endReviewHost(signal){cleanupReviews();removeReviewHandlers();if(process.listenerCount(signal)===0)process.kill(process.pid,signal);}
function onReviewTerm(){endReviewHost('SIGTERM');}
function onReviewInterrupt(){endReviewHost('SIGINT');}
function trackReview(pid,root){
  if(!Number.isInteger(pid))return;
  if(!liveReviews.size){process.once('exit',cleanupReviews);process.on('SIGTERM',onReviewTerm);process.on('SIGINT',onReviewInterrupt);}
  liveReviews.set(pid,root);
}
function untrackReview(pid){liveReviews.delete(pid);if(!liveReviews.size)removeReviewHandlers();}

export function macReviewPolicy({node,codeRoot,root,readRoots=[],readFiles=[],protectedRoots=[],binary=false}) {
  const read=[codeRoot,root,path.dirname(node),...readRoots,'/System','/usr/lib','/usr/share','/private/var/db/dyld','/opt/homebrew/Cellar'];
  const executables=[node,...(binary?['/usr/bin/env','/bin/sh','/bin/bash','/usr/bin/dirname','/usr/bin/basename','/usr/bin/uname','/usr/bin/readlink','/usr/bin/sed','/usr/bin/grep','/usr/bin/head','/usr/bin/cut','/usr/bin/which']:[])];
  return `(version 1) (deny default)
(import "dyld-support.sb")
(allow syscall*) (allow mach-bootstrap) (allow system-fcntl)
(allow sysctl-read) (allow process-fork) (allow process-info* (target self))
(allow file-read-metadata) (allow file-map-executable)
(allow mach-lookup (global-name "com.apple.system.logger"))
(deny file-read-data ${[...['.scripture-armor','.scripture-armor.installation','.ssh','.codex','.kingmaker','.aws'].map(p=>path.join(os.homedir(),p)),...protectedRoots].map(p=>`(subpath ${q(p)})`).join(' ')})
(allow file-read* ${readFiles.map(p=>`(literal ${q(p)})`).join(' ')} ${read.map(p=>`(subpath ${q(p)})`).join(' ')} (literal "/opt/homebrew/etc/openssl@3/openssl.cnf") (literal "/usr/local/etc/openssl@3/openssl.cnf") (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom") (subpath "/private/etc/ssl"))
(allow file-write* (subpath ${q(path.join(root,'scratch'))}) (literal "/dev/null"))
(allow process-exec ${executables.map(p=>`(literal ${q(p)})`).join(' ')} ${binary?readRoots.map(p=>`(subpath ${q(p)})`).join(' '):''})`;
}
export async function reviewUploadedFile(bytes,name,{readRoots=[],protectedRoots=[]}={}) {
  if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>16*1024*1024||typeof name!=='string'||name.length>256||/[\0\r\n]/.test(name))throw Error('A single nonempty file up to 16 MiB is required.');
  if(process.platform!=='darwin'||!fs.existsSync('/usr/bin/sandbox-exec')||process.getuid?.()===0)throw Error('An unprivileged OS review sandbox is unavailable; review was not run.');
  const node=fs.realpathSync(process.execPath),root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'armor-review-')));
  fs.chmodSync(root,0o700);const input=path.join(root,'upload'),scratch=path.join(root,'scratch');
  try {
    fs.mkdirSync(scratch,{mode:0o700});fs.writeFileSync(input,bytes,{mode:0o400,flag:'wx'});
    // Only trusted packaged tool roots may be added by the native caller;
    // neither the upload name nor any request field becomes a policy path.
    const tools=readRoots.map(p=>fs.realpathSync(p));
    const reaFiles=[path.join(HERE,'rea','rea.mjs'),path.join(HERE,'..','lib','rea.mjs')];
    const rea=reaFiles.find(file=>fs.existsSync(file));
    const readFiles=rea?[rea,path.join(path.dirname(rea),'rea-rules.mjs'),path.join(HERE,'..','package.json')]:[];
    if(tools.some(p=>p===path.parse(p).root||p===os.homedir()||os.homedir().startsWith(p+path.sep)||p===os.tmpdir()))throw Error('Unsafe review runtime scope.');
    const reviewId=crypto.randomUUID();
    const policy=macReviewPolicy({node,codeRoot:HERE,root,readRoots:tools,readFiles,protectedRoots,binary:classifyBuffer(bytes.subarray(0,16384),name)==='binary'});
    const policySha256=crypto.createHash('sha256').update(policy).digest('hex');
    fs.writeFileSync(path.join(root,'review-shield.json'),JSON.stringify({reviewId,policySha256,network:false,vault:false,ownerKeysCopied:false}),{mode:0o400,flag:'wx'});
    const env={PATH:'/usr/bin:/bin',HOME:os.homedir(),TMPDIR:scratch,LANG:'en_US.UTF-8',
      _JAVA_OPTIONS:`-Xmx512m -XX:ActiveProcessorCount=1 -Djava.io.tmpdir=${scratch}`};
    for(const key of ['SCRIPTURE_GHIDRA_HOME','JAVA_HOME']) {
      if(!process.env[key]||!tools.length)continue;
      try{if(tools.includes(fs.realpathSync(process.env[key])))env[key]=process.env[key];}catch{}
    }
    return await new Promise((resolve,reject)=>{
      let stdout='',stderr='',settled=false;
      const child=spawn('/usr/bin/sandbox-exec',['-p',policy,node,'--max-old-space-size=192','--max-semi-space-size=8',path.join(HERE,'review-worker.mjs'),input,scratch,path.basename(name)],{env,cwd:scratch,stdio:['ignore','pipe','pipe'],detached:true});
      const kill=()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}};
      const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);untrackReview(child.pid);error?reject(error):resolve(result);};
      const timer=setTimeout(()=>{kill();finish(Error('Sandbox review timed out; no clean verdict was issued.'));},25000);
      trackReview(child.pid,root);
      child.on('error',()=>finish(Error('OS sandbox could not start; review was not run.')));
      child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.length>1024*1024){kill();finish(Error('Review output limit exceeded.'));}});
      child.stderr.on('data',chunk=>{if(stderr.length<16384)stderr+=chunk;});
      child.on('close',code=>{if(code!==0)return finish(Error('OS sandbox review failed; no clean verdict was issued.'));
        try{const result=JSON.parse(stdout);if(result.schema!=='scripture-armor.file-review/1'||result.contentSha256!==crypto.createHash('sha256').update(bytes).digest('hex')||result.commandAuthority!==false||result.targetExecuted!==false)throw Error();finish(null,{...result,sandbox:'macos-seatbelt',isolation:{reviewId,policySha256,network:false,vault:false,ownerKeysCopied:false,workspaceDestroyedOnReturn:true,nextReview:'fresh-workspace',originalFileRemoved:false}});}
        catch{finish(Error('Review returned an invalid result.'));}
      });
      try{os.setPriority(child.pid,19);}catch{kill();finish(Error('Low-priority review could not start.'));}
    });
  } finally {fs.rmSync(root,{recursive:true,force:true});}
}
