import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertProductIdentityDir, productPaths, canonicalPath } from '../product-paths.mjs';
import { externalFile, readExternalFile, sameExternalFile } from '../vault-paths.mjs';
import { migrateCredentials, previewMigration } from '../credential-vault.mjs';
import { createIdentity } from '../armor.mjs';
const ROOT=fileURLToPath(new URL('..',import.meta.url)), roots=[];
const temp=()=>{const p=fs.mkdtempSync(path.join(os.tmpdir(),'armor-boundary-'));roots.push(p);return p;};
test.after(()=>{for(const p of roots)fs.rmSync(p,{recursive:true,force:true});});
test('bundled policy separates store and service identity and rejects direct/aliased opposing stores',()=>{
 const home=temp(),other=path.join(home,'.scripture-armor');fs.mkdirSync(other);fs.writeFileSync(path.join(other,'identity.json'),'not key material');
 assert.equal(productPaths(home).identityDir,path.join(home,'.kingmaker','scripture-armor'));assert.match(productPaths(home).serviceLabel,/kingmaker/);
 assert.throws(()=>assertProductIdentityDir(other,home),/other product/);const alias=path.join(home,'alias');fs.symlinkSync(other,alias);assert.throws(()=>assertProductIdentityDir(alias,home),/other product/);
 for(const script of ['armor.mjs','vaultd.mjs','launch.mjs']){
  const args=script==='armor.mjs'?['identity']:script==='vaultd.mjs'?['status']:[];
  assert.throws(()=>execFileSync(process.execPath,[path.join(ROOT,script),...args,'--identity-dir',alias],{env:{...process.env,HOME:home},stdio:'pipe',timeout:10000}),/Command failed/);
 }
 assert.equal(fs.readFileSync(path.join(other,'identity.json'),'utf8'),'not key material');
});
test('independent frozen opener requires an explicit absolute identity before reading any store',()=>{
 const home=temp();assert.throws(()=>execFileSync(process.execPath,[path.join(ROOT,'open-standalone.mjs'),'nonexistent.scripture'],{env:{...process.env,HOME:home},stdio:'pipe'}),error=>error.status===2&&error.stderr.toString().includes('no identity was read'));
 assert.deepEqual(fs.readdirSync(home),[]);
});
test('two synthetic product installs mint different keys and refuse adopting each other without modifying either store',()=>{
 const root=temp(),home=path.join(root,'home'),standalone=path.join(root,'standalone');fs.mkdirSync(home);fs.mkdirSync(standalone);
 for(const file of ['armor.mjs','scan.mjs','product-paths.mjs','package.json'])fs.copyFileSync(path.join(ROOT,file),path.join(standalone,file));
 fs.writeFileSync(path.join(standalone,'product.json'),JSON.stringify({schema:'scripture-armor.product/1',product:'standalone'}));
 const env={...process.env,HOME:home},run=(script,args)=>execFileSync(process.execPath,[script,...args],{env,stdio:'pipe',timeout:10000});
 run(path.join(ROOT,'armor.mjs'),['identity','--label','synthetic-bundled']);run(path.join(standalone,'armor.mjs'),['identity','--label','synthetic-standalone']);
 const bundledFile=path.join(home,'.kingmaker','scripture-armor','identity.json'),standaloneFile=path.join(home,'.scripture-armor','identity.json');
 const before=[fs.readFileSync(bundledFile,'utf8'),fs.readFileSync(standaloneFile,'utf8')],identities=before.map(text=>JSON.parse(text));
 assert.notEqual(identities[0].seal_pub,identities[1].seal_pub);assert.notEqual(identities[0].sign_pub,identities[1].sign_pub);
 assert.throws(()=>run(path.join(ROOT,'armor.mjs'),['identity','--identity-dir',path.dirname(standaloneFile)]),/Command failed/);
 assert.throws(()=>run(path.join(standalone,'armor.mjs'),['identity','--identity-dir',path.dirname(bundledFile)]),/Command failed/);
 assert.equal(fs.readFileSync(bundledFile,'utf8'),before[0]);assert.equal(fs.readFileSync(standaloneFile,'utf8'),before[1]);
});
test('render-only Mac/Linux service templates select separate stores and labels for both products',()=>{
 if(process.platform==='win32')return;
 for(const product of ['kingmaker','standalone']){
  const repo=temp(),home=path.join(repo,'home');fs.mkdirSync(home);fs.copyFileSync(path.join(ROOT,'product-paths.mjs'),path.join(repo,'product-paths.mjs'));fs.writeFileSync(path.join(repo,'product.json'),JSON.stringify({schema:'scripture-armor.product/1',product}));fs.writeFileSync(path.join(repo,'vaultd.mjs'),'// render-only sentinel');
  for(const platform of ['mac','linux']){
   fs.cpSync(path.join(ROOT,platform),path.join(repo,platform),{recursive:true});
   const rendered=execFileSync('/bin/bash',[path.join(repo,platform,'install-daemon.sh'),'--render-only','--repo-dir',repo,'--owner-user',os.userInfo().username,'--owner-home',home,'--node-bin',process.execPath],{encoding:'utf8'});
   const expected=canonicalPath(path.join(home,...(product==='kingmaker'?['.kingmaker','scripture-armor']:['.scripture-armor'])));assert.ok(rendered.includes(expected),platform+' '+product+' '+expected);
   if(platform==='mac')assert.ok(rendered.includes(product==='kingmaker'?'org.ronininc.kingmaker.scripture-vaultd':'org.ronininc.scripture-vaultd'));
   assert.equal(fs.existsSync(path.join(expected,'identity.json')),false);
  }
 }
});
test('source guards reject vault aliases, direct symlinks and hardlinks without reading contents',()=>{
 const root=temp(),vault=path.join(root,'vault'),outside=path.join(root,'outside');fs.mkdirSync(vault);fs.mkdirSync(outside);const secret=path.join(vault,'identity.json');fs.writeFileSync(secret,'synthetic sentinel');
 assert.throws(()=>externalFile(secret,{identityDir:vault}),/protected/);
 const alias=path.join(root,'alias');fs.symlinkSync(vault,alias);assert.throws(()=>externalFile(path.join(alias,'identity.json'),{identityDir:vault}),/protected/);
 const link=path.join(outside,'link');fs.symlinkSync(secret,link);assert.throws(()=>externalFile(link,{identityDir:vault}),/symlink/);
 const hard=path.join(outside,'hard');fs.linkSync(secret,hard);assert.throws(()=>externalFile(hard,{identityDir:vault}),/single-link/);
 assert.equal(fs.readFileSync(secret,'utf8'),'synthetic sentinel');
});
test('source snapshot checks reject replacement between preview and read',()=>{
 const root=temp(),source=path.join(root,'source');fs.writeFileSync(source,'original fixture');const state=externalFile(source);fs.renameSync(source,source+'.old');fs.writeFileSync(source,'replacement');
 assert.throws(()=>readExternalFile(state),/changed/);assert.throws(()=>sameExternalFile(state),/changed/);assert.equal(fs.readFileSync(source+'.old','utf8'),'original fixture');
});
test('migration refuses active-vault sources and manifests before secret reads or writes',()=>{
 const root=temp(),vault=path.join(root,'vault');createIdentity(vault,'synthetic-only');const manifest=path.join(root,'manifest.json');fs.writeFileSync(manifest,JSON.stringify({schema:'scripture-armor.credential-migration/1',entries:[{id:'forbidden',source:path.join(vault,'identity.json')}]}));
 assert.throws(()=>previewMigration(manifest,{identityDir:vault}),/protected/);assert.throws(()=>migrateCredentials({identityDir:vault,manifestFile:manifest}),/protected/);assert.equal(fs.existsSync(path.join(vault,'credential-vault')),false);
 assert.throws(()=>previewMigration(path.join(vault,'identity.json'),{identityDir:vault}),/protected/);
});
test('npm files close every local top-level runtime import and include exporter/product policies',()=>{
 const pkg=JSON.parse(fs.readFileSync(path.join(ROOT,'package.json'),'utf8')),files=new Set(pkg.files.concat('package.json'));
 // build-standalone.mjs carries the account-session adapter's search/replace
 // literals ('from \'../lib/keychain-seal.mjs\'' -> 'from \'./lib/keychain-seal.mjs\''):
 // data the packager rewrites inside a staged file, not imports of the packager
 // itself (the adapter is staged by an explicit copyFileSync from the repo-level
 // lib/). The import scan must not read those literals as imports.
 const ADAPTER_LITERALS=["from '../lib/keychain-seal.mjs'","from './lib/keychain-seal.mjs'"];
 for(const file of pkg.files.filter(f=>f.endsWith('.mjs'))){let text=fs.readFileSync(path.join(ROOT,file),'utf8');for(const literal of ADAPTER_LITERALS)text=text.split(literal).join('');for(const match of text.matchAll(/from\s+['"]\.\/([^'"]+)['"]/g))assert.ok(files.has(match[1]),file+' omits '+match[1]);}
 for(const required of ['account-session.mjs','product.json','product-paths.mjs','vault-paths.mjs','ghidra-scripts'])assert.ok(files.has(required));
});
