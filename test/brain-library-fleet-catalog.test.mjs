// Fleet follow-on 1 — lib/brain-library-fleet-catalog.mjs.
// The published catalog must carry portion pins that agree with v1's builder,
// and the loader must refuse incomplete entries by name, never trust them.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bufferSource } from '../lib/brain-library-access.mjs';
import { buildPortionManifest } from '../lib/brain-library-fleet.mjs';
import { buildFleetCatalog, buildFleetDescriptor, fleetDescriptorProblems, loadFleetCatalog, writeFleetCatalog } from '../lib/brain-library-fleet-catalog.mjs';

const DATA = Buffer.from('fleet catalog publication — the manifest rides the catalog.\n'.repeat(9));
const OPTS = { portionBytes: 64 };

test('the catalog builder agrees with v1 buildPortionManifest, pin for pin', async () => {
  const source = bufferSource({ id: 'method:agree', kind: 'method', data: DATA });
  const fromCatalog = await buildFleetDescriptor(source, OPTS);
  const fromV1 = await buildPortionManifest(source, OPTS);
  assert.deepEqual(fromCatalog, fromV1);
});

test('a virtual source with no whole pin gets one computed from its bytes', async () => {
  const source = bufferSource({ id: 'training:virtual', kind: 'training', data: DATA });
  source.sha256 = null; // virtualSource() shape: no pinned whole hash
  const d = await buildFleetDescriptor(source, OPTS);
  assert.equal(d.sha256, bufferSource({ id: 'x', kind: 'training', data: DATA }).sha256);
  assert.equal(fleetDescriptorProblems(d).length, 0);
});

test('the builder refuses a source whose carried pin contradicts its bytes', async () => {
  const lying = bufferSource({ id: 'method:lying', kind: 'method', data: DATA, sha256: '0'.repeat(64) });
  await assert.rejects(() => buildFleetDescriptor(lying, OPTS), (e) => e.code === 'FLEET_CATALOG_PIN_CONFLICT');
});

test('buildFleetCatalog skips non-item kinds and names them', async () => {
  const sources = new Map([
    ['method:agree', bufferSource({ id: 'method:agree', kind: 'method', data: DATA })],
    ['training-part:m/p', bufferSource({ id: 'training-part:m/p', kind: 'training-part', data: DATA })],
  ]);
  const catalog = await buildFleetCatalog({ sources, ...OPTS });
  assert.deepEqual(catalog.items.map((i) => i.id), ['method:agree']);
  assert.deepEqual(catalog.skipped.map((s) => s.id), ['training-part:m/p']);
});

test('the loader round-trips a written catalog and rejects broken entries by name', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-catalog-'));
  const path = join(dir, 'fleet.json');
  const catalog = await buildFleetCatalog({ sources: new Map([['method:agree', bufferSource({ id: 'method:agree', kind: 'method', data: DATA })]]), ...OPTS });
  await writeFleetCatalog(path, catalog);
  const ok = await loadFleetCatalog(path);
  assert.equal(ok.items.size, 1);
  assert.equal(ok.rejected.length, 0);

  const broken = JSON.parse(await readFile(path, 'utf8'));
  broken.items.push({ id: 'method:no-manifest', kind: 'method', size: 10, sha256: 'a'.repeat(64), portionBytes: 64 });
  broken.items.push({ id: 'method:short-manifest', kind: 'method', size: 200, sha256: 'b'.repeat(64), portionBytes: 64, portionSha256: ['c'.repeat(64)] });
  const path2 = join(dir, 'fleet-broken.json');
  await writeFile(path2, JSON.stringify(broken));
  const loaded = await loadFleetCatalog(path2);
  assert.equal(loaded.items.size, 1, 'only the complete entry is loadable');
  assert.deepEqual(loaded.rejected.map((r) => r.id), ['method:no-manifest', 'method:short-manifest']);
  assert.match(loaded.rejected[0].problems.join(' '), /portionSha256 missing/);
  assert.match(loaded.rejected[1].problems.join(' '), /portions expected/);
});

test('the loader throws on a wrong-schema file rather than trusting it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-catalog-'));
  const path = join(dir, 'fleet.json');
  await writeFile(path, JSON.stringify({ schema: 'something-else/9', items: [] }));
  await assert.rejects(() => loadFleetCatalog(path), (e) => e.code === 'FLEET_CATALOG_SCHEMA');
});
