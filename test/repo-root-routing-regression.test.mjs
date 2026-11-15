import test from 'node:test';
import assert from 'node:assert/strict';
import {repoIndexUrl,createRepoReadText} from '../lib/brain-library-repo.mjs';
const baseUrl='https://raw.githubusercontent.com/ronininc/kingmaker-tools/main';
test('explicit root-lane source produces exact training path without activating it by default',()=>{
 assert.equal(repoIndexUrl('training',{baseUrl,intelligencePath:''}),`${baseUrl}/training/index.json`);
 assert.equal(repoIndexUrl('methods',{baseUrl:baseUrl+'/',intelligencePath:'/'}),`${baseUrl}/methods/index.json`);
 assert.equal(repoIndexUrl('skills',{baseUrl,intelligencePath:'/intelligence/'}),`${baseUrl}/intelligence/skills/index.json`);
 assert.match(repoIndexUrl('training'),/kingmaker-brain-library\/main\/intelligence\/training\/index.json$/);
});
test('injected private-repo transport receives exact configured path, no implicit auth or admission',async()=>{
 let called;
 const reader=createRepoReadText({baseUrl,intelligencePath:'',fetchImpl:async(url,opts)=>{called={url,opts};return {ok:true,text:async()=> 'fixture supply only'};}});
 assert.equal(await reader(repoIndexUrl('training',{baseUrl,intelligencePath:''})),'fixture supply only');
 assert.equal(called.url,`${baseUrl}/training/index.json`);assert.equal(called.opts.headers,undefined);
});
test('root lane fallback maps to the same bundled lane, not an arbitrary path',async()=>{
 let disk;
 const reader=createRepoReadText({baseUrl,intelligencePath:'',fetchImpl:async()=>({ok:false,status:404}),fallbackCatalogUrl:'file:///fixture/catalog/',readDisk:async loc=>{disk=String(loc);return 'floor';}});
 assert.equal(await reader(`${baseUrl}/training/index.json`),'floor');assert.equal(disk,'file:///fixture/catalog/training/index.json');
 await assert.rejects(reader('https://other.invalid/training/index.json'),/404/);
});
