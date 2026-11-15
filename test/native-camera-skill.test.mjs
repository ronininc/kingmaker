import test from 'node:test';
import assert from 'node:assert/strict';
import {synthesizeCameraOrbit,projectCameraPoint} from '../lib/native-camera-skill.mjs';
import {executeNativeAssetSkill} from '../lib/native-asset-skills.mjs';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const generate=p=>JSON.parse(synthesizeCameraOrbit(p).files['cameras.json']);
test('target projects to center for every orbit; orthonormal right-handed frame',()=>{
 const r=generate({target:[1,2,3],count:16});
 for(const c of r.cameras){const p=projectCameraPoint(r,c.index,[1,2,3]);assert.ok(Math.abs(p[0]-320)<1e-9);assert.ok(Math.abs(p[1]-240)<1e-9);assert.ok(Math.abs(p[2]-3)<1e-9);const a=c.worldToCamera;for(let i=0;i<3;i++)for(let j=0;j<3;j++)assert.ok(Math.abs(a[i].slice(0,3).reduce((s,v,k)=>s+v*a[j][k],0)-(i===j?1:0))<1e-9);}
});
test('right/down projection and behind-camera rejection',()=>{const r=generate({elevation:0,count:1});assert.ok(projectCameraPoint(r,0,[0,0,-1])[0]>320);assert.ok(projectCameraPoint(r,0,[0,-1,0])[1]>240);assert.equal(projectCameraPoint(r,0,[4,0,0]),null);});
test('bounds and deterministic output',()=>{assert.deepEqual(generate({}),generate({}));for(const p of [{count:361},{elevation:90},{fov:NaN},{target:[1,2]},{radius:0}])assert.throws(()=>generate(p));});
test('built-in writes real receipt and calibration artifact',async()=>{const dir=await mkdtemp(join(tmpdir(),'km-camera-'));try{const r=await executeNativeAssetSkill({skill:'camera-orbit',parameters:{count:2},workDir:dir});assert.equal(r.record.status,'completed');assert.equal(JSON.parse(await readFile(r.record.artifacts[0].path)).cameras.length,2);assert.equal(r.record.qualityCertified,false);}finally{await rm(dir,{recursive:true,force:true});}});
