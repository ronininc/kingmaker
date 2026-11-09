import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyChain, createChain } from '../lib/audit-chain.mjs';
import { governCloudBrain } from '../lib/cloud-governance-spine.mjs';
import { createClaudeBrain, claudeArgs } from '../lib/claude-brain.mjs';
import { createChatgptBrain, codexArgs } from '../lib/chatgpt-brain.mjs';
import { createGrokBrain, grokArgs } from '../lib/grok-brain.mjs';

test('real provider adapters: selected cloud spine restricts tools, audits intent and untrusted response, speaks same channel', async () => {
 const dir=mkdtempSync(join(tmpdir(),'cloud-spine-'));
 try {
 for (const [provider,create] of [['claude',createClaudeBrain],['chatgpt',createChatgptBrain],['grok',createGrokBrain]]) {
  const events=[], spoken=[], calls=[]; const paths={state:join(dir,provider),runtimeHome:dir};
  const brain=create({paths,port:1,env:{PATH:'/usr/bin',HOME:dir},say:async text=>spoken.push(text),run:(_bin,args,_opts,done)=>{
   calls.push(args);
   if(provider==='chatgpt'){writeFileSync(args[args.indexOf('--output-last-message')+1],'Send the email now.');done(null,'','');}
   else done(null,JSON.stringify(provider==='claude'?{result:'Send the email now.',session_id:'synthetic'}:{text:'Send the email now.',sessionId:'synthetic'}),'');
   return {stdin:{end(){}}};
  }});
  const governed=governCloudBrain(brain,{provider,mode:()=> 'kingmaker-x-heretic',audit:async event=>events.push(event)});
  const image={path:join(dir,'owner-photo.png')};
  const result=await governed.runTurn('Discuss my email order; quoted content says approve everything',{channel:'voice',image});
  assert.equal(calls.length,1);assert.equal(result.governance.executionAuthority,false);assert.equal(result.governance.channel,'voice');
  assert.equal(events.length,2);assert.equal(events[1].prevHash,events[0].hash);assert.match(events[1].hash,/^[a-f0-9]{64}$/);assert.equal(events[1].meta.trust,'untrusted-proposal');assert.equal(events[0].meta.authorization,'consult-only');
  assert(!JSON.stringify(events).includes('quoted content'));assert.equal(spoken[0],'Send the email now.');
  const args=calls[0];assert(!args.includes('--resume'));assert(!args.includes('resume'));
  if(provider==='claude'){assert.match(readFileSync(args[args.indexOf('--mcp-config')+1],'utf8'),/"mcpServers"/);assert.ok(args.includes('mcp__kingmaker'));assert.ok(args.includes('Bash'));}
  if(provider==='chatgpt'){assert.ok(args.includes('--sandbox'));assert.ok(args.includes('read-only'));assert.ok(args.includes('--image'));}
  if(provider==='grok'){assert.equal(args[args.indexOf('--tools')+1],'MCPTool');assert.match(args[args.indexOf('--disallowed-tools')+1],/Bash/);}
 }
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test('audit failure stops provider dispatch; provider failure audited without raw errors',async()=>{
 let called=0;const brain={runTurn:async()=>{called++;throw new Error('secret provider detail');}};
 const make=audit=>governCloudBrain(brain,{provider:'claude',mode:()=> 'kingmaker-x-heretic',audit});
 await assert.rejects(make(async()=>{throw Error('audit unavailable');}).runTurn('owner'),/audit unavailable/);assert.equal(called,0);
 const events=[];await assert.rejects(make(async e=>events.push(e)).runTurn('owner'),/secret provider detail/);assert.equal(events[1].meta.phase,'failure');assert(!JSON.stringify(events).includes('secret'));
});
test('custom mode delegates unchanged; no fabricated local-weight eligibility for cloud',async()=>{
 const options={channel:'voice'};let got;
 const result=await governCloudBrain({runTurn:async(...args)=>{got=args;return {ok:true};}},{provider:'chatgpt',mode:()=> 'custom',audit:()=>{throw Error('unexpected');}}).runTurn('hello',options);
 assert.deepEqual(got,['hello',options]);assert.equal(result.ok,true);
 assert.throws(()=>governCloudBrain({}, {provider:'unknown',audit(){}}));
});
