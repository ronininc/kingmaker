import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

const COMMIT=/^[a-f0-9]{40}$/,OID=/^[a-f0-9]{40}$/;
const MAX_FILES=5000,MAX_FILE=2*1024*1024,MAX_TOTAL=64*1024*1024,MAX_TREE_TOTAL=8*1024*1024,MAX_DEPTH=64;
const env={PATH:'/usr/bin:/bin',HOME:'/var/empty',LANG:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_ATTR_NOSYSTEM:'1',GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0'};
const sensitive=(p)=>{const parts=p.split('/');return parts.includes('.git')||['.env','.npmrc','.netrc'].includes(parts.at(-1))||parts.some(x=>!x||x==='.'||x==='..')};
const git=(gitDir,args,opts={})=>execFileSync('/usr/bin/git',[`--git-dir=${gitDir}`,'--no-replace-objects','-c','core.hooksPath=/dev/null','-c','core.attributesFile=/dev/null',...args],{env,timeout:10_000,maxBuffer:opts.maxBuffer??4*1024*1024,encoding:opts.encoding??null,stdio:['ignore','pipe','pipe']});
const oidFor=(type,bytes)=>createHash('sha1').update(Buffer.from(`${type} ${bytes.length}\0`)).update(bytes).digest('hex');

export function loadVerifiedGitObjectSnapshot({sourceRoot,commit}){
  if(!COMMIT.test(String(commit)))throw new Error('GIT_SNAPSHOT_COMMIT');
  const root=realpathSync(sourceRoot),gitDir=join(root,'.git'),st=lstatSync(gitDir);
  if(st.isSymbolicLink()||!st.isDirectory())throw new Error('GIT_SNAPSHOT_REPOSITORY');
  let type,commitBytes;
  try{type=git(gitDir,['cat-file','-t',commit],{maxBuffer:4096}).toString('utf8').trim();commitBytes=git(gitDir,['cat-file','commit',commit],{maxBuffer:2*1024*1024})}catch{throw new Error('GIT_SNAPSHOT_COMMIT_OBJECT')}
  if(type!=='commit')throw new Error('GIT_SNAPSHOT_COMMIT_OBJECT');
  if(oidFor('commit',commitBytes)!==commit)throw new Error('GIT_SNAPSHOT_COMMIT_MISMATCH');
  const treeMatch=/^tree ([a-f0-9]{40})\n/.exec(commitBytes.toString('utf8'));
  if(!treeMatch)throw new Error('GIT_SNAPSHOT_COMMIT_TREE');
  const treeOid=treeMatch[1],files=[],paths=new Set(),activeTrees=new Set(),decoder=new TextDecoder('utf-8',{fatal:true});
  let total=0,treeTotal=0,fileCount=0;
  const walk=(oid,prefix='',depth=0)=>{
    if(depth>MAX_DEPTH)throw new Error('GIT_SNAPSHOT_TREE_DEPTH');
    if(activeTrees.has(oid))throw new Error('GIT_SNAPSHOT_TREE_CYCLE');
    activeTrees.add(oid);
    let raw;
    try{if(git(gitDir,['cat-file','-t',oid],{maxBuffer:4096}).toString('utf8').trim()!=='tree')throw new Error();raw=git(gitDir,['cat-file','tree',oid],{maxBuffer:MAX_TREE_TOTAL+1})}catch{throw new Error('GIT_SNAPSHOT_TREE_OBJECT')}
    if((treeTotal+=raw.length)>MAX_TREE_TOTAL)throw new Error('GIT_SNAPSHOT_TREE_SIZE');
    if(oidFor('tree',raw)!==oid)throw new Error('GIT_SNAPSHOT_TREE_MISMATCH');
    let p=0,entries=0;
    while(p<raw.length){
      const space=raw.indexOf(0x20,p),nul=space<0?-1:raw.indexOf(0,space+1);
      if(space<=p||nul<=space+1||nul+21>raw.length)throw new Error('GIT_SNAPSHOT_TREE_FORMAT');
      const mode=raw.subarray(p,space).toString('ascii');let name;
      try{name=decoder.decode(raw.subarray(space+1,nul))}catch{throw new Error('GIT_SNAPSHOT_TREE_FORMAT')}
      const childOid=raw.subarray(nul+1,nul+21).toString('hex');p=nul+21;entries++;
      if(!OID.test(childOid)||name.includes('/')||name==='.'||name==='..'||name.includes('\0'))throw new Error('GIT_SNAPSHOT_TREE_FORMAT');
      const path=prefix?`${prefix}/${name}`:name;
      if(paths.has(path)||sensitive(path))throw new Error('GIT_SNAPSHOT_UNSAFE_ENTRY');
      paths.add(path);
      if(mode==='40000'){walk(childOid,path,depth+1);continue}
      if(mode!=='100644'&&mode!=='100755')throw new Error('GIT_SNAPSHOT_UNSAFE_ENTRY');
      if(++fileCount>MAX_FILES)throw new Error('GIT_SNAPSHOT_FILE_LIMIT');
      let bytes;
      try{if(git(gitDir,['cat-file','-t',childOid],{maxBuffer:4096}).toString('utf8').trim()!=='blob')throw new Error();bytes=git(gitDir,['cat-file','blob',childOid],{maxBuffer:MAX_FILE+1})}catch{throw new Error('GIT_SNAPSHOT_BLOB_OBJECT')}
      if(bytes.length>MAX_FILE||(total+=bytes.length)>MAX_TOTAL)throw new Error('GIT_SNAPSHOT_SIZE_LIMIT');
      if(oidFor('blob',bytes)!==childOid)throw new Error('GIT_SNAPSHOT_OBJECT_MISMATCH');
      files.push({path,mode,oid:childOid,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),bytes});
    }
    if(p!==raw.length||entries===0)throw new Error('GIT_SNAPSHOT_TREE_FORMAT');
    activeTrees.delete(oid);
  };
  walk(treeOid);
  if(!files.length)throw new Error('GIT_SNAPSHOT_FILE_LIMIT');
  files.sort((a,b)=>a.path.localeCompare(b.path));
  const closure=files.map(({path,mode,oid,size,sha256})=>({path,mode,oid,size,sha256}));
  const closureSha256=createHash('sha256').update(JSON.stringify(closure)).digest('hex');
  return{schema:'ronin.git-object-snapshot/v1',commit,treeOid,files,closure,closureSha256,totalBytes:total};
}
