import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createExternalDispatchAdmissionStore } from '../lib/external-dispatch-store.mjs';

test('dispatch admission survives crash and exact retry recovers completed evidence',()=>{
  const dir=mkdtempSync(join(tmpdir(),'external-admission-')),path=join(dir,'private','admissions.sqlite'),x={keyId:'key-1',nonce:'nonce-123456789012345678901234',attemptId:'attempt-1',jobId:'job-1',receiptSha256:'a'.repeat(64)};
  let store=createExternalDispatchAdmissionStore({path});assert.deepEqual(store.admit(x),{duplicate:false,status:'admitted',evidence:null});store.close();
  store=createExternalDispatchAdmissionStore({path});assert.deepEqual(store.admit(x),{duplicate:true,status:'admitted',evidence:null});const evidence={kind:'external-static-review',reviewRequired:true};assert.deepEqual(store.complete({...x,evidence}),evidence);store.close();
  store=createExternalDispatchAdmissionStore({path});assert.deepEqual(store.admit(x),{duplicate:true,status:'completed',evidence});assert.deepEqual(store.complete({...x,evidence}),evidence);store.close();
});

test('same authority nonce rejects changed attempt, job or receipt',()=>{
  const dir=mkdtempSync(join(tmpdir(),'external-admission-')),store=createExternalDispatchAdmissionStore({path:join(dir,'private','admissions.sqlite')}),x={keyId:'key-1',nonce:'nonce-123456789012345678901234',attemptId:'attempt-1',jobId:'job-1',receiptSha256:'a'.repeat(64)};store.admit(x);
  for(const patch of [{attemptId:'attempt-2'},{jobId:'job-2'},{receiptSha256:'b'.repeat(64)}])assert.throws(()=>store.admit({...x,...patch}),/REPLAY_CONFLICT/);store.close();
});
