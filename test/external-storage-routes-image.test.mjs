// The routed write paths (memory, files, fleet abilities, iteration) on REAL filesystems: the small exFAT / FAT32 disk
// images of test/external-storage-image.test.mjs. Opt-in and macOS-only:
//   KM_STORAGE_IMAGES="/scratch/exfat.dmg,/scratch/fat.dmg" node --test test/external-storage-routes-image.test.mjs
// Each image is attached with `hdiutil attach -nobrowse -mountpoint <scratch>`, re-attached at a second mount point and
// read-only, and detached at the end. Any volume whose bus is not "Disk Image" is refused, so no real drive is touched.
// The engine is the stand-in (test/fixtures/external-storage/stub-engine.mjs): real SQLite (node:sqlite, WAL) on the
// image, never the real engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { approveDrive, clearStorageCache, discoverMac, driveWriter, recoverDrive, resolveStorage, resolveStorageCached, JOURNAL_DIR } from '../lib/external-storage.mjs';
import { resolvePaths } from '../lib/paths.mjs';
import { startBackend } from '../lib/runtime.mjs';
import { kingmakerHome, saveHomeFile } from '../lib/kingmaker-home.mjs';
import { iterateMethod, methodStoreIndexUrl } from '../lib/method-iteration.mjs';

const IMAGES = String(process.env.KM_STORAGE_IMAGES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const skip = process.platform !== 'darwin' || !IMAGES.length ? 'set KM_STORAGE_IMAGES to scratch .dmg test images (macOS only)' : false;
const STUB = fileURLToPath(new URL('./fixtures/external-storage/stub-engine.mjs', import.meta.url));
const LIB = new URL('../lib/external-storage.mjs', import.meta.url).href;
const attach = (dmg, mp, ro = false) => { mkdirSync(mp, { recursive: true }); execFileSync('hdiutil', ['attach', '-nobrowse', ...(ro ? ['-readonly'] : []), '-mountpoint', mp, dmg], { stdio: 'ignore' }); };
const detach = (mp) => { try { execFileSync('hdiutil', ['detach', mp], { stdio: 'ignore' }); } catch { /* not attached */ } };
// diskutil can answer with an empty record for a moment right after an attach (measured once on the FAT32 image):
// ask again briefly; anything still not a disk image is refused.
const discover = (mp) => {
  let v = null;
  for (let i = 0; i < 10; i++) {
    v = discoverMac({ extraMounts: [mp] }).find((x) => x.mountPoint === mp);
    if (!v || v.bus === 'Disk Image') break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  if (v) assert.equal(v.bus, 'Disk Image', `refusing: ${mp} is not a disk image`);
  return v;
};
const methodText = (id) => `# ${id}\n\n\`\`\`kingmaker-method\n${JSON.stringify({ id, version: '1.0', title: id, domain: 'test', inputs: { prompt: '' }, steps: [{ n: 1, id: 'solve', type: 'reason', into: 'answer', preamble: 'Answer.', prompt: '{{inputs.prompt}}' }] }, null, 2)}\n\`\`\`\n`;

async function engineRun(paths, env, storage, remember = null) {
  const b = await startBackend({ paths, port: 0, secrets: { nonce: 'n'.repeat(64), voiceKey: 'v'.repeat(64) }, env: { ...env, ...(remember ? { STUB_REMEMBER: remember } : {}) }, storage });
  await b.ready; assert.equal((await b.exited).code, 0);
  await new Promise((r) => setTimeout(r, 100));
  const line = readFileSync(b.logPath, 'utf8').split('\n').find((l) => l.startsWith('STUB_MEMORY '));
  assert(line, readFileSync(b.logPath, 'utf8'));
  return JSON.parse(line.slice('STUB_MEMORY '.length));
}

if (!IMAGES.length) test('routed write paths on real filesystem disk images (exFAT / FAT32)', { skip }, () => {});
for (const dmg of IMAGES) {
  test(`routed write paths on ${basename(dmg)}: memory (SQLite), files, iteration — save/retrieve → remount → missing → read-only → interruption`, { skip }, async () => {
    const scratch = dirname(dmg), tag = basename(dmg, '.dmg');
    const mp1 = join(scratch, `r1-${tag}`), mp2 = join(scratch, `r2-${tag}`);
    const base = mkdtempSync(join(tmpdir(), 'km-routes-img-')), state = join(base, 'state'); mkdirSync(state);
    const env = { HOME: base, PATH: process.env.PATH, SOL_GHOST_HOME: state };
    const paths = { ...resolvePaths(env, base), runtimeSource: 'bundle', binary: process.execPath, headlessEntry: STUB };
    detach(mp1); detach(mp2);
    attach(dmg, mp1);
    try {
      const v = discover(mp1); assert(v?.stableId);
      const e = approveDrive({ state, volume: v, roles: ['memory', 'files', 'user-methods'], confirm: true });
      let storage = resolveStorage({ state, volumes: [v] });
      // memory: real SQLite (WAL) on the image, through startBackend
      const m1 = await engineRun(paths, env, storage, `remembered on ${v.fsName}`);
      assert.equal(m1.data, join(e.root, 'memory')); assert.deepEqual(m1.rows, [`remembered on ${v.fsName}`]);
      assert.equal(existsSync(join(paths.runtimeHome, 'data', 'sqlite')), false);
      console.log(`# ${tag}: SQLite memory opened on ${v.fsName}; files after close: ${readdirSync(join(e.root, 'memory', 'sqlite')).join(', ')}`);
      // files
      clearStorageCache(); resolveStorageCached({ state, volumes: [v], ttlMs: 60_000 });
      const saved = await saveHomeFile('documents', 'note.txt', 'on the image', { env, home: base });
      assert(saved.startsWith(mp1));
      // iteration through the drive writer
      const user = join(e.root, 'abilities', 'methods'); mkdirSync(user, { recursive: true });
      const w = driveWriter({ root: e.root, maxFileBytes: v.capabilities.maxFileBytes });
      await w(join(user, 'probe-method.method.md'), methodText('probe-method'));
      await w(join(user, 'index.json'), JSON.stringify({ schema: 'kingmaker.methods/1', methods: [{ id: 'probe-method', title: 'probe-method', domain: 'test', file: 'probe-method.method.md', quality: { tier: 'draft', score: 50, basis: 'fixture' } }] }));
      const it = await iterateMethod({ methodId: 'probe-method', storeDir: user, sourceIndexUrl: methodStoreIndexUrl(user), inputUpdates: { prompt: 'x' }, put: w });
      assert.equal(it.toVersion, '1.1'); assert.deepEqual(readdirSync(join(e.root, JOURNAL_DIR)), []);
      // reconnect under a changed mount path
      detach(mp1); attach(dmg, mp2);
      const v2 = discover(mp2); assert.deepEqual(v2.stableId, v.stableId);
      storage = resolveStorage({ state, volumes: [v2] });
      const m2 = await engineRun(paths, env, storage, 'after remount');
      assert.equal(m2.data, join(mp2, 'Kingmaker', e.installId, 'memory')); assert.deepEqual(m2.rows, [`remembered on ${v.fsName}`, 'after remount']);
      clearStorageCache(); resolveStorageCached({ state, volumes: [v2], ttlMs: 60_000 });
      assert.equal(readFileSync(join(kingmakerHome(env, base), 'Documents', 'note.txt'), 'utf8'), 'on the image');
      // missing
      detach(mp2);
      storage = resolveStorage({ state, volumes: discoverMac({ extraMounts: [mp2] }) });
      await assert.rejects(startBackend({ paths, port: 0, secrets: { nonce: 'n', voiceKey: 'v' }, env, storage }), /Unavailable: memory.*not connected/);
      clearStorageCache(); resolveStorageCached({ state, volumes: [], ttlMs: 60_000 });
      assert.throws(() => kingmakerHome(env, base), /STORAGE_UNAVAILABLE/);
      assert.equal(existsSync(join(paths.runtimeHome, 'data', 'sqlite')), false); assert.equal(existsSync(join(state, 'Files')), false);
      // read-only: memory refused (SQLite needs to write), files readable but not writable
      attach(dmg, mp1, true);
      const vro = discover(mp1); assert.equal(vro.readOnly, true);
      storage = resolveStorage({ state, volumes: [vro] });
      await assert.rejects(startBackend({ paths, port: 0, secrets: { nonce: 'n', voiceKey: 'v' }, env, storage }), /Unavailable: memory.*read-only/);
      clearStorageCache(); resolveStorageCached({ state, volumes: [vro], ttlMs: 60_000 });
      assert.equal(readFileSync(join(kingmakerHome(env, base), 'Documents', 'note.txt'), 'utf8'), 'on the image');
      await assert.rejects(saveHomeFile('documents', 'x.txt', 'x', { env, home: base }), /read-only/);
      detach(mp1); attach(dmg, mp1);
      storage = resolveStorage({ state, volumes: [discover(mp1)] });
      const root = storage.roles.files.root;
      // interrupted synchronous save (the fleet-ability writer), SIGKILL before the rename, then recovery
      const target = join(root, 'files', 'Documents', 'note.txt');
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', `const { safeWriteFileSync } = await import(${JSON.stringify(LIB)}); safeWriteFileSync(${JSON.stringify(target)}, Buffer.alloc(1 << 20, 2), { root: ${JSON.stringify(root)}, fault: (s) => { if (s === 'before-rename') process.kill(process.pid, 'SIGKILL'); } });`]);
      assert.equal(child.signal, 'SIGKILL');
      assert.equal(readFileSync(target, 'utf8'), 'on the image', 'the previous version is intact');
      assert.match(recoverDrive(root)[0].outcome, /rolled-back/); assert.deepEqual(readdirSync(join(root, JOURNAL_DIR)), []);
      const m3 = await engineRun(paths, env, storage);
      assert.deepEqual(m3.rows, [`remembered on ${v.fsName}`, 'after remount'], 'memory survived detach / read-only / re-attach');
    } finally {
      detach(mp1); detach(mp2); clearStorageCache();
      rmSync(base, { recursive: true, force: true });
    }
  });
}
