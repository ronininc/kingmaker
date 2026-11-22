import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createArmorDashboard} from '../dashboard.mjs';
import {createLoopbackClient} from './loopback-http.mjs';

test('real local account activation starts scanning automatically and Scan device accepts no path', {timeout:15000},async()=>{
  const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'armor-device-lifecycle-'))),scope=path.join(temp,'scope'),identityDir=path.join(temp,'identity');
  fs.mkdirSync(scope,{mode:0o700});const content='export const inertDeviceFixture = true;';fs.writeFileSync(path.join(scope,'inert.mjs'),content);
  const now=Math.floor(Date.now()/1000),remote=[];let installation;
  const json=(body,status=200,headers={})=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json',...headers}});
  const nativeToken='e'.repeat(64);
  const repoCode=Buffer.from('export const repositoryFixture = true;\n'),repoSha='a'.repeat(40),treeSha='b'.repeat(40),blobSha=crypto.createHash('sha1').update(Buffer.from(`blob ${repoCode.length}\0`)).update(repoCode).digest('hex');
  const server=createArmorDashboard({repositoryFetchBytes:async url=>({bytes:url.endsWith('/commits/HEAD')?Buffer.from(JSON.stringify({sha:repoSha,commit:{tree:{sha:treeSha}}})):url.includes('/git/trees/')?Buffer.from(JSON.stringify({tree:[{type:'blob',mode:'100644',path:'actual-source.mjs',sha:blobSha}]})):Buffer.from(repoCode)}),identityDir,nativeReviewToken:nativeToken,deviceProtection:true,deviceRoots:[scope],deviceResources:async()=>true,
    fetchImpl:async(url,options)=>{
      assert.equal(new URL(url).origin,'https://www.ronininc.org');
      const action=new URL(url).pathname.split('/').pop(),body=options.body?JSON.parse(options.body):null;remote.push({action,body});
      if(action==='login')return json({ok:true,emailCodeRequired:true,email:'fixture@example.test',purpose:'login',challengeId:'fixture',expiresAt:now+300},202);
      if(action==='verify')return json({ok:true,mfaVerified:true,member:{email:'fixture@example.test',paid:true}},200,{'set-cookie':`ronin_armor=${'f'.repeat(64)};HttpOnly;Secure;Path=/;SameSite=Strict`});
      if(action==='me')return json({ok:true,mfaVerified:true,member:{email:'fixture@example.test',paid:true,mfa_verified_at:now}});
      if(action==='reserve'){installation=body;return json({installationId:body.installationId,reserved:true,quotaReservationOnly:true,deviceAdmissionGranted:false});}
      if(action==='check')return json({ok:true,installationId:body.installationId,active:true,quotaReservationOnly:true,deviceAdmissionGranted:false});
      if(action==='entitlement')return json({schema:'ronin.armor-entitlement/v1',product:'scripture-armor',entitled:true,verifiedAt:now,term:{startsAt:now-10,endsAt:now+3600},discordAccess:'separate_verified_admission_required'});
      if(action==='logout')return json({ok:true});
      throw Error('unexpected fixture account endpoint');
    }});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port,local=createLoopbackClient(origin);
  try{
    const html=await(await local('/')).text(),token=JSON.parse(/const TOKEN=("[^"]+")/.exec(html)[1]);
    assert.match(html,/SCAN DEVICE/);assert.match(html,/Advanced: manual file analysis/);
    const headers={origin,'content-type':'application/json','x-scripture-armor-token':token};
    const post=(route,body={})=>local(route,{method:'POST',headers,body:JSON.stringify(body)});
    const status=async()=>await(await local('/api/status',{headers})).json();
    assert.equal((await status()).deviceScan.state,'waiting_for_login');
    assert.equal((await post('/api/device/scan')).status,403);
    assert.equal((await post('/api/account/login',{email:'fixture@example.test',password:'inert-fixture-password'})).status,200);
    assert.equal((await post('/api/account/verify',{code:'12345678'})).status,200);
    assert.equal((await status()).deviceScan.checked,0);
    // Disposable fixture terms/identity only; this does not operate a real
    // owner account, Keychain, installation, or external service.
    const activation=await post('/api/activate',{acceptTerms:true,confirmMigration:true});assert.equal(activation.status,200,await activation.text());
    let observed;
    for(let i=0;i<100;i++){observed=await status();if(observed.deviceScan.checked>0)break;await new Promise(resolve=>setTimeout(resolve,40));}
    assert.equal(observed.deviceScan.checked,1);assert.equal(observed.deviceScan.trigger,'activation');
    assert.equal(observed.deviceScan.wholeDeviceCoverageVerified,false);
    const upload=await local('/api/review/upload',{method:'POST',headers:{...headers,'content-type':'application/octet-stream','x-armor-filename':'inert.json'},body:Buffer.from('{"inertUpload":true}')});
    assert.equal(upload.status,200,await upload.clone().text());
    const reviewed=(await upload.json()).review;
    // Platform-conditional (owner ruling 2026-11-05): darwin reviews run in
    // the Seatbelt lane, linux reviews in the shipped namespace lane; each
    // platform asserts its own lane identity.
    assert.equal(reviewed.sandbox,process.platform==='darwin'?'macos-seatbelt':'linux-namespace');assert.equal(reviewed.targetExecuted,false);assert.equal(reviewed.format,'JSON');
    assert.equal((await post('/api/review/link',{url:'https://127.0.0.1/'})).status,400);
    const flagged=path.join(scope,'flagged-fixture.js');fs.writeFileSync(flagged,['ev','al'].join('')+'("1+1");');
    assert.equal((await post('/api/review/native-file',{path:flagged})).status,403);
    const nativePost=(route,body)=>local(route,{method:'POST',headers:{...headers,'x-armor-native-review-token':nativeToken},body:JSON.stringify(body)});
    assert.equal((await post('/api/review/native-link',{url:'https://example.com/'})).status,403);
    assert.equal((await nativePost('/api/review/native-link',{url:'https://127.0.0.1/'})).status,400);
    assert.equal((await post('/api/review/native-retain',{text:'Useful fixture notes'})).status,403);
    const retained=await nativePost('/api/review/native-retain',{text:'Useful fixture notes'});assert.equal(retained.status,200,await retained.clone().text());assert.equal((await retained.json()).retainedText,'Useful fixture notes');
    const unsafeRetain=await nativePost('/api/review/native-retain',{text:['ev','al'].join('')+'("1+1");'});assert.equal(unsafeRetain.status,422);assert.equal(fs.existsSync(flagged),true);
    assert.equal((await nativePost('/api/review/native-finding',{id:'missing'})).status,404);
    const nativeReview=await nativePost('/api/review/native-file',{path:flagged});assert.equal(nativeReview.status,200,await nativeReview.clone().text());
    const receipt=await nativeReview.json();assert.equal(receipt.review.disposition,'ejected');assert.ok(receipt.sourceEjectionId);assert.ok(receipt.review.retention);assert.equal(receipt.review.preview,null);
    assert.equal((await post('/api/review/eject-original',{id:receipt.sourceEjectionId,confirm:'PERMANENTLY_REMOVE_REVIEWED_FILE'})).status,403);
    assert.equal(fs.existsSync(flagged),true);
    assert.equal((await nativePost('/api/review/eject-original',{id:receipt.sourceEjectionId})).status,400);
    const removed=await nativePost('/api/review/eject-original',{id:receipt.sourceEjectionId,confirm:'PERMANENTLY_REMOVE_REVIEWED_FILE'});assert.equal(removed.status,200);
    assert.equal((await removed.json()).ejection.originalFileRemoved,true);assert.equal(fs.existsSync(flagged),false);
    const job=await post('/api/review/link',{url:'https://github.com/fixture/repository'});assert.equal(job.status,202);const jobId=(await job.json()).repositoryJob.id;
    let repoStatus;for(let i=0;i<100;i++){repoStatus=(await status()).repositoryReview;if(repoStatus.state==='completed')break;await new Promise(resolve=>setTimeout(resolve,60));}
    assert.equal(repoStatus.state,'completed');assert.equal(repoStatus.scanned,1);assert.equal(repoStatus.codeLines,1);assert.equal(repoStatus.commit,repoSha);
    assert.equal((await post('/api/review/native-report',{id:jobId})).status,403);
    const report=await nativePost('/api/review/native-report',{id:jobId});assert.equal(report.status,200);assert.match(await report.text(),/actual-source.mjs/);
    const manual=await post('/api/device/scan');assert.equal(manual.status,202);
    assert.equal((await post('/api/account/logout')).status,200);
    assert.equal((await status()).deviceScan.state,'stopped');
    assert.equal(fs.readFileSync(path.join(scope,'inert.mjs'),'utf8'),content);
    assert.equal(JSON.stringify(remote).includes(content),false);assert.equal(JSON.stringify(remote).includes('inertUpload'),false);assert.ok(installation);
  } finally {await new Promise(resolve=>server.close(resolve));fs.rmSync(temp,{recursive:true,force:true});}
});
