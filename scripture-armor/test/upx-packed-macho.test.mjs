import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {upxMachOHeaderEvidence,scanFile} from '../scan.mjs';
test('a bare UPX string, unknown format and incomplete native header never prove packing',()=>{
 assert.equal(upxMachOHeaderEvidence(Buffer.from('UPX!')),null);
 assert.equal(upxMachOHeaderEvidence(Buffer.alloc(64)),null);
 const b=Buffer.alloc(64);b.writeUInt32LE(0xfeedfacf);b.write('UPX!',12);assert.equal(upxMachOHeaderEvidence(b),null);
});
test('real owner-approved UPX output is recognized; original and corrupted header are not', {skip:!process.env.ARMOR_UPX_FIXTURE_ROOT},()=>{
 const root=process.env.ARMOR_UPX_FIXTURE_ROOT,packed=fs.readFileSync(path.join(root,'packed.bin'));
 const evidence=upxMachOHeaderEvidence(packed);assert(evidence);assert.equal(evidence.format,37);assert.equal(evidence.version,13);assert(evidence.compressedBytes<evidence.unpackedBytes);
 assert.equal(upxMachOHeaderEvidence(fs.readFileSync(path.join(root,'bad.bin'))),null);
 const damaged=Buffer.from(packed);damaged[evidence.offset+31]^=255;assert.equal(upxMachOHeaderEvidence(damaged),null);
 assert.equal(upxMachOHeaderEvidence(packed.subarray(0,evidence.offset+31)),null);
});
test('actual Ghidra loader-stub scan cannot pass the genuinely UPX-packed fixture', {skip:!process.env.ARMOR_UPX_FIXTURE_ROOT||!process.env.ARMOR_TEST_PREREQUISITES,timeout:180000},async()=>{
 const p=JSON.parse(fs.readFileSync(process.env.ARMOR_TEST_PREREQUISITES,'utf8')),store=fs.mkdtempSync(path.join(os.tmpdir(),'packed-scan-'));
 try {const {record}=await scanFile(path.join(process.env.ARMOR_UPX_FIXTURE_ROOT,'packed.bin'),{policy:{scan:{ghidra_home:p.ghidraHome,jdk_home:p.jdkHome,timeout_s:150}},storeDir:store});
  assert.equal(record.analysis_confidence,'low');assert.equal(record.verdict,'warn');assert(record.findings.some(f=>f.rule==='static-analysis-limited'&&f.detail.includes('checksum-valid UPX')));
 }finally{fs.rmSync(store,{recursive:true,force:true});}
});
