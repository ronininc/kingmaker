import assert from 'node:assert/strict';
import test from 'node:test';
import { armorEntitlementEndpoint, verifyArmorEntitlement as verifyStrictArmorEntitlement } from '../entitlement-client.mjs';

// Legacy receipt-shape compatibility is explicit; the production default now requires MFA.
const verifyArmorEntitlement = (input, options) => verifyStrictArmorEntitlement(input, { ...options, requireAccountSession: false });

const NOW = 1_800_000_000;
const receipt = (patch = {}) => ({ schema: 'ronin.armor-entitlement/v1', product: 'scripture-armor', entitled: true, verifiedAt: NOW, term: { startsAt: NOW - 10, endsAt: NOW + 3600 }, discordAccess: 'separate_verified_admission_required', ...patch });
const response = (body, init = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...init.headers }, ...init });

test('verification is fixed to Ronin, sends only one credential shape, and accepts the exact current contract', async () => {
  let seen;
  const result = await verifyArmorEntitlement({ email: ' Member@Example.com ', code: ' ab-12 ' }, { now: () => NOW, fetchImpl: async (url, init) => { seen = { url, init, body: JSON.parse(init.body) }; return response(receipt()); } });
  assert.equal(seen.url, armorEntitlementEndpoint);
  assert.equal(seen.init.redirect, 'manual');
  assert.equal(seen.init.headers.origin, 'https://www.ronininc.org');
  assert.deepEqual(seen.body, { email: 'member@example.com', code: 'AB-12' });
  assert.equal(result.term.endsAt, NOW + 3600);
  assert.equal(result.discordAccess, 'separate_verified_admission_required');
});

test('seat key takes precedence and no credential is returned in the receipt', async () => {
  let body;
  const result = await verifyArmorEntitlement({ email: 'ignored@example.com', code: 'IGNORE', seat_key: ' RSA-ABCDE ' }, { now: () => NOW, fetchImpl: async (_url, init) => { body = JSON.parse(init.body); return response(receipt()); } });
  assert.deepEqual(body, { seat_key: 'RSA-ABCDE' });
  assert.equal(JSON.stringify(result).includes('RSA-ABCDE'), false);
});

test('payment return, stale/forged terms, redirects, denial, errors and oversized bodies fail closed', async () => {
  const cases = [
    async () => response(receipt({ entitled: false })),
    async () => response(receipt({ verifiedAt: NOW - 301 })),
    async () => response(receipt({ term: { startsAt: NOW + 1, endsAt: NOW + 3600 } })),
    async () => response(receipt({ term: { startsAt: NOW - 10, endsAt: NOW } })),
    async () => response(receipt({ discordAccess: 'included' })),
    async () => new Response('', { status: 302, headers: { location: 'https://dot.cards/hoid_dismas' } }),
    async () => new Response('{}', { status: 403, headers: { 'content-type': 'application/json' } }),
    async () => response('x'.repeat(33 * 1024)),
    async () => { throw new Error('offline'); },
  ];
  for (const fetchImpl of cases) await assert.rejects(() => verifyArmorEntitlement({ seat_key: 'RSA-ABCDE' }, { now: () => NOW, fetchImpl }));
});

test('the abort deadline covers a body that stalls after response headers', async () => {
  const started = Date.now();
  const fetchImpl = async (_url, init) => new Response(new ReadableStream({
    start(controller) {
      init.signal.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true });
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  await assert.rejects(() => verifyArmorEntitlement({ seat_key: 'RSA-ABCDE' }, { now: () => NOW, fetchImpl, timeoutMs: 25 }), /unavailable/);
  assert.ok(Date.now() - started < 1000);
});
