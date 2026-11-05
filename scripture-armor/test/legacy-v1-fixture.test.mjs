import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {legacyFixtureHome} from './legacy-v1-fixture.mjs';
test('unconfigured fixture preserves explicit missing legacy path rather than inventing compatibility',()=>assert.equal(legacyFixtureHome('/missing-legacy',{}),'/missing-legacy'));
test('relative fixture and missing provenance refuse before historical source execution',()=>{
 assert.throws(()=>legacyFixtureHome('/unused',{ARMOR_LEGACY_V1_HOME:'relative'}),/absolute/);
 const d=fs.mkdtempSync(path.join(os.tmpdir(),'legacy-invalid-'));try{assert.throws(()=>legacyFixtureHome('/unused',{ARMOR_LEGACY_V1_HOME:d}));}finally{fs.rmSync(d,{recursive:true,force:true});}
});
test('genuine scanned historical fixture accepts; changed source or scan binding refuses', {skip:!process.env.ARMOR_LEGACY_V1_HOME},()=>{
 const original=process.env.ARMOR_LEGACY_V1_HOME;assert.equal(legacyFixtureHome('/unused'),original);
 const d=fs.mkdtempSync(path.join(os.tmpdir(),'legacy-pinned-'));try{
  for(const f of ['armor.mjs','provenance.json','source-scan.json']) fs.copyFileSync(path.join(original,f),path.join(d,f));
  const env={ARMOR_LEGACY_V1_HOME:d};assert.equal(legacyFixtureHome('/unused',env),d);
  fs.appendFileSync(path.join(d,'armor.mjs'),'\n// modified');assert.throws(()=>legacyFixtureHome('/unused',env),/mismatch/);
  fs.copyFileSync(path.join(original,'armor.mjs'),path.join(d,'armor.mjs'));
  fs.writeFileSync(path.join(d,'source-scan.json'),JSON.stringify({target_sha256:'0'.repeat(64),verdict:'pass'}));assert.throws(()=>legacyFixtureHome('/unused',env),/source scan/);
 }finally{fs.rmSync(d,{recursive:true,force:true});}
});
