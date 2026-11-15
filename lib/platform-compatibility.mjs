import {open,readFile,realpath,mkdtemp,writeFile,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
const hash=b=>createHash('sha256').update(b).digest('hex');
export async function inspectCompatibility(path){
 const f=await open(path,'r');let b;try{b=Buffer.alloc(64);const r=await f.read(b,0,64,0);b=b.subarray(0,r.bytesRead);}finally{await f.close();}
 const base={schema:'kingmaker.compatibility-inspection/1',host:{platform:process.platform,arch:process.arch},path,executionAttempted:false,headerOnly:true};
 if(b.subarray(0,4).toString()==='GGUF')return {...base,kind:'model-container',format:'GGUF',osSpecific:false,status:'runtime-validation-required',requirements:['supported model architecture and quantization','compatible inference runtime/backend','full model availability or a runtime explicitly supporting paging','measured RAM/VRAM/disk budget'],note:'GGUF is not a Linux executable. Changing a file extension or container does not remove computation or memory requirements.'};
 if(b.subarray(0,4).equals(Buffer.from([0x7f,69,76,70])))return {...base,kind:'executable',format:'ELF',status:process.platform==='darwin'?'source-port-or-compatible-runtime-required':'architecture-and-ABI-validation-required',note:'A Linux executable is not made native by renaming it; source-level porting, compatible runtime or capability reconstruction and behavioral tests are required.'};
 if(b.length>=4&&[0xfeedface,0xfeedfacf,0xcefaedfe,0xcffaedfe,0xcafebabe].includes(b.readUInt32BE(0)))return {...base,kind:'executable',format:'Mach-O',status:'architecture-dependencies-signature-validation-required'};
 if(b.subarray(0,2).toString()==='MZ')return {...base,kind:'executable',format:'PE-candidate',status:'source-port-or-compatible-runtime-required'};
 return {...base,kind:'source-or-data',format:'unclassified',status:'capability-analysis-required'};
}
// A small complete Linux utility with two observable capabilities. Only this reviewed
// dialect is automatically reconstructed; arbitrary source never gets executed here.
export const GNU_FILE_REPORT_SOURCE=`#!/bin/sh\nset -eu\nfile=$1\nbytes=$(/usr/bin/stat -c '%s' -- "$file")\nresult=$(sha256sum -- "$file")\nprintf '%s\\t%s\\n' "$bytes" "\${result%% *}"\n`;
const PORTABLE_FILE_REPORT=`import {lstat} from 'node:fs/promises';\nimport {createReadStream} from 'node:fs';\nimport {createHash} from 'node:crypto';\nconst file=process.argv[2];if(!file)throw Error('file argument required');\nconst st=await lstat(file);if(!st.isFile()&&!st.isSymbolicLink())throw Error('regular file or file symlink required');\nconst h=createHash('sha256');for await(const b of createReadStream(file))h.update(b);\nprocess.stdout.write(String(st.size)+'\\t'+h.digest('hex')+'\\n');\n`;
export async function reconstructMacFileReport({sourcePath,workDir}={}){
 const st=await lstat(sourcePath);if(!st.isFile()||st.size>64*1024)throw Error('compatibility: bounded regular source file required');
 const source=await readFile(sourcePath,'utf8');if(source!==GNU_FILE_REPORT_SOURCE)throw Error('compatibility: source capabilities not recognized; independent reconstruction and behavioral tests required');
 const root=await realpath(workDir),dir=await mkdtemp(join(root,'mac-compatible-'));const file=join(dir,'file-report.mjs');await writeFile(file,PORTABLE_FILE_REPORT,{flag:'wx'});
 const receipt={schema:'kingmaker.platform-reconstruction/1',status:'reconstructed-awaiting-behavioral-tests',sourceSha256:hash(source),artifact:{path:file,sha256:hash(PORTABLE_FILE_REPORT)},target:{runtime:'Node.js22+',platform:'darwin',arch:'portable'},capabilities:['report file or symlink metadata size in bytes','stream SHA256 of file content','emit size TAB digest newline','preserve filenames including spaces and Unicode'],limits:['Only exact reviewed GNU source dialect automatically reconstructed.','Not a general Linux binary converter or universal capability-preservation claim.','Runtime execution and independent equivalence tests required before validated status.'],sourceExecuted:false};
 await writeFile(join(dir,'reconstruction.json'),JSON.stringify(receipt,null,2));return receipt;
}
export async function verifyMacFileReport(receipt){
 const {spawnSync}=await import('node:child_process');const {rm}=await import('node:fs/promises');
 const text=await readFile(receipt?.artifact?.path,'utf8');if(text!==PORTABLE_FILE_REPORT||receipt.artifact.sha256!==hash(text))throw Error('compatibility: reviewed target changed');
 const dir=await mkdtemp(join(await realpath(join(receipt.artifact.path,'..')),'behavior-test-'));
 const vectors=[{name:'empty',text:'',sha:'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'},{name:'unicode 空间 abc',text:'abc',sha:'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'}];
 try{for(const v of vectors){const path=join(dir,v.name);await writeFile(path,v.text);const r=spawnSync(process.execPath,[receipt.artifact.path,path],{encoding:'utf8',timeout:5000,maxBuffer:64*1024,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});if(r.status!==0||r.stdout!==`${Buffer.byteLength(v.text)}\t${v.sha}\n`)throw Error('compatibility: real runtime behavior did not match independent SHA256 vectors');}}
 finally{await rm(dir,{recursive:true,force:true});}
 const verification={...receipt,status:'behaviorally-validated-scoped',verification:{tier:'BEHAVIOR-SCOPED',runtime:process.version,platform:process.platform,arch:process.arch,passed:vectors.length,oracle:'independent published SHA256 empty/abc vectors; exact output and Unicode filename',limitations:['Known utility capability scope only, not arbitrary program equivalence.']}};
 await writeFile(join(receipt.artifact.path,'..','verification.json'),JSON.stringify(verification,null,2),{flag:'wx'});return verification;
}
export async function cmdCompatibilityTranslation(args){
 if(args[0]==='--inspect-compatibility'&&args.length===2){console.log(JSON.stringify(await inspectCompatibility(args[1]),null,2));return 0;}
 const i=args.indexOf('--dir');if(!args.includes('--mac-compatible')||i<0||!args[0]||!args[i+1])throw Error('usage: kingmaker translate SOURCE --mac-compatible --dir EXISTING_DIR');
 const result=await verifyMacFileReport(await reconstructMacFileReport({sourcePath:args[0],workDir:args[i+1]}));console.log(JSON.stringify(result,null,2));return 0;
}
