import test from 'node:test';
import assert from 'node:assert/strict';
import {isExplicitReadiness} from '../lib/direct-reasoning.mjs';
import {preModelLane} from '../lib/prompt-lane.mjs';

test('media brief contents do not trigger self-readiness audit',()=>{
 for(const prompt of [
  'Make a Kingmaker reel explaining how the maturity gate works.',
  'Please create a video of Kingmaker showing the missing panels.',
  'Can you render a film about Kingmaker? Narrate when can the fleet grow.',
  'I need you to write a voiceover about Kingmaker and its permission gates.',
  'Produce a promo for Kingmaker with the caption: when can you use it?',
 ]) {assert.equal(isExplicitReadiness(prompt),false,prompt);assert.notEqual(preModelLane(prompt),'readiness',prompt);}
});
test('actual self-readiness requests still use the audit lane',()=>{
 for(const prompt of ['Is Kingmaker ready to make a reel?', 'Check Kingmaker maturity', 'What is missing from Kingmaker?', 'How close is Kingmaker?', 'What are your pass rates?', 'Are you mature enough?'])
  assert.equal(isExplicitReadiness(prompt),true,prompt);
});

test('engine source overlay preserves production asks as well as shell helper',async()=>{
 const {isSelfReadinessQuestion,buildSelfReadinessAnswer}=await import('../engine-overlays/server/src/runtime/self-readiness.ts');
 for(const prompt of ['Please make a Hoid reel explaining Kingmaker and every permission gate.', 'Can you create a Kingmaker video showing missing panels?'])
   assert.equal(isSelfReadinessQuestion(prompt),false,prompt);
 assert.equal(isSelfReadinessQuestion('Is Kingmaker ready to make a reel?'),true);
 assert.match(await buildSelfReadinessAnswer(async()=>{throw new Error('fixture gate unavailable');}),/won.t guess/);
});
