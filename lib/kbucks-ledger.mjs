/**
 * Kingmaker Bucks — currency ledger.
 *
 * The other half of lib/ubi-grant.mjs. The connector emits signed grant
 * receipts onto the audit chain; the ledger replays them into balances.
 * No receipt, no movement. Replay is deterministic: the same receipt log
 * always yields the same balances.
 *
 * Doctrine: the number is not a store of value — it is a ledger the
 * machine reads to decide what an identity may access. People who do
 * more get more; the ledger just keeps the score.
 *
 * Pure functions, immutable updates. No I/O, no network.
 */

import {
  UBI_GRANT_TYPE,
  CURRENCY_CODE,
  canonicalize,
} from './ubi-grant.mjs';

/** Empty ledger: balances per identity, plus applied receipt keys. */
export function createLedger() {
  return { balances: {}, applied: [] };
}

function receiptKey(grant) {
  return `${grant.identityId}:${grant.signature}`;
}

function validGrant(grant) {
  return (
    grant &&
    typeof grant === 'object' &&
    grant.type === UBI_GRANT_TYPE &&
    grant.currency === CURRENCY_CODE &&
    typeof grant.identityId === 'string' &&
    grant.identityId.trim() !== '' &&
    Number.isFinite(grant.amount) &&
    grant.amount > 0 &&
    typeof grant.signature === 'string' &&
    grant.signature !== ''
  );
}

/**
 * Apply a signed grant receipt to the ledger. Idempotent: replaying the
 * same receipt changes nothing. Returns { ledger, applied }.
 */
export function applyGrant(ledger, grant) {
  if (!validGrant(grant)) {
    return { ledger, applied: false, reason: 'invalid-grant' };
  }
  const key = receiptKey(grant);
  if (ledger.applied.includes(key)) {
    return { ledger, applied: false, reason: 'already-applied' };
  }
  const identityId = grant.identityId;
  const balances = {
    ...ledger.balances,
    [identityId]: (ledger.balances[identityId] || 0) + grant.amount,
  };
  return {
    ledger: { balances, applied: [...ledger.applied, key] },
    applied: true,
  };
}

/** Current balance for an identity; 0 when unknown. */
export function balanceOf(ledger, identityId) {
  return ledger.balances[identityId] || 0;
}

/**
 * Spend from an identity's balance (unlocking paid capability, etc.).
 * Returns { ledger, spent } — refused when funds are insufficient.
 */
export function spend(ledger, identityId, amount, memo) {
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ledger, spent: false, reason: 'invalid-amount' };
  }
  const balance = balanceOf(ledger, identityId);
  if (balance < amount) {
    return { ledger, spent: false, reason: 'insufficient-funds' };
  }
  const balances = { ...ledger.balances, [identityId]: balance - amount };
  return {
    ledger: { balances, applied: ledger.applied },
    spent: true,
    memo: memo || '',
  };
}

/**
 * Replay a full receipt log into a fresh ledger. The canonical rebuild:
 * audit chain in, balances out.
 */
export function replay(grants) {
  let ledger = createLedger();
  for (const grant of grants) {
    ledger = applyGrant(ledger, grant).ledger;
  }
  return ledger;
}

/** Canonical form of a ledger snapshot (for audit/pinning). */
export function snapshot(ledger) {
  return canonicalize({ balances: ledger.balances, applied: ledger.applied });
}
