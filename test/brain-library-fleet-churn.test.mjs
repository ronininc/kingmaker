// Fleet follow-on 3 — lib/brain-library-fleet-churn.mjs.
// One cycle over a real access store must: verify residents, verdict a
// tampered resident loudly WITHOUT touching its bytes, refresh a
// superseded resident through the pin-checked download path, evict stale
// and over-budget holdings with named reasons, and never evict a
// protected kind — with the footprint receipts to prove all of it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bufferSource, createBrainLibraryAccess } from '../lib/brain-library-access.mjs';
import { buildFleetDescriptor } from '../lib/brain-library-fleet-catalog.mjs';
import { createFleetChurn } from '../lib/brain-library-fleet-churn.mjs';

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const fill = (n, ch) => Buffer.alloc(n, ch);
const DAY = 24 * 60 * 60 * 1000;

test('a churn cycle: tamper verdict, refresh, stale + budget evictions, protected floor kept', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fleet-churn-'));
  const dirs = { storeDir: join(root, 'store'), cacheDir: join(root, 'cache'), stateDir: join(root, 'state') };
  const NOW = Date.now();

  const v1 = {
    'model-a': fill(400, 'a'), 'model-b': fill(500, 'b'), 'model-c': fill(600, 'c'),
    'model-d': fill(700, 'd'), 'method-m': fill(300, 'm'),
  };
  const aV2 = fill(460, 'A');
  const kinds = { 'model-a': 'model', 'model-b': 'model', 'model-c': 'model', 'model-d': 'model', 'method-m': 'method' };
  const sources = (bytes) => new Map(Object.entries(bytes).map(([id, data]) => [id, bufferSource({ id, kind: kinds[id], data })]));

  const accessV1 = createBrainLibraryAccess({ sources: sources(v1), ...dirs });
  const receipts = {};
  for (const id of Object.keys(v1)) receipts[id] = await accessV1.download(id);

  const churn = createFleetChurn({ stateDir: join(root, 'churn-state'), logDir: join(root, 'churn-log') });
  await churn.noteHolding({ id: 'model-a', lastUsedAt: NOW - 1000 });
  await churn.noteHolding({ id: 'model-b', lastUsedAt: NOW - 40 * DAY }); // stale
  await churn.noteHolding({ id: 'model-c', lastUsedAt: NOW - 1000 });
  await churn.noteHolding({ id: 'model-d', lastUsedAt: NOW - 10 * DAY }); // evictable, budget leg
  await churn.noteHolding({ id: 'method-m', lastUsedAt: NOW - 40 * DAY }); // stale but protected

  // Tamper model-c's resident on disk.
  const cPath = receipts['model-c'].path;
  const tampered = Buffer.from(await readFile(cPath)); tampered[5] ^= 0xff;
  await writeFile(cPath, tampered);

  // The world moves on: model-a is superseded by v2 bytes.
  const accessV2 = createBrainLibraryAccess({ sources: sources({ ...v1, 'model-a': aV2 }), ...dirs });
  const catalog = new Map();
  for (const [id, data] of Object.entries({ ...v1, 'model-a': aV2 })) {
    catalog.set(id, await buildFleetDescriptor(bufferSource({ id, kind: kinds[id], data }), { portionBytes: 128 }));
  }

  const record = await churn.runCycle({ access: accessV2, catalog, budgetBytes: 460 + 300, now: NOW });
  const diskAtCycleEnd = await accessV2.diskState(); // before any further reads touch the cache

  // VERIFY + TAMPER: loud verdict, exact hashes, bytes untouched, never served.
  const tamper = record.verdicts.find((v) => v.id === 'model-c');
  assert.equal(tamper?.verdict, 'TAMPERED');
  assert.equal(tamper.expected, sha256(v1['model-c']));
  assert.equal(tamper.actual, sha256(tampered));
  assert.deepEqual(await readFile(cPath), tampered, 'churn must not touch tampered bytes');
  assert.deepEqual(record.verifiedOk.sort(), ['method-m', 'model-a', 'model-b', 'model-d'].sort());
  const served = await accessV2.readPortion('model-c', { start: 0, length: 100 });
  assert.equal(served.from, 'stream', 'the tampered resident is never served as local');
  assert.deepEqual(served.data, v1['model-c'].subarray(0, 100));

  // REFRESH: model-a now verifies against the v2 pin.
  assert.deepEqual(record.refreshed, [{ id: 'model-a', from: sha256(v1['model-a']), to: sha256(aV2), bytes: 460 }]);
  const va = await accessV2.verifyResident('model-a');
  assert.equal(va.ok, true); assert.equal(va.sha256, sha256(aV2));

  // EVICT: stale and budget reasons named; protected and quarantined kept.
  const evicted = Object.fromEntries(record.evicted.map((e) => [e.id, e.reason]));
  assert.deepEqual(evicted, { 'model-b': 'stale', 'model-d': 'budget' });
  const items = new Map((await accessV2.listItems()).map((i) => [i.id, i]));
  assert.equal(items.get('model-b').resident, false);
  assert.equal(items.get('model-d').resident, false);
  assert.equal(items.get('method-m').resident, true, 'a protected kind is never evicted, however stale');
  assert.equal(items.get('model-c').resident, true, 'a quarantined resident is left exactly where it lies');

  // FOOTPRINT: the record's numbers are the disk's numbers (residents AND
  // their receipt files — whatever the store actually holds).
  assert.equal(record.heldBytesAfter, diskAtCycleEnd.storeBytes + diskAtCycleEnd.cacheBytes);
  assert.ok(record.heldBytesBefore > record.heldBytesAfter);
  const residentBytes = (await accessV2.listItems()).filter((i) => i.resident).reduce((n, i) => n + i.residentBytes, 0);
  assert.equal(residentBytes, 460 + 600 + 300, 'the surviving residents are exactly the refreshed, the quarantined and the protected');
  assert.equal(record.reachable, true);
  const logged = JSON.parse(await readFile(record.logPath, 'utf8'));
  assert.deepEqual(logged.verdicts, record.verdicts);
  assert.deepEqual(logged.evicted, record.evicted);

  // A budget below the untouchable floor is reported unreachable, not
  // forced: the planner evicts what it MAY (model-a, by budget) and then
  // says the floor itself busts the budget — protected and quarantined
  // holdings are still never touched.
  const record2 = await churn.runCycle({ access: accessV2, catalog, budgetBytes: 10, now: NOW });
  assert.equal(record2.reachable, false);
  assert.deepEqual(record2.evicted, [{ id: 'model-a', reason: 'budget', bytes: 460 }]);
  const items2 = new Map((await accessV2.listItems()).map((i) => [i.id, i]));
  assert.equal(items2.get('method-m').resident, true);
  assert.equal(items2.get('model-c').resident, true);
  assert.deepEqual(await readFile(cPath), tampered, 'even a hopeless budget never touches quarantined bytes');
});
