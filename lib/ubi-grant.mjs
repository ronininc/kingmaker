/**
 * Kingmaker Bucks — UBI identity connector.
 *
 * One verified installer identity = one UBI grant. Idempotent, signed, audited.
 *
 * This is the connector between the existing installer-hash identity layer
 * (the launcher's private-hash verification: a client's installer hash matches
 * their CRM record) and the Kingmaker currency ledger. It does NOT mint — it
 * emits signed, idempotent UBI grant instructions onto the audit chain, which
 * the currency ledger replays. No ledger, no movement; the grant is a receipt.
 *
 * Doctrine: "Service, function, power. To the people."
 * Monetary policy: proof-of-impact issuance on top of a UBI floor. The number
 * is not a store of value — it is a ledger the machine reads to decide what an
 * identity may access. People who do more get more. Sybil defense is the
 * identity layer itself: one verified identity, one grant, enforced here.
 *
 * Pure logic + injected dependencies: no I/O, no network, no guessing at the
 * enrollment internals. The app wires the real verify/ledger functions in.
 */

/** Currency identity. Name and code are Robbie's; the amount is arbitrary by design. */
export const CURRENCY_NAME = 'Kingmaker Bucks';
export const CURRENCY_CODE = 'KMB';

/**
 * Pre-loaded grant per verified identity. Robbie's call — change this one line.
 * The number carries no fixed value; it is seed flow, not savings.
 */
export const UBI_GRANT_AMOUNT = 1000;

/** Grant instruction type recorded on the audit chain. */
export const UBI_GRANT_TYPE = 'ubi-grant';

/**
 * A verified installer identity, as produced by the existing hash verification
 * (installer hash matches the client's CRM record via the launcher).
 *
 * @typedef {Object} VerifiedIdentity
 * @property {string} identityId   - stable client identity (e.g. CRM client id)
 * @property {string} installerHash - the verified installer hash for this identity
 * @property {boolean} verified    - must be true; the hash check already passed upstream
 * @property {string} [verifiedAt] - ISO-8601 verification timestamp
 */

/**
 * Dependencies, injected by the app wiring — never imported here.
 *
 * @typedef {Object} UbiDeps
 * @property {(identityId: string) => boolean} hasPriorGrant - true when this identity already received UBI
 * @property {(event: Object) => void} appendAudit - appends the signed grant to the audit chain
 * @property {(canonical: string) => string} sign - signs the canonical grant payload
 * @property {() => string} [now] - ISO-8601 clock; defaults to current time
 */

/** Stable canonical JSON: sorted keys, no whitespace. What gets signed. */
export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
}

function refuse(reason) {
  return { granted: false, reason };
}

/**
 * Issue the UBI grant for a verified identity — or refuse with a reason.
 * Deterministic and idempotent: the same identity + grant log always yields
 * the same outcome, and a granted identity can never be granted twice.
 *
 * @param {VerifiedIdentity} identity
 * @param {UbiDeps} deps
 * @returns {{granted: boolean, reason?: string, grant?: Object}}
 */
export function grantUbi(identity, deps) {
  if (!identity || typeof identity !== 'object') return refuse('no-identity');
  if (identity.verified !== true) return refuse('identity-not-verified');
  const identityId = typeof identity.identityId === 'string' ? identity.identityId.trim() : '';
  const installerHash = typeof identity.installerHash === 'string' ? identity.installerHash.trim() : '';
  if (identityId === '' || installerHash === '') return refuse('identity-incomplete');

  if (deps.hasPriorGrant(identityId)) return refuse('already-granted');

  const grant = {
    type: UBI_GRANT_TYPE,
    currency: CURRENCY_CODE,
    currencyName: CURRENCY_NAME,
    amount: UBI_GRANT_AMOUNT,
    identityId,
    installerHash,
    issuedAt: typeof deps.now === 'function' ? deps.now() : new Date().toISOString(),
  };
  const signature = deps.sign(canonicalize(grant));
  const event = { ...grant, signature };
  deps.appendAudit(event);
  return { granted: true, grant: event };
}
