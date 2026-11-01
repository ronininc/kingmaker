import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizeAdminAccess, authorizeAdminMutation, handleAdminMutationRequest, handleInstallProofRequest } from '../lib/phone-companion.mjs';

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

test('all admin reads require the separately scoped Launcher capability', () => {
  const base = { remoteAddress: '127.0.0.1', authorization: 'Bearer admin-fixture', expectedAuthorization: 'admin-fixture' };
  for (const route of ['status', 'metrics', 'metrics/history', 'datasets', 'devices', 'locations']) {
    assert.equal(authorizeAdminAccess({ ...base, authorization: '', route }).status, 401);
    assert.equal(authorizeAdminAccess({ ...base, authorization: 'Bearer wrong', route }).status, 401);
    assert.equal(authorizeAdminAccess({ ...base, expectedAuthorization: '', route }).status, 503);
    assert.equal(authorizeAdminAccess({ ...base, remoteAddress: '192.168.1.4', route }).status, 403);
    assert.equal(authorizeAdminAccess({ ...base, route }), null);
  }
});

test('pairing and unpairing admin mutations require a native scoped caller', () => {
  const base = { remoteAddress: '127.0.0.1', method: 'POST', authorization: 'Bearer admin-fixture',
    expectedAuthorization: 'admin-fixture', contentType: 'application/json', origin: '', fetchSite: '' };
  assert.equal(authorizeAdminMutation({ ...base, remoteAddress: '192.168.1.4' }).status, 403);
  assert.equal(authorizeAdminMutation({ ...base, method: 'GET' }).status, 405);
  assert.equal(authorizeAdminMutation({ ...base, expectedAuthorization: '' }).status, 503);
  assert.equal(authorizeAdminMutation({ ...base, authorization: '' }).status, 401);
  assert.equal(authorizeAdminMutation({ ...base, authorization: 'Bearer wrong' }).status, 401);
  assert.equal(authorizeAdminMutation({ ...base, contentType: 'text/plain' }).status, 415);
  assert.equal(authorizeAdminMutation({ ...base, origin: 'https://attacker.example' }).status, 403);
  assert.equal(authorizeAdminMutation({ ...base, fetchSite: 'cross-site' }).status, 403);
  assert.equal(authorizeAdminMutation(base), null);
});

test('unauthorized unpair-all never reaches the device mutation', () => {
  let mutations = 0;
  const base = { remoteAddress: '127.0.0.1', method: 'POST', authorization: 'Bearer admin-fixture',
    expectedAuthorization: 'admin-fixture', contentType: 'application/json', origin: '', fetchSite: '' };
  const mutateAll = () => { mutations += 1; return { unpaired: 2 }; };
  assert.equal(handleAdminMutationRequest({ ...base, authorization: '' }, mutateAll).status, 401);
  assert.equal(handleAdminMutationRequest({ ...base, origin: 'https://attacker.example' }, mutateAll).status, 403);
  assert.equal(mutations, 0);
  assert.deepEqual(handleAdminMutationRequest(base, mutateAll), { status: 200, body: { unpaired: 2 } });
  assert.equal(mutations, 1);
});
