// Approved external storage on REAL filesystems: small exFAT / FAT32 disk images the operator created with
// `hdiutil create -size 32m -fs ExFAT …` in a scratch folder. Opt-in and macOS-only:
//   KM_STORAGE_IMAGES="/scratch/exfat.dmg,/scratch/fat.dmg" node --test test/external-storage-image.test.mjs
// The test attaches each image itself (`hdiutil attach -nobrowse -mountpoint <scratch>`), detaches and re-attaches it
// (changed mount path, read-only), and detaches it at the end. It refuses any volume whose bus is not "Disk Image",
// so it can never act on a real drive. Skipped when KM_STORAGE_IMAGES is unset.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { approveDrive, discoverMac, recoverDrive, resolveStorage, safeWriteFile, userMethodsDestination, JOURNAL_DIR } from '../lib/external-storage.mjs';
import { createLocalBrain, handleMethodRequest } from '../lib/method-request.mjs';
import { writeMethod } from '../lib/method-writing.mjs';

const IMAGES = String(process.env.KM_STORAGE_IMAGES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const skip = process.platform !== 'darwin' || !IMAGES.length ? 'set KM_STORAGE_IMAGES to scratch .dmg test images (macOS only)' : false;
const sha = (b) => createHash('sha256').update(b).digest('hex');
// An image created with `hdiutil create -encryption … -stdinpass` is attached with KM_STORAGE_IMAGE_PASSPHRASE (a TEST
// passphrase chosen for the scratch image — never a real secret).
const PASS = process.env.KM_STORAGE_IMAGE_PASSPHRASE ?? '';
const encryptedImage = (dmg) => { try { return /encrypted: YES/.test(execFileSync('hdiutil', ['isencrypted', dmg], { encoding: 'utf8' })); } catch { return false; } };
const attach = (dmg, mp, ro = false) => { mkdirSync(mp, { recursive: true }); const enc = encryptedImage(dmg); execFileSync('hdiutil', ['attach', '-nobrowse', ...(enc ? ['-stdinpass'] : []), ...(ro ? ['-readonly'] : []), '-mountpoint', mp, dmg], { stdio: [enc ? 'pipe' : 'ignore', 'ignore', 'ignore'], ...(enc ? { input: PASS } : {}) }); };
const detach = (mp) => { try { execFileSync('hdiutil', ['detach', mp], { stdio: 'ignore' }); } catch { /* not attached */ } };
const discover = (mp) => {
  const v = discoverMac({ extraMounts: [mp] }).find((x) => x.mountPoint === mp);
  if (v) assert.equal(v.bus, 'Disk Image', `refusing: ${mp} is not a disk image`);
  return v;
};
const proposal = async () => JSON.stringify({ title: 'Miles to kilometres', domain: 'conversion', steps: [{ id: 'convert', type: 'reason', preamble: 'Convert miles to kilometres.', prompt: '{{inputs.prompt}}' }] });
const reasoner = async ({ prompt }) => `${(Number(/[\d.]+/.exec(prompt)?.[0] ?? 0) * 1.609344).toFixed(2)} km`;

if (!IMAGES.length) test('real filesystem disk images (exFAT / FAT32 / HFS+ / APFS)', { skip }, () => {});
for (const dmg of IMAGES) {
  test(`real filesystem ${basename(dmg)}: discovery → approval → save/retrieve → remount → missing → read-only → interruption → limits`, { skip }, async () => {
    const scratch = dirname(dmg);
    const mp1 = join(scratch, `m1-${basename(dmg, '.dmg')}`), mp2 = join(scratch, `m2-${basename(dmg, '.dmg')}`);
    const state = mkdtempSync(join(tmpdir(), 'km-img-state-'));
    detach(mp1); detach(mp2);
    attach(dmg, mp1);
    try {
      // discovery
      const v = discover(mp1);
      assert(v, 'the attached image is discovered'); assert(v.stableId, 'stable id present'); assert.equal(v.removable, true); assert.equal(v.internal, false);
      console.log(`# ${basename(dmg)}: ${v.name} ${v.fsName} id=${v.stableId.kind}:${v.stableId.value} free=${v.availableBytes} maxFile=${v.capabilities.maxFileBytes} caseSensitive=${v.capabilities.caseSensitive} symlinks=${v.capabilities.symlinks}`);
      // existing data the approval must not touch
      mkdirSync(join(mp1, 'Photos'), { recursive: true }); writeFileSync(join(mp1, 'Photos', 'keep.jpg'), Buffer.alloc(4096, 3));
      const keep = sha(readFileSync(join(mp1, 'Photos', 'keep.jpg')));
      const e = approveDrive({ state, volume: v, roles: ['user-methods', 'library-cache', 'models'], confirm: true });
      console.log(`# probed on the real filesystem: ${JSON.stringify(e.capabilities.probed)}`);
      assert.equal(e.capabilities.probed.caseSensitive, v.capabilities.caseSensitive, 'declared case sensitivity matches the real filesystem');
      // Measured: macOS EMULATES symlinks on exFAT/FAT (stored as special files other systems do not read as links),
      // so the probe can succeed; the declared capability stays "no native symlinks" and Kingmaker never creates one.
      assert.equal(typeof e.capabilities.probed.symlinks, 'boolean');
      if (['FAT', 'exFAT'].includes(v.capabilities.family)) assert.equal(v.capabilities.symlinks, false);
      else assert.equal(e.capabilities.probed.symlinks, v.capabilities.symlinks, 'native symlinks: declared = probed');
      // save through the normal path, then retrieve through listMethods/conductor
      let storage = resolveStorage({ state, volumes: [v] });
      const dest = userMethodsDestination(state, { storage });
      const w = await writeMethod({ task: 'convert miles to kilometres', sample: '5 miles', expect: '8.05 km', draft: proposal, reasoner, model: 'stub', userStore: dest.dir, put: dest.put, draftsDir: join(state, 'drafts') });
      assert.equal(w.status, 'promoted', w.reason); assert(w.path.startsWith(mp1));
      const run = async (st, tag) => handleMethodRequest('convert 12 miles to kilometres', { brain: createLocalBrain({ state, storage: st, reasoner, methodHunt: false }), workDir: mkdtempSync(join(tmpdir(), `km-img-${tag}-`)), inputs: { prompt: '12 miles', expect: '' } });
      let r = await run(storage, 'a');
      assert.equal(r.outcome, 'completed', r.lines.join('\n')); assert.equal(r.method.drive, v.name); assert.equal(r.outputs.answer, '19.31 km');
      // reconnect under a changed mount path
      detach(mp1); attach(dmg, mp2);
      const v2 = discover(mp2);
      assert.deepEqual(v2.stableId, v.stableId, 'the same id after re-attaching');
      storage = resolveStorage({ state, volumes: discoverMac({ extraMounts: [mp2] }) });
      assert.equal(storage.drives[0].status, 'connected'); assert.equal(storage.drives[0].mountPoint, mp2);
      r = await run(storage, 'b');
      assert.equal(r.outcome, 'completed', r.lines.join('\n')); assert.equal(r.method.store, join(mp2, 'Kingmaker', e.installId, 'abilities', 'methods'));
      // missing
      detach(mp2);
      storage = resolveStorage({ state, volumes: discoverMac({ extraMounts: [mp2] }) });
      assert.equal(storage.drives[0].status, 'missing');
      assert.throws(() => userMethodsDestination(state, { storage }), /STORAGE_UNAVAILABLE/);
      assert.equal(existsSync(join(state, 'abilities', 'methods')), false, 'no internal duplicate');
      // read-only
      attach(dmg, mp1, true);
      const vro = discover(mp1); assert.equal(vro.readOnly, true);
      storage = resolveStorage({ state, volumes: [vro] });
      assert.equal(storage.drives[0].status, 'read-only');
      r = await run(storage, 'c'); assert.equal(r.outcome, 'completed', 'read-only drive: methods still run');
      assert.throws(() => userMethodsDestination(state, { storage }), /read-only/);
      detach(mp1); attach(dmg, mp1);
      storage = resolveStorage({ state, volumes: [discover(mp1)] });
      const root = storage.roles['user-methods'].root;
      // interrupted transfer: SIGKILL between the temp write and the rename, then recovery on "next start"
      const target = join(root, 'abilities', 'methods', 'big.bin');
      await safeWriteFile(target, Buffer.alloc(1 << 20, 1), { root });
      const before = sha(readFileSync(target));
      const lib = new URL('../lib/external-storage.mjs', import.meta.url).href;
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', `const { safeWriteFile } = await import(${JSON.stringify(lib)}); await safeWriteFile(${JSON.stringify(target)}, Buffer.alloc(4 << 20, 2), { root: ${JSON.stringify(root)}, fault: async (s) => { if (s === 'before-rename') process.kill(process.pid, 'SIGKILL'); } });`]);
      assert.equal(child.signal, 'SIGKILL');
      assert.equal(sha(readFileSync(target)), before, 'the final file is the intact previous version');
      const rec = recoverDrive(root);
      assert.match(rec[0].outcome, /rolled-back/); assert.deepEqual(readdirSync(join(root, JOURNAL_DIR)), []);
      assert(!readdirSync(join(root, 'abilities', 'methods')).some((n) => n.includes('.km-tmp-')));
      // capacity: larger than the whole image → refused by the real statfs before anything is written
      await assert.rejects(safeWriteFile(join(root, 'models', 'too-big.gguf'), Buffer.alloc(48 << 20), { root }), /STORAGE_NO_SPACE/);
      assert.equal(existsSync(join(root, 'models', 'too-big.gguf')), false);
      assert.equal(sha(readFileSync(join(mp1, 'Photos', 'keep.jpg'))), keep, 'pre-existing data preserved');
    } finally {
      detach(mp1); detach(mp2);
      rmSync(state, { recursive: true, force: true });
    }
  });
}
