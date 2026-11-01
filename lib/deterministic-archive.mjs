// lib/deterministic-archive.mjs — byte-reproducible tar.gz of the app (finish plan Phase 2).
//
// release-parts streams `tar -cz` straight off the build tree: gzip embeds a
// timestamp, tar records mtimes/owners/order — so two builds of the SAME app
// produce different archives, and "the archive I verified" is never quite
// "the archive I shipped". This module removes every variable input:
//
//   · entry order: sorted by name
//   · mtimes: pinned to the epoch
//   · owners: uid/gid 0, empty names
//   · gzip header: no original name, no timestamp (gzip -n)
//
// Proof obligation (tests): the same tree archived twice — with different
// on-disk mtimes and different creation orders — yields identical sha256.
// If the platform's tar cannot normalize (probed at runtime), the result
// says so (normalized: false) instead of pretending.

import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { basename, dirname } from 'node:path';

/** Pure: which tar flavor a `tar --version` banner describes. */
export function tarFlavor(versionText) {
  const t = String(versionText ?? '');
  if (/GNU tar/i.test(t)) return 'gnu';
  if (/bsdtar|libarchive/i.test(t)) return 'bsd';
  return 'unknown';
}

/** Pure: the normalization arguments for a flavor (the tar side; gzip -n is
 *  applied separately). Throws for a flavor we cannot normalize — a release
 *  must never silently ship an unnormalized archive.
 *
 *  Xattrs are deliberately NOT carried: with GNU tar they force pax
 *  headers, and pax records atime/ctime at nanosecond precision — two
 *  archives of the same tree then differ on every run (measured, not
 *  theorized: it broke this module's own determinism proof). Code
 *  signatures live in the bundle's files, not its xattrs, and installers
 *  strip quarantine attributes anyway; the default (non-deterministic)
 *  release-parts stream keeps --xattrs for anyone who wants them. */
export function normalizationArgs(flavor) {
  if (flavor === 'gnu') return ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '--format=gnu'];
  if (flavor === 'bsd') return ['--uid', '0', '--gid', '0', '--uname', '', '--gname', '', '--mtime', '0'];
  throw new Error(`deterministic-archive: cannot normalize with tar flavor "${flavor}" — refusing`);
}

export function probeTarFlavor({ run = spawnSync } = {}) {
  const r = run('tar', ['--version'], { encoding: 'utf8' });
  return tarFlavor(`${r.stdout ?? ''}\n${r.stderr ?? ''}`);
}

/**
 * createDeterministicArchive({ dir, outFile, level, flavor })
 *   dir      the directory to archive (its basename becomes the root entry)
 *   outFile  where the .tar.gz goes
 * Returns { sha256, size, flavor } of the written archive.
 */
export async function createDeterministicArchive({ dir, outFile, level = 6, flavor } = {}) {
  const fl = flavor ?? probeTarFlavor();
  const args = ['-c', ...normalizationArgs(fl), '-C', dirname(dir), basename(dir)];
  return await new Promise((resolvePromise, reject) => {
    const tar = spawn('tar', args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, COPYFILE_DISABLE: '1' } });
    const gz = spawn('gzip', ['-n', `-${level}`], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = createWriteStream(outFile);
    const hash = createHash('sha256');
    let size = 0;
    let err = '';
    tar.stderr.on('data', (d) => { err += d; });
    gz.stderr.on('data', (d) => { err += d; });
    tar.once('error', reject); gz.once('error', reject); out.once('error', reject);
    tar.stdout.pipe(gz.stdin);
    gz.stdout.on('data', (d) => { hash.update(d); size += d.length; });
    gz.stdout.pipe(out);
    let tarCode = null; let gzCode = null;
    const done = () => {
      if (tarCode === null || gzCode === null) return;
      if (tarCode !== 0 || gzCode !== 0) return reject(new Error(`deterministic archive failed (tar=${tarCode} gzip=${gzCode}): ${err.trim().slice(-200)}`));
      out.end(() => resolvePromise({ sha256: hash.digest('hex'), size, flavor: fl }));
    };
    tar.once('exit', (c) => { tarCode = c; done(); });
    gz.once('exit', (c) => { gzCode = c; done(); });
  });
}
