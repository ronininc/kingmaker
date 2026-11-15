import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAssetDelivery} from '../lib/asset-library-delivery.mjs';
const h=b=>createHash('sha256').update(b).digest('hex');
const bytes=Buffer.from('abcdefghij');
const asset={id:'fixture',bytes:10,sha256:h(bytes),url:'https://assets.example/file',title:'Fixture',author:'Test',license:'test-local-only',licenseUrl:'https://assets.example/license',source:'https://assets.example/source',changes:'none',chunkBytes:4,chunkSha256:[h(bytes.subarray(0,4)),h(bytes.subarray(4,8)),h(bytes.subarray(8))]};
const approve=async q=>({approved:true,manifestSha256:q.manifestSha256});
const transport=async(url,o)=>{assert.equal(o.redirect,'error');const [,s,e]=/bytes=(\d+)-(\d+)/.exec(o.headers.Range);return new Response(bytes.subarray(+s,+e+1),{status:206,headers:{'content-range':`bytes ${s}-${e}/10`}});};
const make=o=>createAssetDelivery({asset,approvedOrigins:['https://assets.example'],admit:approve,fetchImpl:transport,...o});
test('ranges are verified but explicitly not renderable',async()=>{const r=await make().readChunk(1);assert.equal(r.bytes.toString(),'efgh');assert.equal(r.renderable,false);});
test('unapproved origin and missing rights fail closed',async()=>{assert.throws(()=>make({approvedOrigins:[]}));await assert.rejects(make({admit:async()=>({approved:false})}).readChunk(0),/not admitted/);});
test('server ignoring range or tampering fails',async()=>{await assert.rejects(make({fetchImpl:async()=>new Response(bytes)}).readChunk(0),/range response/);await assert.rejects(make({fetchImpl:async()=>new Response('xxxx',{status:206,headers:{'content-range':'bytes 0-3/10'}})}).readChunk(0),/integrity/);});
test('full download preserves exact bytes and metadata',async()=>{const root=await mkdtemp(join(tmpdir(),'asset-delivery-'));try{const r=await make().download({outputRoot:root,maxBytes:10});assert.deepEqual(await readFile(r.path),bytes);assert.equal(r.manifest.license,asset.license);assert.equal(r.renderable,false);}finally{await rm(root,{recursive:true,force:true});}});
test('budget and full digest failures leave no payload',async()=>{const root=await mkdtemp(join(tmpdir(),'asset-delivery-'));try{await assert.rejects(make().download({outputRoot:root,maxBytes:9}),/budget/);await assert.rejects(make({asset:{...asset,sha256:'0'.repeat(64)}}).download({outputRoot:root,maxBytes:10}),/full asset digest/);assert.deepEqual(await readdir(root),[]);}finally{await rm(root,{recursive:true,force:true});}});

test('CLI reviewed download uses exact destination and manifest before any network',async()=>{
 const {cmdAssetDownload}=await import('../lib/asset-library-cli.mjs');const {writeFile}=await import('node:fs/promises');
 const root=await mkdtemp(join(tmpdir(),'asset-cli-'));try{const path=join(root,'manifest.json');await writeFile(path,JSON.stringify(asset));const args=['--manifest',path,'--work-dir',root,'--max-bytes','10'];let review;await cmdAssetDownload(args,{write:r=>review=r,fetchImpl:()=>{throw new Error('preview must not fetch');}});assert.equal(review.status,'approval-required');await assert.rejects(cmdAssetDownload([...args,'--approve','wrong'],{fetchImpl:transport}),/mismatch/);let result;await cmdAssetDownload([...args,'--approve',review.reviewSha256],{write:r=>result=r,fetchImpl:transport});assert.deepEqual(await readFile(result.path),bytes);}finally{await rm(root,{recursive:true,force:true});}
});
