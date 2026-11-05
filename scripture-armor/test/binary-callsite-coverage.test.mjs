import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runGhidraExporter, normalizeBinaryFindings } from '../scan.mjs';
const zero = { paths_total:0, paths_omitted:0, sites_total:0, sites_omitted:0, decompile_eligible:0, decompile_omitted:0 };
const base = {functions_count:3,imports:[],call_paths:[],call_sites:[],sections:[],decompile:{attempted:0,failed:0},coverage:zero};
function store(fn){const d=fs.mkdtempSync(path.join(os.tmpdir(),'armor-calls-'));try{return fn(d);}finally{fs.rmSync(d,{recursive:true,force:true});}}
test('capped, missing, malformed or inconsistent observation coverage never earns full confidence',()=>store(d=>{
 for(const coverage of [undefined,{}, {...zero,paths_omitted:-1},{...zero,sites_total:1},{...zero,paths_total:1,paths_omitted:1},{...zero,decompile_eligible:25,decompile_omitted:25}]) {
  assert.equal(normalizeBinaryFindings({...base,coverage},'0'.repeat(64),d).confidence,'low');
 }
}));
test('instruction addresses retain distinct calls; unknown is neither literal-safe nor proven injection',()=>store(d=>{
 const paths=['100','104'].map(addr=>({from:{name:'main',addr:'90'},via:'main',sink:'system',sink_site:{addr},arg_literal:null,argument_evidence:'unknown'}));
 const result=normalizeBinaryFindings({...base,call_paths:paths,coverage:{...zero,paths_total:2}},'0'.repeat(64),d);
 const sinks=result.findings.filter(f=>f.rule==='sink-reachability');assert.equal(sinks.length,2);assert(sinks.every(f=>f.severity==='high'&&/UNKNOWN/.test(f.detail)));assert.equal(result.confidence,'low');
}));
test('legacy truthy literal fields cannot grant safety',()=>store(d=>{
 const p={from:{name:'main'},sink:'system',arg_literal:'true'};
 const r=normalizeBinaryFindings({...base,call_paths:[p],coverage:{...zero,paths_total:1}},'0'.repeat(64),d);
 assert.equal(r.findings.find(f=>f.rule==='sink-reachability').severity,'high');assert.equal(r.confidence,'low');
}));
test('real Ghidra: inert multiple clean/dynamic sink calls never inherit first literal evidence', {skip:!process.env.ARMOR_TEST_PREREQUISITES,timeout:180000},async()=>{
 const prereq=JSON.parse(fs.readFileSync(process.env.ARMOR_TEST_PREREQUISITES,'utf8'));
 const d=fs.mkdtempSync(path.join(os.tmpdir(),'armor-real-calls-'));
 try {
  const src=path.join(d,'inert.c'),binary=path.join(d,'inert');
  fs.writeFileSync(src,'#include <stdlib.h>\n#include <string.h>\n#include <stdio.h>\n__attribute__((noinline)) int mixed(char *arg){char buf[32]; system("fixed harmless text"); system(arg); popen(arg,"r"); return 0;}\nint main(int argc,char **argv){if(argc==123) return mixed(argv[1]); return 0;}\n');
  execFileSync('cc',['-O0','-g','-fno-builtin',src,'-o',binary]); // Compile only. Never execute fixture.
  const {obs}=await runGhidraExporter(binary,{policy:{scan:{ghidra_home:prereq.ghidraHome,jdk_home:prereq.jdkHome,timeout_s:150}},storeDir:d});
  const calls=obs.call_paths.filter(p=>p.sink==='system'&&p.via.includes('mixed'));
  assert(calls.length>=2,JSON.stringify(obs));assert(new Set(calls.map(p=>p.sink_site.addr)).size>=2);
  assert(calls.every(p=>p.arg_literal===null&&p.argument_evidence==='unknown'));
  assert(obs.call_paths.some(p=>p.sink==='popen'&&p.via.includes('mixed')&&p.argument_evidence==='unique-call-text'),'second sink derives its own evidence after cached decompile');
  assert.equal(obs.fid_status,'not-performed');assert.equal(obs.coverage.paths_total,obs.call_paths.length+obs.coverage.paths_omitted);
  assert.equal(normalizeBinaryFindings(obs,'0'.repeat(64),d).confidence,'low');
  const cappedSrc=path.join(d,'capped.c'),cappedBinary=path.join(d,'capped');
  const helpers=Array.from({length:26},(_,i)=>`__attribute__((noinline)) int helper${i}(void){return system("fixed ${i}");}`).join('\n');
  const many=Array.from({length:530},(_,i)=>`system("fixed many ${i}");`).join('\n');
  const invokes=Array.from({length:26},(_,i)=>`helper${i}();`).join('');
  fs.writeFileSync(cappedSrc,`#include <stdlib.h>\n${helpers}\n__attribute__((noinline)) void many(void){${many}}\nint main(int argc,char **argv){if(argc==123){many();${invokes}}return 0;}\n`);
  execFileSync('cc',['-O0','-g','-fno-builtin',cappedSrc,'-o',cappedBinary]);
  const capped=(await runGhidraExporter(cappedBinary,{policy:{scan:{ghidra_home:prereq.ghidraHome,jdk_home:prereq.jdkHome,timeout_s:150}},storeDir:d})).obs;
  assert(capped.coverage.paths_omitted>0,'64-path cap disclosed');assert(capped.coverage.sites_omitted>0,'512-site cap disclosed');assert(capped.coverage.decompile_omitted>0,'24-function cap disclosed');
  assert.equal(normalizeBinaryFindings(capped,'0'.repeat(64),d).confidence,'low');

 }finally{fs.rmSync(d,{recursive:true,force:true});}
});
