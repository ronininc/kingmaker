import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const armor = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
test('native encrypted generations survive interrupted commits and refuse rollback', {skip:process.platform !== 'darwin', timeout:90000}, () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'armor-generation-proof-'));
  try {
    const executable = path.join(folder, 'proof');
    execFileSync('swiftc', ['-j','1','-D', 'ARMOR_AUTH_TESTS',
      ...['mac/LocalKeyAuthorization.swift','mac/ProtectedIdentityVault.swift','mac/ProtectedGenerationStore.swift','test/native-generation-store.swift'].map(file=>path.join(armor,file)),
      '-framework','LocalAuthentication','-framework','Security','-o',executable], {stdio:'pipe',timeout:60000});
    const result = execFileSync(executable, [], {encoding:'utf8',timeout:15000});
    assert.match(result, /PASS native protected generations/);
    assert.match(result, /no Keychain writes/);
  } finally {fs.rmSync(folder,{recursive:true,force:true});}
});

for (const [label, fixture, extra] of [
  ['one-shot native owner authorization', 'native-key-authorization.swift', []],
  ['native encrypted vault and action binding', 'native-protected-identity.swift', ['mac/ProtectedIdentityVault.swift']],
]) {
  test(label, {skip:process.platform !== 'darwin',timeout:90000},()=>{
    const folder=fs.mkdtempSync(path.join(os.tmpdir(),'armor-native-owner-proof-'));
    try {
      const executable=path.join(folder,'proof');
      execFileSync('swiftc',['-j','1','-D','ARMOR_AUTH_TESTS',path.join(armor,'mac/LocalKeyAuthorization.swift'),
        ...extra.map(file=>path.join(armor,file)),path.join(armor,'test',fixture),
        '-framework','LocalAuthentication','-framework','Security','-o',executable],{stdio:'pipe',timeout:60000});
      assert.match(execFileSync(executable,[],{encoding:'utf8',timeout:15000}),/PASS/);
    } finally {fs.rmSync(folder,{recursive:true,force:true});}
  });
}
