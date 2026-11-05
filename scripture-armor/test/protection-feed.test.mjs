import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {appendProtectionFeed,readProtectionFeed} from '../protection-feed.mjs';
test('polling reads a bounded tail and preserves newest valid events after malformed lines',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'armor-feed-proof-')),file=path.join(root,'feed.jsonl');
  try{
    for(let i=0;i<1200;i++)appendProtectionFeed(file,{i,message:'inert'.repeat(80)});
    fs.appendFileSync(file,'invalid fixture line\nnull\n42\n[]\n');appendProtectionFeed(file,{i:1200,message:'newest'});
    const original=fs.readFileSync;fs.readFileSync=(target,...args)=>{assert.notEqual(String(target),file,'feed must not be read in full');return original(target,...args);};
    let result;try{result=readProtectionFeed(file);}finally{fs.readFileSync=original;}
    assert.equal(result[0].i,1200);assert(result.length<=100);assert(result.length>90);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('feed aliases cannot overwrite or read unrelated files',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'armor-feed-alias-')),file=path.join(root,'feed.jsonl'),other=path.join(root,'other');
  try{
    fs.writeFileSync(other,'inert unrelated fixture');fs.symlinkSync(other,file);
    assert.throws(()=>appendProtectionFeed(file,{message:'inert'}));assert.deepEqual(readProtectionFeed(file),[]);
    fs.unlinkSync(file);fs.linkSync(other,file);assert.throws(()=>appendProtectionFeed(file,{message:'inert'}));
    assert.equal(fs.readFileSync(other,'utf8'),'inert unrelated fixture');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
