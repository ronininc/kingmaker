/**
 * Stage 6 distribution — tests. Pure and deterministic: tampered bytes fail
 * verification; download plans are proposals gated by sovereignty (consent)
 * and the launcher's private pins.
 * PORTED from kingmaker-os (test/model-distribution.test.ts) for the app.
 * Run: node test/model-distribution.test.mjs
 */
import assert from 'node:assert/strict';
import {
  buildDistributionPackage,
  planNodeDownload,
  verifyForInstall,
  verifyPackage,
} from '../lib/fleet-distribution.mjs';

const FIXED_NOW = new Date('2026-10-18T15:30:00.000Z');

function model(overrides = {}) {
  return {
    id: 'hf:dealignai/DeepSeek-V4.1-Flash-1017-uncensored',
    tier: '32gb',
    weightHash: 'ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
    version: '1',
    ...overrides,
  };
}

function snapshot(models = [model()]) {
  return {
    version: '42',
    publishedAt: '2026-10-18T00:00:00.000Z',
    models,
  };
}

// 1. Package hash verifies against the signed snapshot.
{
  const pkg = buildDistributionPackage(snapshot(), 'launcher-key-1', FIXED_NOW);
  assert.equal(verifyPackage(pkg), true);
  assert.equal(pkg.signedBy, 'launcher-key-1');
  assert.equal(pkg.signedAt, FIXED_NOW.toISOString());
  assert.match(pkg.packageHash, /^[0-9a-f]{64}$/);
  console.log('ok 1 - package hash verifies against the signed snapshot');
}

// 2. Deterministic: identical inputs yield identical packages.
{
  const a = buildDistributionPackage(snapshot(), 'launcher-key-1', FIXED_NOW);
  const b = buildDistributionPackage(snapshot(), 'launcher-key-1', FIXED_NOW);
  assert.deepEqual(a, b);
  console.log('ok 2 - identical inputs yield identical packages');
}

// 3. Tampering with the snapshot fails verification.
{
  const pkg = buildDistributionPackage(snapshot(), 'launcher-key-1', FIXED_NOW);
  const tampered = {
    ...pkg.snapshot,
    models: [
      model({
        id: 'hf:evil/spoofed',
        weightHash: '0000000000000000000000000000000000000000000000000000000000000000',
      }),
    ],
  };
  assert.equal(verifyPackage({ ...pkg, snapshot: tampered }), false);
  console.log('ok 3 - tampered snapshot fails verification');
}

// 4. Tampering with a single hash byte fails verification.
{
  const pkg = buildDistributionPackage(snapshot(), 'launcher-key-1', FIXED_NOW);
  const tampered = {
    ...pkg.snapshot,
    models: [model({ weightHash: model().weightHash.slice(0, -1) + '0' })],
  };
  assert.equal(verifyPackage({ ...pkg, snapshot: tampered }), false);
  console.log('ok 4 - single-byte hash tampering fails verification');
}

const DIST_PKG = buildDistributionPackage(
  snapshot([
    model({ id: 'm:light', tier: '8gb' }),
    model({ id: 'm:installed', tier: '8gb' }),
    model({ id: 'm:no-tier', tier: null }),
    model({ id: 'm:heavy', tier: '64gb' }),
    model({ id: 'm:fits', tier: '16gb' }),
  ]),
  'launcher-key-1',
  FIXED_NOW,
);

// 5. Proposes models that fit and are not installed.
{
  const plan = planNodeDownload(DIST_PKG, {
    tier: '24gb',
    installedIds: new Set(['m:installed']),
  });
  assert.deepEqual(
    plan.toDownload.map((m) => m.id),
    ['m:light', 'm:fits'],
  );
  console.log('ok 5 - proposes models that fit and are not installed');
}

// 6. Skips already-installed models.
{
  const plan = planNodeDownload(DIST_PKG, {
    tier: '24gb',
    installedIds: new Set(['m:installed']),
  });
  const skip = plan.skipped.find((s) => s.id === 'm:installed');
  assert.equal(skip.reason, 'already installed');
  console.log('ok 6 - skips already-installed models');
}

// 7. Skips models with a null tier.
{
  const plan = planNodeDownload(DIST_PKG, {
    tier: '64gb',
    installedIds: new Set(),
  });
  const skip = plan.skipped.find((s) => s.id === 'm:no-tier');
  assert.equal(skip.reason, 'no tier fit');
  console.log('ok 7 - skips models with a null tier');
}

// 8. Skips models heavier than the node tier.
{
  const plan = planNodeDownload(DIST_PKG, {
    tier: '24gb',
    installedIds: new Set(),
  });
  const skip = plan.skipped.find((s) => s.id === 'm:heavy');
  assert.ok(skip !== undefined);
  assert.match(skip.reason, /heavier than node tier/);
  assert.match(skip.reason, /64gb/);
  assert.match(skip.reason, /24gb/);
  console.log('ok 8 - skips models heavier than the node tier');
}

// 9. A 64gb node is proposed every installable model.
{
  const plan = planNodeDownload(DIST_PKG, {
    tier: '64gb',
    installedIds: new Set(),
  });
  assert.deepEqual(
    plan.toDownload.map((m) => m.id),
    ['m:light', 'm:installed', 'm:heavy', 'm:fits'],
  );
  assert.deepEqual(plan.skipped.map((s) => s.id), ['m:no-tier']);
  console.log('ok 9 - 64gb node is proposed every installable model');
}

// 10. An 8gb node gets only 8gb-or-lighter models.
{
  const plan = planNodeDownload(DIST_PKG, {
    tier: '8gb',
    installedIds: new Set(),
  });
  assert.deepEqual(plan.toDownload.map((m) => m.id), ['m:light', 'm:installed']);
  console.log('ok 10 - 8gb node gets only 8gb-or-lighter models');
}

// 11. Empty library yields an empty plan.
{
  const empty = buildDistributionPackage(snapshot([]), 'launcher-key-1', FIXED_NOW);
  const plan = planNodeDownload(empty, { tier: '64gb', installedIds: new Set() });
  assert.deepEqual(plan.toDownload, []);
  assert.deepEqual(plan.skipped, []);
  console.log('ok 11 - empty library yields an empty plan');
}

const PIN_HASH = 'abcdef0123456789ABCDEF0123456789abcdef0123456789ABCDEF0123456789';
const DIST_MODEL = model({ weightHash: PIN_HASH.toLowerCase() });
const DIST_PINS = new Map([[DIST_MODEL.id, PIN_HASH]]);

// 12. Withholds consent when the user did not consent — even with a valid pin.
{
  const v = verifyForInstall(DIST_MODEL, DIST_PINS, false);
  assert.equal(v.result, 'consent-withheld');
  assert.equal(v.modelId, DIST_MODEL.id);
  assert.match(v.detail, /did not consent/);
  console.log('ok 12 - consent withheld without user consent, pin or not');
}

// 13. Refuses a hash mismatch.
{
  const wrongPins = new Map([
    [DIST_MODEL.id, '1111111111111111111111111111111111111111111111111111111111111111'],
  ]);
  const v = verifyForInstall(DIST_MODEL, wrongPins, true);
  assert.equal(v.result, 'hash-mismatch');
  assert.match(v.detail, /hash mismatch/);
  console.log('ok 13 - hash mismatch refused');
}

// 14. Refuses when the launcher never pinned the model.
{
  const v = verifyForInstall(DIST_MODEL, new Map(), true);
  assert.equal(v.result, 'not-pinned');
  assert.match(v.detail, /no launcher pin/);
  console.log('ok 14 - unpinned model refused');
}

// 15. Verifies on a hash match, case-insensitively.
{
  const v = verifyForInstall(DIST_MODEL, DIST_PINS, true);
  assert.equal(v.result, 'verified');
  assert.match(v.detail, /consent was given/);
  console.log('ok 15 - hash match verifies');
}

// 16. Verifies when the pin has different casing/whitespace.
{
  const sloppy = new Map([[DIST_MODEL.id, `  ${PIN_HASH.toUpperCase()}  `]]);
  const v = verifyForInstall(DIST_MODEL, sloppy, true);
  assert.equal(v.result, 'verified');
  console.log('ok 16 - pin comparison is case/whitespace-insensitive');
}

// 17. Consent is checked before the pin lookup.
{
  // No pins at all, no consent: consent-withheld still wins.
  const v = verifyForInstall(DIST_MODEL, new Map(), false);
  assert.equal(v.result, 'consent-withheld');
  console.log('ok 17 - consent is checked before the pin lookup');
}

console.log('\n17/17 model-distribution tests pass');
