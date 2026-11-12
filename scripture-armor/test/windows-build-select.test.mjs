// windows/select-build.mjs + windows/builds.json — the per-Windows-version
// build template's device match. The manifest shipped in this tree carries
// exactly one variant (the current one); the multi-variant mechanics are
// proven against synthetic manifests so adding the next Windows version is
// a data edit, not a code change.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { selectBuild } from '../windows/select-build.mjs';

const shipped = JSON.parse(fs.readFileSync(new URL('../windows/builds.json', import.meta.url), 'utf8'));

test('the shipped manifest is well-formed and has the current variant filled', () => {
  assert.equal(shipped.schema, 'scripture-armor.windows-builds/1');
  assert.ok(Array.isArray(shipped.variants) && shipped.variants.length >= 1);
  const current = shipped.variants.filter((v) => v.status === 'current');
  assert.equal(current.length, 1);
  const v = current[0];
  assert.ok(v.id && v.label && v.packageVersion);
  assert.ok(Array.isArray(v.targets) && v.targets.length >= 1);
  for (const t of v.targets) {
    assert.ok(Number.isInteger(t.minBuild));
    assert.ok(t.maxBuild === null || Number.isInteger(t.maxBuild));
  }
  assert.ok(v.surface && v.surface.transport && v.surface.daemonHost && v.surface.installer);
  assert.ok(Array.isArray(v.surface.commandStructure) && v.surface.commandStructure.length >= 1);
});

test('device match against the shipped manifest', () => {
  assert.equal(selectBuild(shipped, 19045).variant.id, 'win10-11');
  assert.equal(selectBuild(shipped, 19045).matched, 'in-range');
  assert.equal(selectBuild(shipped, 22000).variant.id, 'win10-11');
  assert.equal(selectBuild(shipped, 26100).variant.id, 'win10-11');
  // Above every declared ceiling today: the Windows 11 range is open-ended,
  // so a future build still matches in-range until a variant narrows it.
  assert.equal(selectBuild(shipped, 28000).matched, 'in-range');
  // Below the declared floor: no build claims the device.
  assert.equal(selectBuild(shipped, 17763), null);
  assert.equal(selectBuild(shipped, 0), null);
  assert.equal(selectBuild(shipped, 'not-a-number'), null);
});

test('the mechanism: a second variant slots in without touching the selector', () => {
  const two = {
    schema: 'scripture-armor.windows-builds/1',
    variants: [
      { id: 'old', status: 'supported', targets: [{ product: 'Windows X', minBuild: 10000, maxBuild: 19999 }] },
      { id: 'new', status: 'current', targets: [{ product: 'Windows Y', minBuild: 20000, maxBuild: null }] },
      { id: 'dead', status: 'retired', targets: [{ product: 'Windows Z', minBuild: 20000, maxBuild: null }] },
    ],
  };
  assert.equal(selectBuild(two, 15000).variant.id, 'old');
  assert.equal(selectBuild(two, 25000).variant.id, 'new'); // retired never wins
  // A build above a closed range but below the next variant: nearest below.
  const gapped = {
    variants: [
      { id: 'a', status: 'supported', targets: [{ product: 'W', minBuild: 10000, maxBuild: 12000 }] },
      { id: 'b', status: 'current', targets: [{ product: 'W', minBuild: 20000, maxBuild: null }] },
    ],
  };
  const pick = selectBuild(gapped, 15000);
  assert.equal(pick.variant.id, 'a');
  assert.equal(pick.matched, 'nearest-below');
});
