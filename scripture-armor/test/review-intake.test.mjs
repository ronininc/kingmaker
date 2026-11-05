import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {isPublicAddress,publicReviewURL,fetchPublicBytes,retrieveReviewLink} from '../review-intake.mjs';
function transport(replies,calls=[]) {
  return (options,callback)=>{
    calls.push(options);const req=new EventEmitter();
    req.setTimeout=()=>{};req.destroy=()=>{};
    req.end=()=>queueMicrotask(()=>{
      const reply=replies.shift();assert.ok(reply,'no unexpected network hop');
      const response=Readable.from([Buffer.from(reply.body||'fixture')]);
      response.statusCode=reply.status||200;response.headers=reply.headers||{};
      callback(response);
    });return req;
  };
}
const resolve=async()=>[{address:'8.8.8.8',family:4}];
test('local, reserved, mapped, non-HTTPS and credential URLs are denied',()=>{
  for(const address of ['127.0.0.1','10.1.2.3','169.254.169.254','192.168.1.1','100.64.1.1','0.0.0.0','198.18.1.1','224.0.0.1','::1','::ffff:8.8.8.8','fe80::1','fc00::1','2001:db8::1','2002:0808:0808::1'])assert.equal(isPublicAddress(address),false,address);
  for(const address of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111'])assert.equal(isPublicAddress(address),true,address);
  for(const url of ['file:///etc/passwd','http://example.com','https://127.1/','https://2130706433/','https://[::1]/','https://example.com:8443/','https://user:pass@example.com/'])assert.throws(()=>publicReviewURL(url));
});
test('DNS is validated and pinned; outgoing headers carry no browser or account credentials',async()=>{
  const calls=[];const result=await fetchPublicBytes('https://public.invalid/page',{resolve,request:transport([{body:'fixture page'}],calls)});
  assert.equal(result.bytes.toString(),'fixture page');assert.equal(calls.length,1);
  assert.equal(calls[0].agent,false);assert.equal(calls[0].rejectUnauthorized,true);assert.equal(calls[0].servername,'public.invalid');
  assert.equal(calls[0].headers.cookie,undefined);assert.equal(calls[0].headers.authorization,undefined);assert.equal(calls[0].headers.referer,undefined);
  calls[0].lookup('public.invalid',{},(error,address,family)=>{assert.equal(error,null);assert.equal(address,'8.8.8.8');assert.equal(family,4);});
  await assert.rejects(fetchPublicBytes('https://public.invalid',{resolve:async()=>[{address:'127.0.0.1',family:4}],request:()=>{throw Error('must not connect');}}),/private|reserved/);
});
test('redirects cannot reach private networks and oversized/compressed responses fail closed',async()=>{
  await assert.rejects(fetchPublicBytes('https://public.invalid',{resolve,request:transport([{status:302,headers:{location:'https://169.254.169.254/'}}])}),/public HTTPS/);
  await assert.rejects(fetchPublicBytes('https://public.invalid',{resolve,request:transport([{body:'0123456789'}]),maxBytes:4}),/larger than/);
  await assert.rejects(fetchPublicBytes('https://public.invalid',{resolve,request:transport([{headers:{'content-encoding':'gzip'}}])}),/Compressed/);
  await assert.rejects(fetchPublicBytes('https://public.invalid',{resolve,request:transport(Array.from({length:4},()=>({status:302,headers:{location:'https://public.invalid/again'}})))}),/Too many/);
});
test('repository intake pins README bytes, excludes executable modes and reports partial coverage',async()=>{
  const bytes=Buffer.from('# Inert repository fixture\n'),sha='a'.repeat(40),tree='b'.repeat(40);
  const blob=crypto.createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');
  const calls=[];
  const fetchBytes=async url=>{calls.push(url);return {bytes:url.endsWith('/commits/HEAD')?Buffer.from(JSON.stringify({sha,commit:{tree:{sha:tree}}})):url.includes('/git/trees/')?Buffer.from(JSON.stringify({truncated:true,tree:[{path:'README.md',sha:blob,type:'blob',mode:'100644',size:bytes.length},{path:'linked-file',type:'blob',mode:'120000'}]})):bytes};};
  const result=await retrieveReviewLink('https://github.com/fixture/repository',{fetchBytes});
  assert.equal(result.source.commit,sha);assert.equal(result.source.files.length,1);assert.equal(result.source.inventoryLimited,true);
  assert.match(result.source.scope,/not a scan/);assert.ok(calls[2].includes('/'+sha+'/README.md'));
  await assert.rejects(retrieveReviewLink('https://github.com/fixture/repository',{fetchBytes:async url=>{const r=await fetchBytes(url);return url.includes('raw.githubusercontent')?{bytes:Buffer.from('changed')}:r;}}),/does not match/);
});

test('large text pages receive an explicitly bounded prefix while API and binary payloads fail closed',async()=>{
 const response=await fetchPublicBytes('https://public.invalid',{resolve,request:transport([{body:'0123456789',headers:{'content-type':'text/html; charset=utf-8'}}]),maxBytes:4,allowPartial:true});
 assert.equal(response.bytes.toString(),'0123');assert.equal(response.truncated,true);
 await assert.rejects(fetchPublicBytes('https://public.invalid',{resolve,request:transport([{body:'0123456789',headers:{'content-type':'application/octet-stream'}}]),maxBytes:4,allowPartial:true}),/No complete review/);
 const intake=await retrieveReviewLink('https://public.invalid/page',{fetchBytes:async()=>({bytes:Buffer.from('prefix'),contentType:'text/html',url:'https://public.invalid/page',truncated:true})});
 assert.equal(intake.source.partial,true);assert.match(intake.source.scope,/remaining response was not inspected/);
});

test('repository inventories walk pinned trees incrementally without a recursive response or total entry cutoff',async()=>{
 const sha='a'.repeat(40),tree='b'.repeat(40),child='c'.repeat(40),calls=[];
 const fetchBytes=async url=>{calls.push(url);let value=url.endsWith('/commits/HEAD')?{sha,commit:{tree:{sha:tree}}}:url.endsWith('/'+tree)?{tree:[{type:'tree',path:'src',sha:child}]}:{tree:Array.from({length:150},(_,i)=>({type:'blob',mode:'100644',path:'file'+i+'.txt',size:1,sha:'d'.repeat(40)}))};return {bytes:Buffer.from(JSON.stringify(value))};};
 const result=await retrieveReviewLink('https://github.com/fixture/large',{fetchBytes});assert.equal(result.source.fileCount,150);assert.equal(result.source.files.length,100);assert.equal(result.source.inventoryIncomplete,false);assert.equal(result.source.inventoryLimited,true);assert.ok(calls.every(url=>!url.includes('recursive=')));
});
