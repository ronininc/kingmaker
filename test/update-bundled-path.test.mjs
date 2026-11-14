import test from 'node:test';import assert from 'node:assert/strict';import {realpathSync,mkdtempSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {pathToFileURL} from 'node:url';
test('production module default resolves bundled app path without trailing slash',async()=>{
 const root=mkdtempSync(join(tmpdir(),'km-bundled-')),app=join(root,'Kingmaker.app'),lib=join(app,'Contents/Resources/sol-ghost/lib');mkdirSync(lib,{recursive:true});
 const original=new URL('../lib/update.mjs',import.meta.url);
 // Keep the actual production module and import.meta.url; resolve dependencies back to this test checkout only.
 const source=readFileSync(original,'utf8').replace(/from '(\.\/[^']+)'/g,(_,rel)=>`from '${new URL(rel,original).href}'`);
 writeFileSync(join(lib,'update.mjs'),source);const bundled=await import(pathToFileURL(join(lib,'update.mjs')).href);
 assert.equal(bundled.APP_ROOT,realpathSync(app));assert.ok(!bundled.APP_ROOT.endsWith('/'));
});
