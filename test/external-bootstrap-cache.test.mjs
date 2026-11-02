import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createExternalBootstrapCache } from '../lib/external-bootstrap-cache.mjs';

test('encrypted bootstrap survives restart and exact retry without plaintext storage',()=>{
  const dir=mkdtempSync(join(tmpdir(),'bootstrap-cache-')),path=join(dir,'cache.sqlite'),key=randomBytes(32),value={schema:'fixture',attemptId:'a',leaseToken:'secret-lease'};
  let cache=createExternalBootstrapCache({path,key});assert.deepEqual(cache.put('a',value),value);cache.close();
  cache=createExternalBootstrapCache({path,key});assert.deepEqual(cache.get('a'),value);assert.deepEqual(cache.put('a',value),value);assert.throws(()=>cache.put('a',{...value,leaseToken:'changed'}),/CONFLICT/);cache.close();
  assert.throws(()=>createExternalBootstrapCache({path,key:randomBytes(32)}).get('a'),/CACHE_AUTH/);
});
