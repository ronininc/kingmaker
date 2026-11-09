import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAbliterationRequest, verifyProvenance, runAbliteration } from '../lib/abliterate-model.mjs';
import { createSpineContext, tapSession, resolveModelForInference, SPINES } from '../lib/governance-spine.mjs';
import { createRegistry, pinModel, canLoad } from '../lib/model-pin-registry.mjs';
import { resolveBrain } from '../lib/claude-brain.mjs';
import { codexArgs } from '../lib/chatgpt-brain.mjs';
const hash='a'.repeat(64);
test('shipped abliteration request requires a founder tap and the weight paths', () => {
  const input={baseWeightsPath:'/fixture/base',outputPath:'/fixture/modified',expectedSha256:hash,sessionId:'fixture',founderTap:true};
  assert.throws(()=>createAbliterationRequest({...input,founderTap:false}));
  assert.throws(()=>createAbliterationRequest({founderTap:true}));
  assert.equal(createAbliterationRequest(input).expectedSha256,hash);
});
test('provenance is the hash of the base file', async () => {
  const request=createAbliterationRequest({baseWeightsPath:'/fixture/base',outputPath:'/fixture/out',expectedSha256:hash,founderTap:true});
  assert.equal((await verifyProvenance(request,{hashFile:async()=> 'b'.repeat(64)})).ok,false);
  assert.equal((await verifyProvenance(request,{hashFile:async()=>hash})).ok,true);
});
test('the shipped runner is a heretic subprocess and does not import that package', () => {
  const source=readFileSync(new URL('../lib/abliterate-model.mjs',import.meta.url),'utf8');
  assert.match(source,/spawn\(/);
  assert.doesNotMatch(source,/from ['"]heretic/);
  assert.equal(typeof runAbliteration,'function');
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
