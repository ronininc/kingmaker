import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyTask,leavesLocalWeights,beforeModelSelection} from '../lib/weight-hunter.mjs';
import {ruleLane} from '../lib/fast-route.mjs';
const request='Create and render a metallic cyberpunk control panel from the declarative workflow.';
const library={models:[{tag:'local-coder',roles:['coder'],picks:[{role:'coder'}],bench:[{fits:true,tokS:30,tools:90,route:90,write:90}],weights:{sha256:'a'.repeat(64),parts:[{name:'x',size:1}]}}]};
test('render workflow selects planning role without entering prose fast lane',()=>{
 for(const text of [request,'Create a Blender scene with a beveled cube.','Prepare a 3D animation']) {
  assert.equal(classifyTask(text),'coder');assert.equal(ruleLane(text),'act');assert.equal(leavesLocalWeights(text),true);
 }
});
test('exact request selects local coder without download or execution',async()=>{
 let materializations=0;
 const result=await beforeModelSelection({text:request,calibration:{weightHunter:{on:true}},library,installed:['local-coder'],allowDownload:false,ensure:async()=>{materializations++;}});
 assert.equal(result.hunted,true);assert.equal(result.model,'local-coder');assert.equal(result.role,'coder');assert.equal(materializations,0);assert.equal(leavesLocalWeights(request),true);
 const missing=await beforeModelSelection({text:request,calibration:{weightHunter:{on:true}},library,installed:[],allowDownload:false,ensure:async()=>{materializations++;}});
 assert.equal(missing.blocked,true);assert.equal(materializations,0);
});
test('external actions and ordinary image/text requests retain routing',()=>{
 assert.equal(classifyTask('Send a message to Robbie'),null);
 assert.equal(ruleLane('Create a poster for the event'),'image');
 assert.equal(classifyTask('Write a story about a Blender scene'),'writer');
 assert.equal(ruleLane('Create a Blender scene then email it to Robbie'),'act');
 assert.equal(leavesLocalWeights('Create a Blender scene then email it to Robbie'),true);
});
