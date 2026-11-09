import {test}from'node:test';
import assert from'node:assert/strict';
import {mkdtempSync,readFileSync,statSync}from'node:fs';
import {tmpdir}from'node:os';
import {join}from'node:path';
import {createCrmUsageSync}from'../lib/crm-usage-sync.mjs';
const receipt=s=>({ok:true,receipt:{agent:s.agent,report_id:s.report_id,observed_at:s.observed_at,provenance:'paired_launcher_provider_report'}});
test('explicit flush only, numeric-only local log, unknown propagation and 0600',async()=>{
 const file=join(mkdtempSync(join(tmpdir(),'usage-proof-')),'usage.jsonl');let sends=0;
 const s=createCrmUsageSync({file,sessionId:'fixture',now:()=>1000000,send:async x=>{sends++;return receipt(x);}});
 s.observe({provider:'codex',prompt:12,generated:null,answer:'secret',api_key:'never'});
 s.observe({provider:'codex',prompt:3,generated:10});assert.equal(sends,0);
 assert.deepEqual(s.totals().codex,{prompt_tokens:15,generated_tokens:null});
 const log=readFileSync(file,'utf8');assert.doesNotMatch(log,/secret|api_key|answer/);assert.equal(statSync(file).mode&0o777,0o600);
 assert.equal((await s.flush()).ok,true);assert.equal(sends,1);assert.equal(s.pending(),0);
});
test('restart recovers the exact snapshot identity after an uncertain response',async()=>{
 const file=join(mkdtempSync(join(tmpdir(),'usage-restart-')),'usage.jsonl');
 const first=createCrmUsageSync({file,sessionId:'old',send:async()=>{throw Error('lost');}});
 first.observe({provider:'openai',prompt:9,generated:2});assert.equal((await first.flush()).ok,false);
 let sent;const next=createCrmUsageSync({file,send:async x=>{sent=x;return receipt(x);}});
 assert.equal((await next.flush()).ok,true);assert.equal(sent.report_id,'old:1');assert.equal(sent.prompt_tokens,9);
});
test('lost response retries exact id and forged receipt cannot clear pending data',async()=>{
 const sent=[];let fail=true;
 const s=createCrmUsageSync({sessionId:'retry',send:async x=>{sent.push(x);if(fail)throw Error('lost');return receipt(x);}});
 s.observe({provider:'claude-code',prompt:10,generated:5});assert.equal((await s.flush()).ok,false);
 fail=false;assert.equal((await s.flush()).ok,true);assert.equal(sent[0].report_id,sent[1].report_id);
 const bad=createCrmUsageSync({send:async()=>({ok:true})});bad.observe({provider:'grok',prompt:null,generated:null});
 assert.equal((await bad.flush()).reason,'unverified_receipt');assert.equal(bad.pending(),1);
});
test('provider failures and missing transport cannot break a turn or invent usage',async()=>{
 const s=createCrmUsageSync();assert.equal(s.observe({provider:'unknown',prompt:99}),false);
 s.observe({provider:'ollama',prompt:0,generated:0});assert.deepEqual(s.totals().kingmaker,{prompt_tokens:0,generated_tokens:0});
 assert.equal((await s.flush()).reason,'authenticated_transport_unavailable');
});
