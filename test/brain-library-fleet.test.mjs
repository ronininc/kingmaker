// Fleet Replication v1 — lib/brain-library-fleet.mjs.
// The fleet source must accept a portion from any source by one test only —
// its pin — and must refuse, fail over, and fall back to the door on receipts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { bufferSource } from '../lib/brain-library-access.mjs';
import { buildPortionManifest, chooseEvictions, createFleetNode, createFleetSource, portionCount } from '../lib/brain-library-fleet.mjs';

const DATA = Buffer.from('fleet replication moves verified portions — any docked machine may serve.\n'.repeat(6));
const OPTS = { portionBytes: 64 };

async function manifestFor(data = DATA, id = 'method:fleet-fixture') {
  return buildPortionManifest(bufferSource({ id, kind: 'method', name: 'Fleet fixture', data }), OPTS);
}

test('the portion manifest pins every portion and the whole item', async () => {
  const d = await manifestFor();
  assert.equal(d.portionSha256.length, portionCount(DATA.length, OPTS.portionBytes));
  assert.equal(d.sha256, bufferSource({ id: d.id, kind: 'method', data: DATA }).sha256);
});

test('a fleet source without a portion manifest refuses before any fetch', async () => {
  const bare = { id: 'x', kind: 'method', size: 4, sha256: 'a'.repeat(64), portionBytes: 64 };
  assert.throws(() => createFleetSource({ descriptor: bare }), /FLEET_PIN_MANIFEST_MISSING|portion pin manifest/);
});

test('portions come from an advertising peer, pin-accepted, receipts naming the peer', async () => {
  const descriptor = await manifestFor();
  const node = createFleetNode({ nodeId: 'TEST-NODE-A', sources: new Map([[descriptor.id, bufferSource({ id: descriptor.id, kind: 'method', data: DATA })]]), ...OPTS });
  const { url } = await node.listen();
  try {
    const source = createFleetSource({ descriptor, peers: [url] });
    const got = await source.readRange(10, 100);
    assert.deepEqual(got, DATA.subarray(10, 110));
    const accepted = source.stats().receipts.filter((r) => r.outcome === 'accepted');
    assert.ok(accepted.length >= 2 && accepted.every((r) => r.source === 'TEST-NODE-A'));
  } finally { await node.close(); }
});

test('a wrong-pin portion is refused and its bytes never returned', async () => {
  const descriptor = await manifestFor();
  const corrupted = Buffer.from(DATA); corrupted[0] ^= 0xff;
  const node = createFleetNode({
    nodeId: 'TEST-NODE-BAD',
    sources: new Map([[descriptor.id, bufferSource({ id: descriptor.id, kind: 'method', data: corrupted })]]),
    manifests: new Map([[descriptor.id, descriptor]]), // the catalog pin stands; the peer's bytes do not match it
  });
  const { url } = await node.listen();
  try {
    const source = createFleetSource({ descriptor, peers: [url] });
    await assert.rejects(() => source.readRange(0, 32), (e) => e.code === 'FLEET_PORTION_PIN_MISMATCH');
    assert.ok(source.stats().receipts.some((r) => r.outcome === 'refused-pin' && r.source === 'TEST-NODE-BAD'));
  } finally { await node.close(); }
});

test('a peer dying mid-file fails over to the next peer inside one read', async () => {
  const descriptor = await manifestFor();
  let served = 0;
  const a = createFleetNode({
    nodeId: 'TEST-NODE-A', ...OPTS,
    sources: new Map([[descriptor.id, bufferSource({ id: descriptor.id, kind: 'method', data: DATA })]]),
    onServed: async () => { served++; if (served === 2) setImmediate(() => a.close()); },
  });
  const c = createFleetNode({ nodeId: 'TEST-NODE-C', sources: new Map([[descriptor.id, bufferSource({ id: descriptor.id, kind: 'method', data: DATA })]]), ...OPTS });
  const la = await a.listen(); const lc = await c.listen();
  try {
    const source = createFleetSource({ descriptor, peers: [la.url, lc.url] });
    const got = await source.readRange(0, DATA.length);
    assert.deepEqual(got, DATA);
    const accepted = source.stats().receipts.filter((r) => r.outcome === 'accepted');
    assert.ok(accepted.some((r) => r.source === 'TEST-NODE-A'));
    assert.ok(accepted.some((r) => r.source === 'TEST-NODE-C'));
  } finally { await a.close(); await c.close(); }
});

test('the door is the last resort and is pin-verified identically', async () => {
  const descriptor = await manifestFor();
  const source = createFleetSource({ descriptor, peers: [], doorSource: bufferSource({ id: descriptor.id, kind: 'method', data: DATA }) });
  const got = await source.readRange(0, 80);
  assert.deepEqual(got, DATA.subarray(0, 80));
  assert.ok(source.stats().receipts.some((r) => r.outcome === 'accepted' && r.source === 'door'));
});

test('a local held copy is served first and verified the same way', async () => {
  const descriptor = await manifestFor();
  const source = createFleetSource({ descriptor, localSource: bufferSource({ id: descriptor.id, kind: 'method', data: DATA }) });
  const got = await source.readRange(0, 40);
  assert.deepEqual(got, DATA.subarray(0, 40));
  assert.ok(source.stats().receipts.every((r) => r.source === 'local'));
});

test('the eviction planner protects the floor and pinned rows', () => {
  const plan = chooseEvictions([
    { id: 'catalog:root', kind: 'catalog', bytes: 500, lastUsedAt: 1 },
    { id: 'method:core', kind: 'method', bytes: 500, lastUsedAt: 2 },
    { id: 'model:big', kind: 'model', bytes: 900, lastUsedAt: 3 },
    { id: 'model:old', kind: 'model', bytes: 900, lastUsedAt: 4 },
    { id: 'model:keep', kind: 'model', bytes: 900, lastUsedAt: 5, pinned: true },
  ], { budgetBytes: 2900 });
  assert.deepEqual(plan.evict, ['model:big']);
  assert.equal(plan.reachable, true);
});
