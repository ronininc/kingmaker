import test from 'node:test';
import assert from 'node:assert/strict';
import {explainReview} from '../review-presentation.mjs';
import {attachReviewControls} from '../review-controls.mjs';
function fixture(){
  const elements=new Map(),events={},requests=[],messages=[],native=[];
  const q=selector=>{if(!elements.has(selector))elements.set(selector,{style:{},value:'',hidden:false,textContent:'',files:[]});return elements.get(selector);};
  const window={webkit:{messageHandlers:{armorFileEjection:{postMessage:body=>native.push(body)}}}};
  const result={review:{disposition:'reviewed',announcement:'Fixture reviewed.',preview:{text:'<script>inert text</script>',notice:'Inert fixture',truncated:false}},source:null};
  const controls=attachReviewControls({q,window,location:{search:'?native=1'},document:{addEventListener:(event,handler)=>{events[event]=handler;}},
    call:async(route,options)=>{requests.push({route,options});return result;},feedback:(message)=>messages.push(message),refresh:async()=>{}});
  const drop=(files,uri='',text='')=>events.drop({preventDefault(){},stopPropagation(){},dataTransfer:{files,getData:type=>type==='text/uri-list'?uri:text}});
  return {q,events,requests,messages,native,controls,drop,window};
}
test('file drop uses upload bytes and plain-text preview, never HTML insertion',async()=>{
  const f=fixture(),file={name:'fixture file.txt',size:12};await f.drop([file]);
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].route,'/api/review/upload');assert.equal(f.requests[0].options.body,file);
  assert.equal(f.requests[0].options.headers['x-armor-filename'],'fixture%20file.txt');
  assert.equal(f.q('#reviewPreview').textContent,'<script>inert text</script>');assert.equal(f.q('#reviewPreview').innerHTML,undefined);
  assert.equal(f.q('#ejectOriginal').hidden,true);
});
test('compact chooser opens a picker and the selected file is reviewed automatically',async()=>{
  const f=fixture();let chosen=false;f.q('#reviewFile').click=()=>{chosen=true;};
  f.q('#reviewUpload').onclick();assert.equal(chosen,true);assert.equal(f.requests.length,0);
  f.q('#reviewFile').files=[{name:'inert.txt',size:12}];await f.q('#reviewFile').onchange();
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].route,'/api/review/upload');
});
test('browser URI and plain-text drops select link intake; multiple files and unsafe schemes are refused',async()=>{
  const f=fixture();await f.drop([],'# browser URL\r\nhttps://example.com/path');
  assert.equal(f.requests[0].route,'/api/review/link');assert.deepEqual(JSON.parse(f.requests[0].options.body),{url:'https://example.com/path'});
  await f.drop([],'','https://github.com/fixture/repo');assert.equal(f.requests.length,2);
  await f.drop([{name:'a',size:1},{name:'b',size:1}]);await f.drop([],'file:///private/fixture');
  assert.equal(f.requests.length,2);assert.equal(f.messages.length,2);
});
test('native removal button sends only a receipt ID; rejection never leaves a preview',()=>{
  const f=fixture();f.controls.showReview({review:{disposition:'ejected',announcement:'Danger HIGH',preview:null},sourceEjectionId:'fixture-receipt'});
  assert.equal(f.q('#reviewPreviewPanel').hidden,true);assert.equal(f.q('#reviewPreview').textContent,'');
  f.q('#ejectOriginal').onclick();assert.deepEqual(f.native,[{id:'fixture-receipt'}]);
  f.controls.showEjection({ejection:{announcement:'Original fixture removed.'}});assert.equal(f.q('#ejectOriginal').hidden,true);
});

test('native drop geometry tracks scrolling and resize without carrying paths or commands',()=>{
 const elements=new Map(),events={},frames=[],sent=[];
 const q=id=>{if(!elements.has(id))elements.set(id,{style:{}});return elements.get(id);};
 let rect={x:20,y:500,width:780,height:140};q('#reviewDropzone').getBoundingClientRect=()=>rect;
 const window={webkit:{messageHandlers:{armorDropGeometry:{postMessage:body=>sent.push(body)}}},requestAnimationFrame:fn=>frames.push(fn),addEventListener:(e,fn)=>events[e]=fn};
 attachReviewControls({q,window,location:{search:'?native=1'},document:{addEventListener:(e,fn)=>events[e]=fn},call:()=>{},feedback:()=>{},refresh:()=>{}});
 frames.shift()();assert.deepEqual(sent,[rect]);
 rect={x:20,y:-200,width:780,height:140};events.scroll();events.resize();assert.equal(frames.length,1);frames.shift()();
 assert.deepEqual(sent[1],rect);assert.deepEqual(Object.keys(sent[1]).sort(),['height','width','x','y']);
});

test('named findings report carries exact evidence and never renders it as HTML',()=>{
 const f=fixture();f.window.webkit.messageHandlers.armorSaveFindingReport={postMessage:body=>f.native.push(body)};
 f.controls.showReview({source:{repository:'fixture/repository'},review:{format:'Source text',disposition:'ejected',announcement:'Potential risk',findings:[{rule:'fixture-rule',title:'Fixture vector',severity:'high',location:'fixture.mjs:2',excerpt:'<script>inert</script>',detail:'Fixture evidence only'}]}});
 f.q('#downloadFindingReport').onclick();const saved=JSON.parse(f.native[0].text);assert.match(f.native[0].title,/fixture\/repository/);assert.equal(saved.review.findings[0].location,'fixture.mjs:2');assert.equal(saved.review.findings[0].excerpt,'<script>inert</script>');assert.match(saved.basis,/not proof/);
});

test('documentation risk patterns request an admin decision and retain inert visibility rather than asserting a breach',()=>{
 const r=explainReview({findings:[{rule:'source-composite-critical',severity:'critical',detail:'Independent pattern combination'}]}, {format:'HTML',kind:'data',texts:[{name:'webpage.html',text:'<html><script>inert fixture</script>Useful notes</html>'}],limitations:['Inert text only'],activeContent:true},Buffer.from('fixture'));
 assert.equal(r.disposition,'review-needed');assert.match(r.announcement,/admin decision/);assert.match(r.announcement,/do not prove/);assert.ok(r.preview);assert.doesNotMatch(r.preview.text,/<script>/);assert.match(r.preview.text,/Useful notes/);
});
