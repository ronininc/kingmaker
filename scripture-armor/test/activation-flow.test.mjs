import assert from 'node:assert/strict';
import test from 'node:test';
import { activateArmor } from '../activation-flow.mjs';

function harness({ alreadyActive = false, verify = async () => ({ entitled: true }) } = {}) {
  const calls = [];
  return {
    calls,
    run: (input = { acceptTerms: true, confirmMigration: true }) => activateArmor({
      input, alreadyActive, verifyEntitlement: async (value) => { calls.push('verify'); return verify(value); },
      ensureIdentity: () => { calls.push('identity'); return { label: 'fixture' }; },
      acceptTerms: () => calls.push('terms'),
      migrateCredentials: () => { calls.push('migrate'); return { imported: ['one'] }; },
      recordFeed: () => calls.push('feed'),
      recordPaidActivation: () => calls.push('paid-marker'),
    }),
  };
}

for (const state of ['unpaid', 'claimed-not-verified', 'expired', 'unavailable']) {
  test(`${state} first activation fails before identity, terms, migration or feed`, async () => {
    const h = harness({ verify: async () => { throw new Error(state); } });
    await assert.rejects(h.run(), new RegExp(state));
    assert.deepEqual(h.calls, ['verify']);
  });
}

test('server-verified current entitlement precedes every first-activation mutation', async () => {
  const h = harness();
  const result = await h.run({ acceptTerms: true, confirmMigration: true, email: 'member@example.test', code: 'SA-1' });
  assert.deepEqual(h.calls, ['verify', 'identity', 'terms', 'migrate', 'feed', 'paid-marker']);
  assert.equal(result.migrated, 1);
});

test('an already-active owner vault remains locally accessible without re-verifying or moving data', async () => {
  const h = harness({ alreadyActive: true, verify: async () => { throw new Error('lapsed'); } });
  const result = await h.run();
  assert.deepEqual(h.calls, []);
  assert.equal(result.alreadyActive, true);
  assert.equal(result.migrated, 0);
});
