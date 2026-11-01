import assert from 'node:assert/strict';
import test from 'node:test';
import { handleInstallProofRequest } from '../lib/phone-companion.mjs';

test('install proof route is loopback-only, POST-only, and fail closed', async () => {
  const ok = async (request) => ({ proof: request.challenge });
  assert.equal((await handleInstallProofRequest({ remoteAddress: '192.168.1.4', method: 'POST', body: '{}', installProof: ok })).status, 403);
  assert.equal((await handleInstallProofRequest({ remoteAddress: '127.0.0.1', method: 'GET', body: '{}', installProof: ok })).status, 405);
  assert.equal((await handleInstallProofRequest({ remoteAddress: '::1', method: 'POST', body: '{}', installProof: null })).status, 503);
  assert.equal((await handleInstallProofRequest({ remoteAddress: '127.0.0.1', method: 'POST', body: '{', installProof: ok })).status, 400);
  assert.equal((await handleInstallProofRequest({ remoteAddress: '127.0.0.1', method: 'POST', body: '{}', installProof: async () => { throw new Error('refused'); } })).status, 403);
  assert.deepEqual(await handleInstallProofRequest({ remoteAddress: '::ffff:127.0.0.1', method: 'POST', body: '{"challenge":"fixture"}', installProof: ok }), { status: 200, body: { proof: 'fixture' } });
});
