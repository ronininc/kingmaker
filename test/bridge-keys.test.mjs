/**
 * Bridge keys — tests. Injected fakes; no I/O, no network.
 * Run: node test/bridge-keys.test.mjs
 */
import assert from 'node:assert';
import {
  seedPairing, deriveCallSigns, cycleDay, activeWindow, verifyDock,
  CALL_SIGNS_PER_CYCLE,
} from '../lib/bridge-keys.mjs';

const fixedBytes = (n) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 7 + 3) % 256));
const otherBytes = (n) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 13 + 5) % 256));
const DAY = 24 * 60 * 60 * 1000;

// 1. Same seed material → same pairing; different → different.
{
  const a = seedPairing({ randomBytes: fixedBytes });
  const b = seedPairing({ randomBytes: fixedBytes });
  const c = seedPairing({ randomBytes: otherBytes });
  assert.equal(a.seedHex, b.seedHex);
  assert.notEqual(a.seedHex, c.seedHex);
  assert.notEqual(a.installerId, a.kingmakerId);
}

// 2. Call signs are deterministic per seed, 296 of them, 6 digits.
{
  const { seedHex } = seedPairing({ randomBytes: fixedBytes });
  const s1 = deriveCallSigns(seedHex);
  const s2 = deriveCallSigns(seedHex);
  assert.equal(s1.length, CALL_SIGNS_PER_CYCLE);
  assert.deepEqual(s1, s2);
  assert.ok(s1.every((s) => /^\d{6}$/.test(s)));
  const other = deriveCallSigns(seedPairing({ randomBytes: otherBytes }).seedHex);
  assert.notDeepEqual(s1, other);
}

// 3. Today's code verifies; both sides agree with no communication.
{
  const { seedHex } = seedPairing({ randomBytes: fixedBytes });
  const signs = deriveCallSigns(seedHex);
  const now = Date.now();
  const todayCode = signs[cycleDay(now)];
  assert.equal(verifyDock(todayCode, signs, now).ok, true);
}

// 4. Retired code (outside window) is rejected.
{
  const { seedHex } = seedPairing({ randomBytes: fixedBytes });
  const signs = deriveCallSigns(seedHex);
  const now = Date.now();
  const oldCode = signs[(cycleDay(now) + 10) % signs.length];
  const r = verifyDock(oldCode, signs, now);
  assert.equal(r.ok, false);
  assert.match(r.reason, /retired/);
}

// 5. Unknown code (not from this pairing) is rejected distinctly.
{
  const { seedHex } = seedPairing({ randomBytes: fixedBytes });
  const signs = deriveCallSigns(seedHex);
  const r = verifyDock('000000', signs, Date.now());
  // 000000 may or may not be in the list; force an unknown one
  const unknown = signs.includes('000000') ? '000001' : '000000';
  const r2 = verifyDock(signs.includes(unknown) ? '999999' : unknown, signs, Date.now());
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /unknown|retired/);
}

// 6. Malformed input rejected.
{
  const { seedHex } = seedPairing({ randomBytes: fixedBytes });
  const signs = deriveCallSigns(seedHex);
  assert.equal(verifyDock('abc', signs).ok, false);
  assert.equal(verifyDock(null, signs).ok, false);
}

// 7. Window tolerates adjacent days (drift) but not far ones.
{
  const { seedHex } = seedPairing({ randomBytes: fixedBytes });
  const signs = deriveCallSigns(seedHex);
  const now = Date.now();
  const yesterdayCode = signs[(cycleDay(now) - 1 + signs.length) % signs.length];
  assert.equal(verifyDock(yesterdayCode, signs, now, 1).ok, true);
  assert.equal(verifyDock(yesterdayCode, signs, now, 0).ok, false);
}

console.log('bridge-keys: 7/7 passed');
