import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {verifyFrameSignature,verifyPayload} from '../armor.mjs';

test('claimed signer fingerprints are checked before any signature operation', t => {
  const sign = crypto.generateKeyPairSync('ed25519').publicKey.export({format:'jwk'}).x;
  const fp = crypto.createHash('sha256').update(Buffer.from(sign,'base64url')).digest('hex');
  // No executable packet or private key. The verifier must reject these inert
  // headers before cryptographic verification is even attempted.
  const verify = t.mock.method(crypto,'verify',()=>{throw Error('must not reach signature verification');});
  assert.equal(verifyFrameSignature({v:4,sender_sign_pub:sign,sender_sign_fp:'invalid'},'inert fixture'),false);
  assert.equal(verifyFrameSignature({v:4,sender_sign_pub:sign,sender_sign_fp:fp,sender_mldsa_pub:Buffer.from('inert-public-key-fixture').toString('base64'),sender_mldsa_fp:'invalid'},'inert fixture'),false);
  assert.equal(verifyPayload({mesh:1,sig:'inert',from_sign_pub:sign,from_sign_fp:'invalid'}),false);
  assert.equal(verify.mock.callCount(),0);
});
