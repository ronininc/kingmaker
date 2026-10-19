/**
 * K-Bucks ledger — tests. Injected fakes; no I/O, no network.
 * Run: node test/kbucks-ledger.test.mjs
 */
import assert from 'node:assert';
import {
  createLedger,
  applyGrant,
  balanceOf,
  spend,
  replay,
  snapshot,
} from '../lib/kbucks-ledger.mjs';
import { UBI_GRANT_AMOUNT, CURRENCY_CODE } from '../lib/ubi-grant.mjs';

function grant(id, sig) {
  return {
    type: 'ubi-grant',
    currency: CURRENCY_CODE,
    currencyName: 'Kingmaker Bucks',
    amount: UBI_GRANT_AMOUNT,
    identityId: id,
    installerHash: 'abc123',
    issuedAt: '2026-10-18T19:00:00.000Z',
    signature: sig,
  };
}

// 1. Fresh ledger: unknown identity balances zero.
{
  const ledger = createLedger();
  assert.equal(balanceOf(ledger, 'nobody'), 0);
}

// 2. Applying a valid grant credits the UBI amount.
{
  let ledger = createLedger();
  const res = applyGrant(ledger, grant('alice', 'sig1'));
  assert.equal(res.applied, true);
  assert.equal(balanceOf(res.ledger, 'alice'), UBI_GRANT_AMOUNT);
}

// 3. Replay is idempotent: same receipt twice changes nothing.
{
  let ledger = createLedger();
  const g = grant('alice', 'sig1');
  const r1 = applyGrant(ledger, g);
  const r2 = applyGrant(r1.ledger, g);
  assert.equal(r2.applied, false);
  assert.equal(r2.reason, 'already-applied');
  assert.equal(balanceOf(r2.ledger, 'alice'), UBI_GRANT_AMOUNT);
}

// 4. Invalid grants are refused: wrong type, bad currency, no signature.
{
  const ledger = createLedger();
  assert.equal(applyGrant(ledger, { ...grant('a', 's'), type: 'nope' }).applied, false);
  assert.equal(applyGrant(ledger, { ...grant('a', 's'), currency: 'USD' }).applied, false);
  assert.equal(applyGrant(ledger, { ...grant('a', 's'), signature: '' }).applied, false);
  assert.equal(balanceOf(ledger, 'a'), 0);
}

// 5. Spend debits; overspend is refused.
{
  let ledger = createLedger();
  ledger = applyGrant(ledger, grant('bob', 'sig2')).ledger;
  const ok = spend(ledger, 'bob', 400, 'k-office-unlock');
  assert.equal(ok.spent, true);
  assert.equal(balanceOf(ok.ledger, 'bob'), UBI_GRANT_AMOUNT - 400);
  const no = spend(ok.ledger, 'bob', 999999, 'greed');
  assert.equal(no.spent, false);
  assert.equal(no.reason, 'insufficient-funds');
  assert.equal(balanceOf(no.ledger, 'bob'), UBI_GRANT_AMOUNT - 400);
}

// 6. replay() rebuilds balances deterministically from a receipt log.
{
  const log = [grant('alice', 'sig1'), grant('bob', 'sig2'), grant('alice', 'sig1')];
  const ledger = replay(log);
  assert.equal(balanceOf(ledger, 'alice'), UBI_GRANT_AMOUNT);
  assert.equal(balanceOf(ledger, 'bob'), UBI_GRANT_AMOUNT);
  assert.equal(snapshot(ledger), snapshot(replay(log)), 'replay must be deterministic');
}

// 7. Ledger is immutable: applying returns a new object.
{
  const ledger = createLedger();
  const res = applyGrant(ledger, grant('carol', 'sig3'));
  assert.notEqual(res.ledger, ledger);
  assert.equal(balanceOf(ledger, 'carol'), 0);
}

console.log('kbucks-ledger: 7/7 passed');
