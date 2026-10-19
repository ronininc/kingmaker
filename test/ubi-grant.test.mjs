/**
 * UBI identity connector — tests. Injected fakes; no I/O, no network.
 * Run: node test/ubi-grant.test.mjs
 */
import assert from 'node:assert';
import {
  grantUbi,
  canonicalize,
  UBI_GRANT_AMOUNT,
  UBI_GRANT_TYPE,
  CURRENCY_CODE,
} from '../lib/ubi-grant.mjs';

function harness() {
  const granted = new Set();
  const audit = [];
  const deps = {
    hasPriorGrant: (id) => granted.has(id),
    appendAudit: (event) => {
      audit.push(event);
      granted.add(event.identityId);
    },
    sign: (canonical) => `sig:${canonical.length}`,
    now: () => '2026-10-18T16:55:00.000Z',
  };
  return { deps, audit, granted };
}

const identity = {
  identityId: 'crm-client-001',
  installerHash: 'a6540db18d02076b4e5127a50f87c3a7a62db783a58037c1c3e39922e7008507',
  verified: true,
  verifiedAt: '2026-10-18T16:54:00.000Z',
};

// 1. Fresh verified identity → granted, signed, audited exactly once.
{
  const { deps, audit } = harness();
  const res = grantUbi(identity, deps);
  assert.equal(res.granted, true, 'fresh identity should be granted');
  assert.equal(audit.length, 1, 'exactly one audit event');
  const g = res.grant;
  assert.equal(g.type, UBI_GRANT_TYPE);
  assert.equal(g.currency, CURRENCY_CODE);
  assert.equal(g.amount, UBI_GRANT_AMOUNT);
  assert.equal(g.identityId, 'crm-client-001');
  assert.ok(g.signature.startsWith('sig:'), 'grant is signed');
  assert.equal(g.issuedAt, '2026-10-18T16:55:00.000Z');
  console.log('ok 1 - fresh identity granted, signed, audited');
}

// 2. Same identity twice → second refused, no double grant.
{
  const { deps, audit } = harness();
  const first = grantUbi(identity, deps);
  const second = grantUbi(identity, deps);
  assert.equal(first.granted, true);
  assert.equal(second.granted, false);
  assert.equal(second.reason, 'already-granted');
  assert.equal(audit.length, 1, 'no second audit event');
  console.log('ok 2 - double grant refused (idempotent)');
}

// 3. Unverified identity → refused, nothing appended.
{
  const { deps, audit } = harness();
  const res = grantUbi({ ...identity, verified: false }, deps);
  assert.equal(res.granted, false);
  assert.equal(res.reason, 'identity-not-verified');
  assert.equal(audit.length, 0);
  console.log('ok 3 - unverified identity refused');
}

// 4. Incomplete identity (blank id / hash) → refused.
{
  const { deps, audit } = harness();
  assert.equal(grantUbi({ ...identity, identityId: '  ' }, deps).reason, 'identity-incomplete');
  assert.equal(grantUbi({ ...identity, installerHash: '' }, deps).reason, 'identity-incomplete');
  assert.equal(grantUbi(null, deps).reason, 'no-identity');
  assert.equal(audit.length, 0);
  console.log('ok 4 - incomplete identity refused');
}

// 5. Canonical form is stable regardless of key order (what gets signed).
{
  const a = canonicalize({ b: 2, a: 1 });
  const b = canonicalize({ a: 1, b: 2 });
  assert.equal(a, b);
  assert.equal(a, '{"a":1,"b":2}');
  console.log('ok 5 - canonical signing form is key-order stable');
}

console.log('\n5/5 ubi-grant tests pass');
