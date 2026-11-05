import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createDeviceProtection} from '../device-protection.mjs';
function fixture(t,extra={}) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'armor-device-proof-')));
  const scope=path.join(root,'scope'),identityDir=path.join(root,'identity');
  fs.mkdirSync(scope,{mode:0o700});fs.mkdirSync(identityDir,{mode:0o700});
  const calls=[],events=[];
  const audit=createDeviceProtection({identityDir,roots:[scope],isLicensed:()=>true,resources:async()=>true,
    delayMs:600000,analyze:async file=>{calls.push(fs.readFileSync(file,'utf8'));return {finding:false};},onEvent:(...e)=>events.push(e),...extra});
  t.after(async()=>{await audit.stop();fs.rmSync(root,{recursive:true,force:true});});
  return {root,scope,identityDir,calls,events,audit};
}
test('installation checks need no filename and wait for licensed login before code analysis',async t=>{
  let licensed=false;const f=fixture(t,{isLicensed:()=>licensed});
  fs.writeFileSync(path.join(f.scope,'inert.mjs'),'export const value = 1;');
  f.audit.start('installation');await f.audit.tick();
  assert.equal(f.audit.state().state,'waiting_for_login');assert.equal(f.calls.length,0);
  licensed=true;await f.audit.tick();assert.equal(f.calls.length,1);assert.equal(f.audit.state().checked,1);
  assert.equal(f.audit.state().wholeDeviceCoverageVerified,false);assert.equal(f.audit.state().commandAuthority,false);
});
test('code is inspected from a private stable snapshot and one operation at a time',async t=>{
  let active=0,maximum=0,copyPath;
  const f=fixture(t,{analyze:async file=>{
    active++;maximum=Math.max(maximum,active);copyPath=file;
    fs.writeFileSync(path.join(f.scope,'inert.mjs'),'export const changed = 2;');
    assert.equal(fs.readFileSync(file,'utf8'),'export const original = 1;');
    await Promise.resolve();active--;return {finding:false};
  }});
  fs.writeFileSync(path.join(f.scope,'inert.mjs'),'export const original = 1;');
  f.audit.start('login');await Promise.all([f.audit.tick(),f.audit.tick()]);
  assert.equal(maximum,1);assert.equal(fs.existsSync(copyPath),false);
});
test('secret names and file aliases are excluded rather than read',async t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.scope,'identity.json'),'private inert fixture');
  fs.writeFileSync(path.join(f.scope,'.env'),'SYNTHETIC=secret');
  const source=path.join(f.root,'source.mjs');fs.writeFileSync(source,'export const inert = true;');
  fs.symlinkSync(source,path.join(f.scope,'alias.mjs'));fs.linkSync(source,path.join(f.scope,'linked.mjs'));
  f.audit.start('login');for(let i=0;i<5;i++)await f.audit.tick();
  assert.equal(f.calls.length,0);assert.ok(f.audit.state().skipped>=4);
});
test('memory and disk headroom gate analysis without pretending a paused check is clean',async t=>{
  let available=false;const f=fixture(t,{resources:async()=>available});
  fs.writeFileSync(path.join(f.scope,'inert.mjs'),'export const inert = true;');
  f.audit.start('login');await f.audit.tick();assert.equal(f.audit.state().state,'paused_for_resources');assert.equal(f.calls.length,0);
  available=true;await f.audit.tick();assert.equal(f.calls.length,1);
});
test('only the app audit directory is repaired, with its previous mode recorded',async t=>{
  const f=fixture(t),auditDir=path.join(f.identityDir,'device-audit');fs.mkdirSync(auditDir,{mode:0o755});fs.chmodSync(auditDir,0o755);
  const userFile=path.join(f.scope,'inert.mjs');fs.writeFileSync(userFile,'export const inert = true;',{mode:0o777});fs.chmodSync(userFile,0o777);
  f.audit.start('installation');await f.audit.tick();
  assert.equal(fs.statSync(auditDir).mode&0o777,0o700);assert.equal(fs.statSync(userFile).mode&0o777,0o777);
  const receipt=JSON.parse(fs.readFileSync(path.join(auditDir,'permission-repairs.jsonl'),'utf8'));
  assert.equal(receipt.before,0o755);assert.equal(receipt.after,0o700);assert.equal(f.audit.state().repaired,1);
});
test('failed or oversized inspections are deferred and never quarantined automatically',async t=>{
  const f=fixture(t,{maxBytes:1024,analyze:async()=>{throw Error('fixture scanner unavailable');}});
  fs.writeFileSync(path.join(f.scope,'inert.mjs'),'export const inert = true;');
  f.audit.start('login');await f.audit.tick();assert.equal(f.audit.state().checked,0);assert.equal(f.audit.state().blocked,1);
  assert.equal(fs.existsSync(path.join(f.scope,'inert.mjs')),true);
});

test('stopping protection drains the active analysis before a rotation can begin',async t=>{
  let release,entered;const begun=new Promise(resolve=>{entered=resolve;});
  const f=fixture(t,{analyze:async()=>{entered();await new Promise(resolve=>{release=resolve;});return {finding:false};}});
  fs.writeFileSync(path.join(f.scope,'inert.mjs'),'export const inert = true;');f.audit.start('login');
  const work=f.audit.tick();await begun;
  let stopped=false;const draining=f.audit.stop().then(()=>{stopped=true;});
  await Promise.resolve();assert.equal(stopped,false);release();await work;await draining;
  assert.equal(stopped,true);assert.equal(f.audit.state().state,'stopped');
});

test('actionable findings expose opaque IDs and names without granting a path or deletion capability',async t=>{
 const f=fixture(t,{analyze:async()=>({finding:true})}),file=path.join(f.scope,'flagged.mjs');fs.writeFileSync(file,'export const inert = true;');
 f.audit.start('login');await f.audit.tick();const items=f.audit.state().findingItems;
 assert.equal(items.length,1);assert.deepEqual(Object.keys(items[0]).sort(),['id','name']);assert.equal(items[0].name,'flagged.mjs');
 assert.equal(f.audit.findingPath(items[0].id),file);assert.equal(f.audit.findingPath('unregistered'),null);assert.equal(fs.existsSync(file),true);
});
