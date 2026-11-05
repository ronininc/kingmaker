// Fixed static-analysis worker. Its parent MUST enforce the OS sandbox; this
// program never imports, executes, renders or installs the uploaded artifact.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {inspectAgnostic} from './agnostic-review.mjs';
import {explainReview} from './review-presentation.mjs';
import {scanSourceText,scanFile,DEFAULT_POLICY} from './scan.mjs';
const [input,scratch,name]=process.argv.slice(2);
try {
  if(!path.isAbsolute(input||'')||!path.isAbsolute(scratch||'')||!name||name.length>256)throw Error('invalid review request');
  const bytes=fs.readFileSync(input);const parsed=inspectAgnostic(bytes,name),findings=[];
  for(const item of parsed.texts){
    const report=scanSourceText(item.text,item.name,crypto.createHash('sha256').update(item.text).digest('hex'));
    for(const f of report.findings)if(findings.length<100)findings.push({rule:f.rule,severity:f.severity,title:f.rule.replace(/[-_]+/g,' '),basis:f.basis,location:f.location,detail:f.detail,excerpt:f.excerpt});
  }
  let rea=null;
  const here=path.dirname(fileURLToPath(import.meta.url));
  const reaFile=[path.join(here,'rea','rea.mjs'),path.join(here,'..','lib','rea.mjs')].find(p=>fs.existsSync(p));
  if(reaFile){try{const scanner=await import(pathToFileURL(reaFile));const r=scanner.inspect([input]);rea={verdict:r.verdict};}catch{parsed.limitations.push('REA inspection did not complete.');}}
  else parsed.limitations.push('REA inspection is unavailable.');
  let binary=null;
  if(parsed.kind==='binary') {
    try {const result=await scanFile(input,{storeDir:scratch,policy:{...DEFAULT_POLICY,scan:{...DEFAULT_POLICY.scan,timeout_s:15}}});binary=result.record;}
    catch{parsed.limitations.push('Binary analysis could not complete inside the sandbox; not marked clean.');}
  }
  const limited=parsed.limitations.length>0;
  const result={schema:'scripture-armor.file-review/1',contentSha256:crypto.createHash('sha256').update(bytes).digest('hex'),format:parsed.format,kind:parsed.kind,
    status:limited?'limited':'reviewed_static',limitations:parsed.limitations,findings,
    activeContent:parsed.activeContent,entries:parsed.entries??null,
    rea,binary:binary?{verdict:binary.verdict,confidence:binary.confidence??null}:null,
    commandAuthority:false,targetExecuted:false,priority:os.getPriority()};
  const presentation=explainReview(result,parsed,bytes);bytes.fill(0);
  process.stdout.write(JSON.stringify({...result,...presentation}));
}catch{process.stderr.write('Static file review failed.');process.exitCode=1;}
