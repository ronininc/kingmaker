import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { createExternalSecurityAttemptLoader, readExternalSecurityAttemptRuntimeSecret } from '../lib/external-security-attempt-loader.mjs';

const pairingId='11111111-1111-4111-8111-111111111111';
const mapping={deskSlug:'desk-fixture',pairingId,executorRegistrationId:'executor-fixture',executorFingerprint:'e'.repeat(64)};

test('attempt runtime is disabled on platforms without an approved secret-store adapter',()=>{
  let called=false;
  assert.deepEqual(readExternalSecurityAttemptRuntimeSecret({platform:'win32',exec:()=>{called=true}}),{status:-1,stdout:''});
  assert.equal(called,false);
});

test('attempt loader rejects missing, plaintext-like, or identity-mismatched governed runtime data',()=>{
  assert.throws(()=>createExternalSecurityAttemptLoader({mapping,readRuntime:()=>({status:-1,stdout:''}),fetchImpl:async()=>{throw new Error('network must not run')}}),/RUNTIME_UNAVAILABLE/);
  assert.throws(()=>createExternalSecurityAttemptLoader({mapping,readRuntime:()=>({status:0,stdout:'not-json'}),fetchImpl:async()=>{throw new Error('network must not run')}}),/RUNTIME_INVALID/);
  const {privateKey}=generateKeyPairSync('ed25519'),jwk=privateKey.export({format:'jwk'}),runtime={schema:'ronin.external-security-local-runtime/v1',executorBearer:'fixture-bearer-not-real',executorRegistrationId:'wrong',executorFingerprint:'e'.repeat(64),evidenceSigningFingerprint:'f'.repeat(64),evidencePrivateJwk:jwk,authorities:{},sourceRoots:[{id:'a',repositoryUrl:'https://example.invalid/repo',path:'/private/repo'}],journalRoot:'/private/journal'};
  assert.throws(()=>createExternalSecurityAttemptLoader({mapping,readRuntime:()=>({status:0,stdout:JSON.stringify(runtime)}),fetchImpl:async()=>{throw new Error('network must not run')}}),/RUNTIME_INVALID|LOADER_IDENTITY/);
});
