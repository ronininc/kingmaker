// What Kingmaker DECLARES about a drive vs what the real filesystem does, on scratch disk images (2026-11-16 follow-up):
// HFS+ (journaled), case-sensitive APFS and an image-encrypted APFS image, alongside the exFAT / FAT32 images.
// Opt-in and macOS-only, same images as test/external-storage-image.test.mjs:
//   KM_STORAGE_IMAGES="/scratch/hfs.dmg,/scratch/apfs-cs.dmg,/scratch/apfs-enc.dmg" \
//   KM_STORAGE_IMAGE_PASSPHRASE=<the TEST passphrase the scratch image was made with> node --test <this file>
// Every volume must report bus "Disk Image" or the test refuses it: no real drive is formatted, mounted or written.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { approveDrive, discoverMac, resolveStorage, safeWriteFile } from '../lib/external-storage.mjs';

const IMAGES = String(process.env.KM_STORAGE_IMAGES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const skip = process.platform !== 'darwin' || !IMAGES.length ? 'set KM_STORAGE_IMAGES to scratch .dmg test images (macOS only)' : false;
const PASS = process.env.KM_STORAGE_IMAGE_PASSPHRASE ?? '';
const encryptedImage = (dmg) => { try { return /encrypted: YES/.test(execFileSync('hdiutil', ['isencrypted', dmg], { encoding: 'utf8' })); } catch { return false; } };
const attach = (dmg, mp) => { mkdirSync(mp, { recursive: true }); const enc = encryptedImage(dmg); execFileSync('hdiutil', ['attach', '-nobrowse', ...(enc ? ['-stdinpass'] : []), '-mountpoint', mp, dmg], { stdio: [enc ? 'pipe' : 'ignore', 'ignore', 'ignore'], ...(enc ? { input: PASS } : {}) }); };
const detach = (mp) => { try { execFileSync('hdiutil', ['detach', mp], { stdio: 'ignore' }); } catch { /* not attached */ } };
const discover = (mp) => {
  let v = null;
  for (let i = 0; i < 10; i++) { v = discoverMac({ extraMounts: [mp] }).find((x) => x.mountPoint === mp); if (v?.bus === 'Disk Image') break; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); }
  assert.equal(v?.bus, 'Disk Image', `refusing: ${mp} is not a disk image`);
  return v;
};

if (!IMAGES.length) test('declared vs real filesystem behaviour on scratch disk images', { skip }, () => {});
for (const dmg of IMAGES) {
  test(`declared vs real on ${basename(dmg)}: case sensitivity, symlinks, journaling, encryption honesty, case-distinct saves`, { skip }, async () => {
    const mp = join(dirname(dmg), `fm-${basename(dmg, '.dmg')}`);
    const state = mkdtempSync(join(tmpdir(), 'km-fsm-'));
    const imageEncrypted = encryptedImage(dmg);   // asked before attaching: hdiutil cannot answer for an attached image
    detach(mp); attach(dmg, mp);
    try {
      const v = discover(mp);
      const e = approveDrive({ state, volume: v, roles: ['files'], confirm: true });
      const c = v.capabilities, probed = e.capabilities.probed;
      console.log(`# ${basename(dmg)}: ${v.fsName} family=${c.family} caseSensitive=${c.caseSensitive}/${probed.caseSensitive} symlinks=${c.symlinks}/${probed.symlinks} journaling=${c.journaling} encrypted=${v.encrypted} imageEncrypted=${imageEncrypted}`);
      assert.equal(probed.caseSensitive, c.caseSensitive, 'case sensitivity: declared = real');
      if (c.family === 'HFS+') assert.equal(c.journaling, /journaled/i.test(v.fsName) ? true : null);
      if (c.family === 'APFS' || c.family === 'HFS+') assert.equal(probed.symlinks, true);
      // Encryption honesty: an image-layer encrypted APFS volume reports Encryption:false from diskutil. Kingmaker must
      // not pass that on as "not encrypted": for any disk image it reports unknown (null) unless diskutil says true.
      if (imageEncrypted) assert.notEqual(v.encrypted, false, 'never "not encrypted" for an encrypted image');
      assert.ok(v.encrypted === null || v.encrypted === true, `a disk image's encryption is unknown or true, got ${v.encrypted}`);
      // Two names differing only by case, saved through the verified writer: distinct files on a case-sensitive
      // filesystem; on a case-insensitive one the second save replaces the first and its read-back is what was written.
      const root = resolveStorage({ state, volumes: [v] }).roles.files.root;
      const d = join(root, 'files', 'Documents'); mkdirSync(d, { recursive: true });
      await safeWriteFile(join(d, 'Note.txt'), 'upper', { root });
      await safeWriteFile(join(d, 'note.txt'), 'lower', { root });
      const names = readdirSync(d).filter((n) => n.toLowerCase() === 'note.txt').sort();
      if (c.caseSensitive) { assert.deepEqual(names, ['Note.txt', 'note.txt']); assert.equal(readFileSync(join(d, 'Note.txt'), 'utf8'), 'upper'); }
      else { assert.equal(names.length, 1); assert.equal(readFileSync(join(d, 'Note.txt'), 'utf8'), 'lower'); }
    } finally { detach(mp); rmSync(state, { recursive: true, force: true }); }
  });
}
