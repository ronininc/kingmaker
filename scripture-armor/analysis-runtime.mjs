import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// Ghidra creates .sla.lock files beside its language definitions. Never run it
// from a signed .app resource tree: those writes invalidate the app signature.
// This cache contains public analysis tooling only, never identity material.
function privateDirectory(dir) {
  try { fs.mkdirSync(dir,{mode:0o700}); } catch(e) { if(e.code!=='EEXIST')throw e; }
  const s=fs.lstatSync(dir);
  if(!s.isDirectory()||s.isSymbolicLink()||(process.getuid&&s.uid!==process.getuid()))throw Error('Analysis cache must be an owned directory, not an alias');
  fs.chmodSync(dir,0o700);
}
function digest(file) {
  const h=crypto.createHash('sha256'),fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0)),buffer=Buffer.alloc(65536);
  try { let n;while((n=fs.readSync(fd,buffer,0,buffer.length,null)))h.update(buffer.subarray(0,n));return h.digest('hex'); }
  finally { fs.closeSync(fd); }
}
function verify(root,records,{allowLocks=false}={}) {
  const expected=new Map(records.map(r=>[r.path.slice('tools/ghidra/'.length),r]));
  // Keep a separate immutable list for directory/lock membership checks;
  // verification order must not change which paths are permitted.
  const all=new Map(expected);
  function check(dir,relative='') {
    for(const name of fs.readdirSync(dir)) {
      const rel=relative?relative+'/'+name:name,file=path.join(dir,name),s=fs.lstatSync(file);
      if(s.isSymbolicLink())throw Error('Analysis runtime aliases are refused');
      if(s.isDirectory()){check(file,rel);continue;}
      const r=all.get(rel);
      if(!r){if(allowLocks&&rel.endsWith('.sla.lock')&&all.has(rel.slice(0,-5))&&s.isFile()&&s.size===0)continue;throw Error('Unexpected analysis runtime file: '+rel);}
      if(!s.isFile()||s.size!==r.size||(s.mode&0o777)!==r.mode||digest(file)!==r.sha256)throw Error('Analysis runtime integrity mismatch: '+rel);
      expected.delete(rel);
    }
  }
  check(root);
  if(expected.size)throw Error('Analysis runtime is incomplete');
}
export function preparePackagedAnalysisRuntime({bundleRoot,cacheBase}={}) {
  const manifest=JSON.parse(fs.readFileSync(path.join(bundleRoot,'BUNDLE.json'),'utf8'));
  if(manifest.schema!=='scripture-armor.standalone-bundle/1'||!Array.isArray(manifest.files))throw Error('Invalid analysis runtime manifest');
  const records=manifest.files.filter(r=>typeof r.path==='string'&&r.path.startsWith('tools/ghidra/'));
  if(!records.length||records.some(r=>r.type||!Number.isSafeInteger(r.size)||r.size<0||!/^[a-f0-9]{64}$/.test(r.sha256)||r.path.split('/').some(p=>!p||p==='.'||p==='..')||r.path.includes('\\'))||new Set(records.map(r=>r.path)).size!==records.length)throw Error('Invalid analysis runtime records');
  const key=crypto.createHash('sha256').update('analysis-runtime-cache/2:'+JSON.stringify(records)).digest('hex');
  const parent=cacheBase||path.join(os.homedir(),...(process.platform==='darwin'?['Library','Application Support']:['.cache']));
  if(!path.isAbsolute(parent))throw Error('Analysis cache base must be absolute');
  let base=parent;
  for(const part of ['Ronin Inc','Scripture Armor','analysis-runtimes']){base=path.join(base,part);privateDirectory(base);}
  const destination=path.join(base,key);
  if(fs.existsSync(destination)) {
    const s=fs.lstatSync(destination);if(!s.isDirectory()||s.isSymbolicLink())throw Error('Analysis runtime cache must not be an alias');
    verify(destination,records,{allowLocks:true});return destination;
  }
  const source=path.join(bundleRoot,'tools','ghidra');
  verify(source,records);
  const stage=path.join(base,'.stage-'+crypto.randomUUID());
  try {
    fs.cpSync(source,stage,{recursive:true,errorOnExist:true,verbatimSymlinks:true,mode:fs.constants.COPYFILE_FICLONE});
    // Ghidra compares .sla timestamps with .slaspec/includes. Copy order can
    // falsely make unchanged sources newer and trigger a rewrite of verified
    // compiled data. Normalize metadata only; every content hash stays pinned.
    // A positive epoch avoids Ghidra's special "missing file" zero timestamp.
    for(const r of records)fs.utimesSync(path.join(stage,r.path.slice('tools/ghidra/'.length)),946684800,946684800);
    fs.chmodSync(stage,0o700);verify(stage,records);
    fs.renameSync(stage,destination);return destination;
  } finally {if(fs.existsSync(stage))fs.rmSync(stage,{recursive:true,force:true});}
}
