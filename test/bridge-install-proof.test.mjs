import assert from 'node:assert/strict';
import test from 'node:test';
import { handleInstallProofRequest } from '../lib/phone-companion.mjs';

test('install proof route is loopback-only, POST-only, and fail closed', async () => {
  const ok = async (request) => ({ proof: request.challenge });
  const auth = { authorization: 'Bearer scoped-fixture', expectedAuthorization: 'scoped-fixture' };
  const call = (extra = {}) => handleInstallProofRequest({ remoteAddress: '127.0.0.1', method: 'POST', body: '{}', installProof: ok, ...auth, ...extra });
  assert.equal((await call({ remoteAddress: '192.168.1.4' })).status, 403);
  assert.equal((await call({ method: 'GET' })).status, 405);
  assert.equal((await call({ installProof: null })).status, 503);
  assert.equal((await call({ expectedAuthorization: '' })).status, 503);
  assert.equal((await call({ authorization: '' })).status, 401);
  assert.equal((await call({ authorization: 'Bearer attacker' })).status, 401);
  assert.equal((await call({ body: '{' })).status, 400);
  assert.equal((await call({ installProof: async () => { throw new Error('refused'); } })).status, 403);
  assert.deepEqual(await call({ remoteAddress: '::ffff:127.0.0.1', body: '{"challenge":"fixture"}' }), { status: 200, body: { proof: 'fixture' } });
});
