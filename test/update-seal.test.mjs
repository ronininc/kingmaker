import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,mkdirSync,writeFileSync,cpSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {spawnSync} from 'node:child_process';
import {verifyInstalledBundle} from '../lib/update.mjs';
const pin={sha1:'A'.repeat(40)};
for(const target of ['Contents/Info.plist','Contents/Resources/other.txt'])test('real codesign seal rejects modified '+target,{skip:process.platform!=='darwin'},()=>{
 const root=mkdtempSync(join(tmpdir(),'km-seal-')),app=join(root,'Kingmaker.app');mkdirSync(join(app,'Contents/MacOS'),{recursive:true});mkdirSync(join(app,'Contents/Resources'));
 cpSync('/usr/bin/true',join(app,'Contents/MacOS/Kingmaker'));
 writeFileSync(join(app,'Contents/Info.plist'),'<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.ronininc.solghost</string><key>CFBundleExecutable</key><string>Kingmaker</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');writeFileSync(join(app,'Contents/Resources/other.txt'),'original');
 const signed=spawnSync('/usr/bin/codesign',['--force','--sign','-',app],{encoding:'utf8'});assert.equal(signed.status,0,signed.stderr);
 // Test-only ad-hoc fixture: assert the production pinned requirement, then execute real integrity verification.
 const run=(cmd,args,options)=>{assert.equal(cmd,'/usr/bin/codesign');assert.deepEqual(args.slice(0,3),['--verify','--deep','--strict']);assert.equal(args[3],'-R=identifier "com.ronininc.solghost" and certificate leaf = H"'+pin.sha1+'"');return spawnSync(cmd,args.filter(a=>!a.startsWith('-R=')),options);};
 assert.equal(verifyInstalledBundle(app,pin,run),true);
 writeFileSync(join(app,target),readFileSync(join(app,target),'utf8').replace('original','changed').replace('</dict>','<key>LocalPatch</key><true/></dict>'));
 assert.equal(verifyInstalledBundle(app,pin,run),false);
});
test('missing pin and failed pinned verification fail closed',()=>{assert.equal(verifyInstalledBundle('/unused',null),false);assert.equal(verifyInstalledBundle('/unused',pin,()=>({status:1})),false);});
