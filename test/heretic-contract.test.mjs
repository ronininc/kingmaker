import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAbliterationRequest, verifyProvenance, runAbliteration, HERETIC_UPSTREAM } from '../lib/abliterate-model.mjs';
import { createSpineContext, tapSession, resolveModelForInference, SPINES } from '../lib/governance-spine.mjs';
import { createRegistry, pinModel, canLoad } from '../lib/model-pin-registry.mjs';
import { resolveBrain } from '../lib/claude-brain.mjs';
import { codexArgs } from '../lib/chatgpt-brain.mjs';
const hash='a'.repeat(64);
test('local customization request cannot address hosted APIs, omit hash/tap, or overwrite input', () => {
  assert.equal(HERETIC_UPSTREAM,'https://github.com/p-e-w/heretic');
  const input={baseWeightsPath:'/fixture/base',outputPath:'/fixture/modified',expectedSha256:hash,sessionId:'fixture',founderTap:true};
  for(const change of [{baseWeightsPath:'https://api.openai.com/v1/models'},{baseWeightsPath:'claude'},{expectedSha256:'bad'},{founderTap:false},{outputPath:'/fixture/base'}]) assert.throws(()=>createAbliterationRequest({...input,...change}));
  assert.equal(createAbliterationRequest(input).expectedSha256,hash);
});
test('content hash verification is explicit and does not imply publisher/license approval', async () => {
  const request=createAbliterationRequest({baseWeightsPath:'/fixture/base',outputPath:'/fixture/out',expectedSha256:hash,founderTap:true});
  assert.equal((await verifyProvenance(request,{hashFile:async()=> 'b'.repeat(64)})).ok,false);
  assert.match((await verifyProvenance(request,{hashFile:async()=>hash})).scope,/publisher\/license review/);
});
test('unreviewed local runner stays gated and never spawns, fabricates path hash or auto-pins', async () => {
  let pins=0;const audit=[];
  const result=await runAbliteration({baseWeightsPath:'/fixture/base',expectedSha256:hash},{pinModel:()=>pins++,registry:{},auditAppend:(row)=>audit.push(row)});
  assert.equal(result.status,'GATED');assert.equal(pins,0);assert.equal(audit[0].meta.executed,false);
  const source=readFileSync(new URL('../lib/abliterate-model.mjs',import.meta.url),'utf8');assert.doesNotMatch(source,/child_process|spawn\(|createHash\(/);
});
test('existing local inference spine requires a pin and per-session owner tap; this is not hosted weight access', () => {
  const ctx=createSpineContext(SPINES.HERETIC),registry=createRegistry();
  assert.equal(resolveModelForInference(ctx,registry,canLoad,hash,'s').ok,false);
  pinModel(registry,{name:'synthetic',sha256:hash,source:'fixture',abliterated:true,license:'fixture'});
  assert.equal(resolveModelForInference(ctx,registry,canLoad,hash,'s').ok,false);
  tapSession(ctx,'s');assert.equal(resolveModelForInference(ctx,registry,canLoad,hash,'s').ok,true);
  assert.equal(resolveModelForInference(ctx,registry,canLoad,hash,'different-session').ok,false);
});
test('hosted assistant uses its ordinary governed read-only tool adapter, not Heretic modification', () => {
  assert.equal(resolveBrain({SOL_GHOST_BRAIN:'chatgpt'}),'chatgpt');
  const args=codexArgs({text:'Summarize these notes',port:3001,outFile:'/fixture/reply'});
  assert.ok(args.includes('read-only'));assert.ok(args.includes('--ignore-user-config'));
  assert.ok(args.some(arg=>arg.startsWith('mcp_servers.kingmaker.command=')));
  assert.equal(args.some(arg=>/heretic|abliterate|jailbreak/i.test(arg)),false);
  const cli=readFileSync(new URL('../lib/cli.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(cli,/createSpineContext|resolveModelForInference|runAbliteration/,'existing calibration-to-spine wiring is not implemented; do not claim this test proves it');
});
