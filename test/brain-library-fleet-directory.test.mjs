// Fleet follow-on 2 — lib/brain-library-fleet-directory.mjs.
// Nodes must find each other through the directory with NO hardcoded peer
// list: a participant configured with only the directory's address pulls a
// pin-verified portion from a node whose address it could not have known.
import assert from 'node:assert/strict';
import test from 'node:test';
import { bufferSource } from '../lib/brain-library-access.mjs';
import { buildPortionManifest, createFleetNode } from '../lib/brain-library-fleet.mjs';
import { createDiscoveredFleetSource, createFleetDirectory, discoverFleetPeers, registerFleetNode, startDirectoryHeartbeat } from '../lib/brain-library-fleet-directory.mjs';

const DATA = Buffer.from('discovery is a directory lookup, never a typed-in address.\n'.repeat(6));
const OPTS = { portionBytes: 64 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('two nodes register; a third party discovers both by name, excluding itself', async () => {
  const directory = createFleetDirectory({ directoryId: 'TEST-DIRECTORY' });
  const { url: dirUrl } = await directory.listen();
  await registerFleetNode({ directoryUrl: dirUrl, nodeId: 'TEST-NODE-A', url: 'http://127.0.0.1:41001' });
  await registerFleetNode({ directoryUrl: dirUrl, nodeId: 'TEST-NODE-B', url: 'http://127.0.0.1:41002' });
  const all = await discoverFleetPeers({ directoryUrl: dirUrl });
  assert.deepEqual(all.map((p) => p.nodeId), ['TEST-NODE-A', 'TEST-NODE-B']);
  const others = await discoverFleetPeers({ directoryUrl: dirUrl, excludeNodeId: 'TEST-NODE-A' });
  assert.deepEqual(others.map((p) => p.nodeId), ['TEST-NODE-B']);
  await directory.close();
});

test('registrations expire without renewal and survive with a heartbeat', async () => {
  let clock = 1_000_000;
  const directory = createFleetDirectory({ directoryId: 'TEST-DIRECTORY-TTL', ttlMs: 300, now: () => clock });
  const { url: dirUrl } = await directory.listen();
  await registerFleetNode({ directoryUrl: dirUrl, nodeId: 'TEST-NODE-QUIET', url: 'http://127.0.0.1:41003' });
  assert.equal((await discoverFleetPeers({ directoryUrl: dirUrl })).length, 1);
  clock += 301; // past the TTL, no renewal
  assert.deepEqual(await discoverFleetPeers({ directoryUrl: dirUrl }), []);
  await directory.close();

  const liveDir = createFleetDirectory({ directoryId: 'TEST-DIRECTORY-HB', ttlMs: 350 });
  const { url: liveUrl } = await liveDir.listen();
  await registerFleetNode({ directoryUrl: liveUrl, nodeId: 'TEST-NODE-LOUD', url: 'http://127.0.0.1:41004' });
  const hb = startDirectoryHeartbeat({ directoryUrl: liveUrl, nodeId: 'TEST-NODE-LOUD', url: 'http://127.0.0.1:41004', intervalMs: 100 });
  await sleep(500); // > TTL: only the heartbeats keep this registration alive
  assert.deepEqual((await discoverFleetPeers({ directoryUrl: liveUrl })).map((p) => p.nodeId), ['TEST-NODE-LOUD']);
  assert.ok(hb.renewals.length >= 3, `expected several renewals, got ${hb.renewals.length}`);
  hb.stop();
  await sleep(450);
  assert.deepEqual(await discoverFleetPeers({ directoryUrl: liveUrl }), []);
  await liveDir.close();
});

test('a directory that requires admission refuses anonymous registration and lookup', async () => {
  const directory = createFleetDirectory({ directoryId: 'TEST-DIRECTORY-TOKEN', meshToken: 'TEST-MESH-TOKEN' });
  const { url: dirUrl } = await directory.listen();
  await assert.rejects(() => registerFleetNode({ directoryUrl: dirUrl, nodeId: 'X', url: 'http://127.0.0.1:1' }), /HTTP 403/);
  await registerFleetNode({ directoryUrl: dirUrl, nodeId: 'X', url: 'http://127.0.0.1:1', meshToken: 'TEST-MESH-TOKEN' });
  await assert.rejects(() => discoverFleetPeers({ directoryUrl: dirUrl }), /HTTP 403/);
  assert.equal((await discoverFleetPeers({ directoryUrl: dirUrl, meshToken: 'TEST-MESH-TOKEN' })).length, 1);
  await directory.close();
});

test('discovery end to end: only the directory address is configured, the portion still verifies', async () => {
  const descriptor = await buildPortionManifest(bufferSource({ id: 'method:discovered', kind: 'method', data: DATA }), OPTS);
  const directory = createFleetDirectory({ directoryId: 'TEST-DIRECTORY-E2E' });
  const { url: dirUrl } = await directory.listen();
  const node = createFleetNode({ nodeId: 'TEST-NODE-HOLDER', sources: new Map([[descriptor.id, bufferSource({ id: descriptor.id, kind: 'method', data: DATA })]]), ...OPTS });
  const { url: nodeUrl } = await node.listen(); // ephemeral port: nobody could hardcode it
  await registerFleetNode({ directoryUrl: dirUrl, nodeId: 'TEST-NODE-HOLDER', url: nodeUrl });

  const source = await createDiscoveredFleetSource({ descriptor, directoryUrl: dirUrl });
  assert.deepEqual(source.peerReceipts, [{ nodeId: 'TEST-NODE-HOLDER', url: nodeUrl, profile: 'standard' }]);
  const data = await source.readRange(0, OPTS.portionBytes);
  assert.deepEqual(data, DATA.subarray(0, OPTS.portionBytes));
  const accepted = source.stats().receipts.filter((r) => r.outcome === 'accepted');
  assert.ok(accepted.length === 1 && accepted[0].source === 'TEST-NODE-HOLDER');
  await node.close();
  await directory.close();
});
