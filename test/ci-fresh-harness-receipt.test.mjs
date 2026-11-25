import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { freshHarnessReceipt, runtimeTree } from '../scripts/ci-fresh-harness-receipt.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const built = '2026-11-24T07:00:00Z';
const minimum = '2026-11-24T06:55:00Z';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(),'fresh-harness-receipt-'));
  t.after(() => rmSync(root,{recursive:true,force:true}));
  const app = join(root,'Kingmaker.app');
  const resource = (name,value) => {
    const dest = join(app,'Contents','Resources',name);
    mkdirSync(dirname(dest),{recursive:true});
    writeFileSync(dest,typeof value === 'object' ? JSON.stringify(value) : value);
    return dest;
  };
  mkdirSync(join(app,'Contents','MacOS'),{recursive:true});
  writeFileSync(join(app,'Contents','MacOS','KingmakerEngine'),'engine-native-bytes');
  const sourceCommit='a'.repeat(40), engineCommit='b'.repeat(40);
  const stamp = { sourceRef:'b'.repeat(7),builtAt:built,buildId:'1a2bc3d4' };
  const before='before-pinned-Guardrails';
  const preSignGuardrails={preSignSha256:sha(before),bytes:Buffer.byteLength(before),wheelSha256:'c'.repeat(64)};
  resource('kingmaker-runtime/solomon-build.json',stamp);
  resource('guardrails-runtime/runtime-manifest.json',{executableSha256:preSignGuardrails.preSignSha256,executableSizeBytes:preSignGuardrails.bytes});
  resource('guardrails-runtime/solomon-guardrails','after-native-ad-hoc-signature');
  resource('knowledge-runtime/northstar-tools-manifest.json',{platform:'darwin-arm64',installedAt:built});
  const facts = {solomonBuild:stamp.buildId,version:'4.5.1',bundledNode:'24.22.1',signing:'ad-hoc'};
  const kinds=['kingmaker-runtime','guardrails-runtime','knowledge-runtime'];
  const bundle = {app,sourceCommit,engineCommit,kinds,facts,preSignGuardrails,minimumBuiltAt:minimum};
  return {bundle,resource,stamp,root};
}

test('bind fresh current output to both commits and report separate pre-sign/post-sign Guardrails hashes',async t=>{
  const {bundle} = fixture(t);
  const result = await freshHarnessReceipt(bundle);
  assert.equal(result.sourceCommit,bundle.sourceCommit);
  assert.equal(result.engineCommit,bundle.engineCommit);
  assert.equal(result.runtimeClosures.length,3);
  assert.equal(result.app.engineSha256,sha('engine-native-bytes'));
  assert.equal(result.guardrails.preSignSha256,bundle.preSignGuardrails.preSignSha256);
  assert.equal(result.guardrails.packagedSha256,sha('after-native-ad-hoc-signature'));
  assert.notEqual(result.guardrails.preSignSha256,result.guardrails.packagedSha256);
});

test('changes to fresh payload bytes move its pin even when names and sizes match',async t=>{
  const {bundle,resource} = fixture(t);
  const first = await runtimeTree(bundle.app,'kingmaker-runtime');
  resource('kingmaker-runtime/extra','abc');
  const second = await runtimeTree(bundle.app,'kingmaker-runtime');
  resource('kingmaker-runtime/extra','def');
  const third = await runtimeTree(bundle.app,'kingmaker-runtime');
  assert.equal(second.bytes,third.bytes);
  assert.notEqual(first.treeSha256,second.treeSha256);
  assert.notEqual(second.treeSha256,third.treeSha256);
});

test('refuse historical engine byte provenance even with the expected bundle display version',async t=>{
  const {bundle,resource,stamp}=fixture(t);
  resource('kingmaker-runtime/solomon-build.json',{...stamp,sourceRef:'66f635b'});
  await assert.rejects(freshHarnessReceipt(bundle),/approved engine source/);
  resource('kingmaker-runtime/solomon-build.json',{...stamp,builtAt:'2026-10-15T08:00:00Z'});
  await assert.rejects(freshHarnessReceipt(bundle),/not from this build session/);
});

test('refuse copied manifest pins, stale Northstar, or missing runtime kinds',async t=>{
  const {bundle,resource}=fixture(t);
  await assert.rejects(freshHarnessReceipt({...bundle,preSignGuardrails:{...bundle.preSignGuardrails,preSignSha256:'e'.repeat(64)}}),/pre-sign proof/);
  await assert.rejects(freshHarnessReceipt({...bundle,kinds:[...bundle.kinds,'app.asar']}),/ENOENT/);
  resource('knowledge-runtime/northstar-tools-manifest.json',{platform:'darwin-arm64',installedAt:'2026-11-03T16:00:00Z'});
  await assert.rejects(freshHarnessReceipt(bundle),/Fresh arm64 Northstar metadata/);
});

test('refuse nonportable or out-of-bundle links and unapproved private assembly identity',async t=>{
  const {bundle,resource,root}=fixture(t);
  await assert.rejects(freshHarnessReceipt({...bundle,facts:{...bundle.facts,signing:'Developer ID Application'}}),/customer signing identity/);
  const outside=join(root,'outside');
  writeFileSync(outside,'fixture');
  const marker=resource('kingmaker-runtime/marker','x');
  symlinkSync(outside,join(dirname(marker),'escape'));
  await assert.rejects(runtimeTree(bundle.app,'kingmaker-runtime'),/nonportable symlink/);
});
