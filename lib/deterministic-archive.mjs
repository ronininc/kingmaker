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
import { PassThrough, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

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


// Apple bsdtar cannot set all mtimes or guarantee traversal order. Python's
// streaming tar writer sorts directory members, normalizes the header, and
// preserves file modes and links without building a normalized copy on disk.
const BSD_TAR_WRITER = `
import sys, tarfile
def normalize(info):
    info.uid = info.gid = info.mtime = 0
    info.uname = info.gname = ''
    if not (info.isfile() or info.isdir() or info.issym() or info.islnk()):
        raise ValueError('unsupported archive file type: ' + info.name)
    return info
with tarfile.open(fileobj=sys.stdout.buffer, mode='w|', format=tarfile.GNU_FORMAT) as out:
    out.add(sys.argv[1], arcname=sys.argv[2], filter=normalize)
`;

/** Normalized tar.gz byte stream. It ends successfully only after both children
 *  exit cleanly; an incomplete archive must not be finalized as valid parts. */
export function streamDeterministicArchive({ dir, level = 6, flavor } = {}) {
  if (!Number.isInteger(level) || level < 1 || level > 9) throw new Error('invalid gzip level');
  const fl = flavor ?? probeTarFlavor();
  const cmd = fl === 'bsd' ? 'python3' : 'tar';
  const args = fl === 'bsd'
    ? ['-I', '-c', BSD_TAR_WRITER, dir, basename(dir)]
    : ['-c', ...normalizationArgs(fl), '-C', dirname(dir), basename(dir)];
  const env = { ...process.env, COPYFILE_DISABLE: '1', GZIP: '' };
  const tar = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
  const gz = spawn('gzip', ['-n', `-${level}`], { stdio: ['pipe', 'pipe', 'pipe'], env });
  const stream = new PassThrough();
  let diagnostics = '';
  for (const child of [tar, gz]) child.stderr.on('data', d => { diagnostics = (diagnostics + d).slice(-800); });
  const exited = (child, name) => new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`deterministic archive failed (${name}=${code ?? signal}): ${diagnostics.trim()}`));
    });
  });
  const cancel = () => {
    for (const child of [tar, gz]) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  };
  stream.once('close', () => { if (!stream.writableFinished) cancel(); });
  Promise.all([
    exited(tar, cmd), exited(gz, 'gzip'),
    pipeline(tar.stdout, gz.stdin),
    pipeline(gz.stdout, stream, { end: false }),
  ]).then(() => stream.end(), error => {
    cancel();
    stream.destroy(error);
  });
  return { stream, flavor: fl };
}

/** Compatibility wrapper for callers that explicitly need one file. The
 *  production part writer consumes streamDeterministicArchive directly. */
export async function createDeterministicArchive({ dir, outFile, level = 6, flavor } = {}) {
  const archive = streamDeterministicArchive({ dir, level, flavor });
  const hash = createHash('sha256');
  let size = 0;
  const meter = new Transform({
    transform(chunk, _encoding, done) {
      hash.update(chunk); size += chunk.length;
      done(null, chunk);
    },
  });
  await pipeline(archive.stream, meter, createWriteStream(outFile));
  return { sha256: hash.digest('hex'), size, flavor: archive.flavor };
}
