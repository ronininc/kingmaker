// The streaming layer's memory-bounded paths, file-backed sources (internal disk or an
// external drive) and the opt-in reusable block cache. See lib/brain-library-access.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, appendFileSync, existsSync, renameSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBrainLibraryAccess, fileSource, hashFile, readFileRange, virtualSource, writeAll, MODE_DOWNLOAD } from '../lib/brain-library-access.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
function setup(bytes = 3 * 1024 * 1024) {
  const dir = mkdtempSync(join(tmpdir(), 'km-streaming-'));
  const data = randomBytes(bytes);
  const path = join(dir, 'drive', 'library.bin');
  require_dir(join(dir, 'drive')); writeFileSync(path, data);
  return { dir, data, path, storeDir: join(dir, 'store'), cacheDir: join(dir, 'cache'), stateDir: join(dir, 'state') };
}
import { mkdirSync } from 'node:fs';
function require_dir(d) { mkdirSync(d, { recursive: true }); }
/** Wrap a source so every range it is asked for is recorded. */
function counted(source) {
  const calls = [];
  return { source: { ...source, readRange: async (start, length) => { calls.push({ start, length }); return source.readRange(start, length); } }, calls };
}

test('readFileRange and hashFile read a file without holding it whole', async () => {
  const t = setup();
  const part = await readFileRange(t.path, 1000, 5000);
  assert.deepEqual(part, t.data.subarray(1000, 6000));
  assert.equal((await readFileRange(t.path, t.data.length - 10, 100)).length, 10, 'a range past the end is short, not padded');
  assert.deepEqual(await hashFile(t.path), { sha256: sha(t.data), bytes: t.data.length });
  rmSync(t.dir, { recursive: true, force: true });
});

test('a file source serves ranges from disk and pins the file hash', async () => {
  const t = setup();
  const s = await fileSource({ id: 'lib', kind: 'knowledge', path: t.path });
  assert.equal(s.size, t.data.length);
  assert.equal(s.sha256, sha(t.data));
  assert.deepEqual(await s.readRange(2_000_000, 4096), t.data.subarray(2_000_000, 2_004_096));
  rmSync(t.dir, { recursive: true, force: true });
});

test('when the drive goes away the read fails with SOURCE_UNAVAILABLE and names the path', async () => {
  const t = setup();
  const s = await fileSource({ id: 'lib', kind: 'knowledge', path: t.path });
  rmSync(join(t.dir, 'drive'), { recursive: true, force: true }); // the drive is unplugged
  await assert.rejects(s.readRange(0, 1024), (e) => e.code === 'SOURCE_UNAVAILABLE' && e.path === t.path && /reconnect the drive/.test(e.message));
  await assert.rejects(fileSource({ id: 'gone', kind: 'knowledge', path: t.path }), (e) => e.code === 'SOURCE_UNAVAILABLE');
  rmSync(t.dir, { recursive: true, force: true });
});

test('streaming a file source end to end asks the disk only for bounded portions', async () => {
  const t = setup();
  const { source, calls } = counted(await fileSource({ id: 'lib', kind: 'knowledge', path: t.path }));
  const access = createBrainLibraryAccess({ sources: { lib: source }, storeDir: t.storeDir, cacheDir: t.cacheDir, stateDir: t.stateDir });
  const h = createHash('sha256');
  const r = await access.streamThrough('lib', { portionBytes: 262_144, onPortion: (d) => { h.update(d); } });
  assert.equal(r.bytes, t.data.length);
  assert.equal(h.digest('hex'), sha(t.data), 'the bytes that came through are the file');
  assert.ok(calls.every((c) => c.length <= 262_144), 'no read asked for more than one portion');
  assert.equal(calls.length, Math.ceil(t.data.length / 262_144));
  assert.ok((await access.diskState()).cacheBytes <= 262_144, 'the rolling cache on disk is at most one portion');
  rmSync(t.dir, { recursive: true, force: true });
});

test('download writes segments straight to disk and accepts only the pinned hash', async () => {
  const t = setup();
  const s = await fileSource({ id: 'lib', kind: 'knowledge', path: t.path });
  const access = createBrainLibraryAccess({ sources: { lib: s }, storeDir: t.storeDir, cacheDir: t.cacheDir, stateDir: t.stateDir });
  const got = await access.download('lib');
  assert.equal(got.sha256, sha(t.data)); assert.equal(got.bytes, t.data.length);
  assert.equal(sha(readFileSync(got.path)), sha(t.data), 'the resident file is byte-identical');
  assert.equal(access.getMode('lib'), MODE_DOWNLOAD);
  const p = await access.readPortion('lib', { start: 1_000_000, length: 2048 });
  assert.equal(p.from, 'local'); assert.deepEqual(p.data, t.data.subarray(1_000_000, 1_002_048));
  // A resident that changes on disk stops being served as verified.
  appendFileSync(got.path, 'tampered');
  assert.equal((await access.verifyResident('lib')).ok, false);
  assert.equal((await access.readPortion('lib', { start: 0, length: 16 })).from, 'stream', 'an unverified resident is not served; the read falls back to the source');
  // A wrong pin refuses the pull and leaves no resident and no .part behind.
  const bad = createBrainLibraryAccess({ sources: { lib: { ...s, sha256: '0'.repeat(64) } }, storeDir: join(t.dir, 'store2'), cacheDir: t.cacheDir, stateDir: join(t.dir, 'state2') });
  await assert.rejects(bad.download('lib'), /hash mismatch/);
  assert.ok(!existsSync(join(t.dir, 'store2', 'lib.resident')) && !existsSync(join(t.dir, 'store2', 'lib.resident.part')));
  rmSync(t.dir, { recursive: true, force: true });
});

test('a virtual source reads only the requested bytes of a member that offers ranges', async () => {
  const t = setup(600_000);
  let whole = 0; const ranges = [];
  const member = { key: 'm', size: t.data.length, read: async () => { whole++; return readFileSync(t.path); }, readRange: async (start, length) => { ranges.push(length); return readFileRange(t.path, start, length); } };
  const v = virtualSource({ id: 'v', kind: 'training', members: [member] });
  assert.deepEqual(await v.readRange(500, 100), t.data.subarray(500, 600));
  assert.equal(whole, 0, 'the member was never read whole'); assert.deepEqual(ranges, [100]);
  rmSync(t.dir, { recursive: true, force: true });
});

test('the reusable block cache is off by default and, when on, serves repeats without the source', async () => {
  const t = setup(2 * 1024 * 1024);
  const base = await fileSource({ id: 'lib', kind: 'knowledge', path: t.path });
  const off = counted(base);
  const a0 = createBrainLibraryAccess({ sources: { lib: off.source }, storeDir: t.storeDir, cacheDir: t.cacheDir, stateDir: t.stateDir });
  await a0.readPortion('lib', { start: 0, length: 65_536 }); await a0.readPortion('lib', { start: 0, length: 65_536 });
  assert.equal(off.calls.length, 2, 'off: every repeat goes back to the source');
  assert.equal(a0.reuseStats().budgetBytes, 0);

  const on = counted(base);
  const a1 = createBrainLibraryAccess({ sources: { lib: on.source }, storeDir: t.storeDir, cacheDir: t.cacheDir, stateDir: t.stateDir, reuseCacheBytes: 200_000 });
  const first = await a1.readPortion('lib', { start: 0, length: 65_536 });
  const again = await a1.readPortion('lib', { start: 0, length: 65_536 });
  assert.equal(on.calls.length, 1, 'on: the repeat did not touch the source');
  assert.equal(first.reused, false); assert.equal(again.reused, true); assert.deepEqual(again.data, t.data.subarray(0, 65_536));
  // The budget is a hard ceiling across everything held: older blocks leave first.
  for (let i = 1; i <= 4; i++) await a1.readPortion('lib', { start: i * 65_536, length: 65_536 });
  const st = a1.reuseStats();
  assert.ok(st.heldBytes <= 200_000 && st.evictions >= 2, JSON.stringify(st));
  await a1.readPortion('lib', { start: 0, length: 65_536 });
  assert.equal(on.calls.length, 6, 'the evicted first block is fetched again');
  // One block larger than the whole budget is simply not kept.
  const a2 = createBrainLibraryAccess({ sources: { lib: base }, storeDir: t.storeDir, cacheDir: t.cacheDir, stateDir: t.stateDir, reuseCacheBytes: 1000 });
  await a2.readPortion('lib', { start: 0, length: 65_536 });
  assert.equal(a2.reuseStats().heldBytes, 0);
  // Forgetting an item drops its blocks.
  await a1.forget('lib');
  assert.equal(a1.reuseStats().blocks, 0);
  rmSync(t.dir, { recursive: true, force: true });
});

test('a caller changing the bytes it was handed does not change what later reads return', async () => {
  const t = setup(256 * 1024);
  const base = await fileSource({ id: 'lib', kind: 'knowledge', path: t.path });
  const access = createBrainLibraryAccess({ sources: { lib: base }, storeDir: t.storeDir, cacheDir: t.cacheDir, stateDir: t.stateDir, reuseCacheBytes: 100_000 });
  const want = Buffer.from(t.data.subarray(0, 4096));
  const first = await access.readPortion('lib', { start: 0, length: 4096 });
  first.data.fill(0xff);
  const second = await access.readPortion('lib', { start: 0, length: 4096 });
  assert.equal(second.reused, true);
  assert.deepEqual(second.data, want, 'the cached copy was not touched by the first caller');
  second.data.fill(0x00);
  assert.deepEqual((await access.readPortion('lib', { start: 0, length: 4096 })).data, want, 'nor by a caller that got a cache hit');
  rmSync(t.dir, { recursive: true, force: true });
});

test('several reads of one range at the same moment are counted once', async () => {
  const t = setup(64 * 1024);
  const base = await fileSource({ id: 'lib', kind: 'knowledge', path: t.path });
  const access = createBrainLibraryAccess({ sources: { lib: base }, storeDir: t.storeDir, cacheDir: t.cacheDir, stateDir: t.stateDir, reuseCacheBytes: 32 });
  await Promise.all(Array.from({ length: 5 }, () => access.readPortion('lib', { start: 0, length: 16 })));
  assert.deepEqual({ held: access.reuseStats().heldBytes, blocks: access.reuseStats().blocks }, { held: 16, blocks: 1 });
  await access.readPortion('lib', { start: 16, length: 16 });
  assert.deepEqual({ held: access.reuseStats().heldBytes, blocks: access.reuseStats().blocks }, { held: 32, blocks: 2 }, 'the cache still has room for a second block');
  rmSync(t.dir, { recursive: true, force: true });
});

test('a resident swapped for a same-size file with the same modified time is hashed again', async () => {
  const t = setup(8 * 1024);
  const s = await fileSource({ id: 'lib', kind: 'knowledge', path: t.path });
  const access = createBrainLibraryAccess({ sources: { lib: s }, storeDir: t.storeDir, cacheDir: t.cacheDir, stateDir: t.stateDir });
  const got = await access.download('lib');
  const when = new Date('2026-01-01T00:00:00Z');
  utimesSync(got.path, when, when); // a whole-second time, so the copy below can be given exactly the same one
  assert.equal((await access.verifyResident('lib')).ok, true);
  const before = statSync(got.path);
  const swap = `${got.path}.swap`;
  writeFileSync(swap, randomBytes(t.data.length));
  utimesSync(swap, before.atime, before.mtime);
  renameSync(swap, got.path);
  const after = statSync(got.path);
  assert.equal(after.size, before.size); assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal((await access.verifyResident('lib')).ok, false, 'the replacement did not inherit the old verification');
  rmSync(t.dir, { recursive: true, force: true });
});

test('writeAll keeps writing when the file system stores fewer bytes than asked', async () => {
  const stored = Buffer.alloc(1024);
  const calls = [];
  const fh = { write: async (buf, offset, length, position) => { const n = Math.min(7, length); buf.copy(stored, position, offset, offset + n); calls.push(n); return { bytesWritten: n }; } };
  const data = randomBytes(1000);
  assert.equal(await writeAll(fh, data, 24), 1000);
  assert.deepEqual(stored.subarray(24, 1024), data);
  assert.ok(calls.length > 100);
  await assert.rejects(writeAll({ write: async () => ({ bytesWritten: 0 }) }, data, 0), /stored no bytes/);
});
