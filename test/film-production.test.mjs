import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateFilmPlan, produceFilm, runFilmTool, requireFilmQuality, FILM_CAPABILITIES } from '../lib/film-production.mjs';
const plan = () => ({schema:'kingmaker.film-plan/1', title:'Proof', width:128,height:128,fps:2,shots:[{id:'desk',frames:4,camera:{position:[3,-5,3],target:[0,0,0]},objects:[{kind:'cube',position:[0,0,0],scale:[2,1,0.2],color:[0.03,0.04,0.05]}]}]});
test('accepts data-only shot plan and supplies bounded defaults', () => {const p=validateFilmPlan(plan());assert.equal(p.shots[0].camera.lens,45);assert.equal(p.shots[0].objects[0].emission,0);});
test('accepts JSON fenced model output', () => assert.equal(validateFilmPlan('```json\n'+JSON.stringify(plan())+'\n```').title,'Proof'));
test('rejects invalid structured model answer instead of substituting demo', () => {for (const x of ['hello','{"schema":"wrong"}',null]) assert.throws(()=>validateFilmPlan(x));});
test('rejects unsafe/duplicate IDs', () => {let p=plan();p.shots[0].id='../out';assert.throws(()=>validateFilmPlan(p));p=plan();p.shots.push({...p.shots[0]});assert.throws(()=>validateFilmPlan(p));});
test('rejects code primitives and unbounded transforms', () => {let p=plan();p.shots[0].objects[0].kind='python';assert.throws(()=>validateFilmPlan(p));p=plan();p.shots[0].objects[0].position=[Infinity,0,0];assert.throws(()=>validateFilmPlan(p));});
test('rejects unsafe audio references and requires provenance',()=>{for(const path of ['/tmp/a.wav','../a.wav','..\\a.wav']){const p=plan();p.audio={path,source:'owner',license:'owner'};assert.throws(()=>validateFilmPlan(p));}const p=plan();p.audio={path:'audio.wav'};assert.throws(()=>validateFilmPlan(p));});
test('rejects excessive frame counts and invalid dimensions',()=>{const p=plan();p.shots[0].frames=999999;assert.throws(()=>validateFilmPlan(p));p.shots[0].frames=4;p.width=127;assert.throws(()=>validateFilmPlan(p));});
test('strips executable-looking unknown data instead of executing it',()=>{const p=plan();p.command='rm -rf /';p.shots[0].script='import os';const v=validateFilmPlan(p);assert.equal(v.command,undefined);assert.equal(v.shots[0].script,undefined);});
test('does not resolve tools from PATH', async()=> {const d=await mkdtemp(join(tmpdir(),'film-test-'));try {await assert.rejects(produceFilm({plan:plan(),workDir:d,tools:{blender:'blender',ffmpeg:'ffmpeg',ffprobe:'ffprobe'}}),/approved blender absolute path/);}finally{await rm(d,{recursive:true,force:true});}});
test('child failure and deadline reject instead of manufacturing success',async()=>{await assert.rejects(runFilmTool(process.execPath,['-e','process.exit(2)'],{cwd:tmpdir()}));await assert.rejects(runFilmTool(process.execPath,['-e','setTimeout(()=>{},10000)'],{cwd:tmpdir(),timeoutMs:30}));});

test('quality target cannot silently downgrade to procedural proof',async()=>{assert.equal(requireFilmQuality().productionQualityCertified,false);assert.ok(Object.isFrozen(FILM_CAPABILITIES));for(const target of ['cyberpunk-2077','cinematic-production','photorealistic',null]) {assert.throws(()=>requireFilmQuality(target),/No silent downgrade/);assert.throws(()=>validateFilmPlan({...plan(),qualityTarget:target}),/No silent downgrade/);}await assert.rejects(produceFilm({plan:plan(),qualityTarget:'cinematic-production'}),/No silent downgrade/);assert.equal(validateFilmPlan(plan()).qualityTarget,'procedural-proof');});
