import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
test('native state overrides are complete, absolute, distinct and fail closed before opening a saved profile', {skip:process.platform!=='darwin'},()=>{
 const source=fs.readFileSync(new URL('../app/Kingmaker.swift',import.meta.url),'utf8');
 const body=source.split('// BEGIN NATIVE_RUNTIME_PROFILE\n')[1].split('// END NATIVE_RUNTIME_PROFILE')[0];
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-runtime-profile-proof-'));
 try {
  fs.writeFileSync(path.join(root,'main.swift'),'import Foundation\n'+body+`
let valid = ["SOL_GHOST_HOME":"/tmp/fixture/state","SOL_GHOST_RUNTIME_HOME":"/tmp/fixture/runtime","SOL_GHOST_PORT":"34321"]
let absent = try nativeRuntimeProfile([:])
precondition(absent == nil)
let parsed = try nativeRuntimeProfile(valid)!
precondition(parsed.state == "/tmp/fixture/state" && parsed.runtimeHome == "/tmp/fixture/runtime" && parsed.port == 34321)
var cases:[[String:String]] = []
for key in valid.keys { var broken=valid; broken.removeValue(forKey:key); cases.append(broken) }
for value in ["", "relative", "/", "/tmp/fixture/runtime", "/tmp/bad\\npath"] { var broken=valid; broken["SOL_GHOST_HOME"]=value; cases.append(broken) }
for value in ["", "0", "1023", "65536", "34321x", "034321"] { var broken=valid; broken["SOL_GHOST_PORT"]=value; cases.append(broken) }
for broken in cases {
 var refused=false
 do { _ = try nativeRuntimeProfile(broken) } catch { refused=true }
 precondition(refused, "Malformed override must never select the live profile")
}
print("PASS native profile: valid isolation; \\(cases.count) malformed overrides refused")
`);
  execFileSync('swiftc',[path.join(root,'main.swift'),'-o',path.join(root,'proof')],{timeout:60000,stdio:'pipe'});
  const output=execFileSync(path.join(root,'proof'),{encoding:'utf8',timeout:5000});assert.match(output,/PASS native profile/);
  const start=source.indexOf('func applicationDidFinishLaunching');
  const validation=source.indexOf('do { _ = try nativeRuntimeProfile',start),firstStateAccess=source.indexOf('_ = barLinkKey()',start);
  assert(start>=0&&validation>=0&&firstStateAccess>=0&&validation<firstStateAccess);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
