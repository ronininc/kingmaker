// cell.mjs — Closure 2 cell substrate (SPEC §2.2/§2.4). Zero-dependency
// Node >= 22; the only externals are OS facilities (unshare / bwrap) and,
// for HARD cells, the Firecracker/KVM host substrate (the SPACE cage
// layer) — invoked, never linked.
//
// A cell is born clean from a read-only verified image, lives in RAM,
// and dies completely. This module owns: substrate probing, staging
// lifecycle (image / scratch / egress socket paths / lease marker), the
// SOFT runner, and the HARD dispatcher.
//
// SOFT on this implementation = Linux user+mount+pid+net namespaces via
// unshare(1), with the payload CHROOTED into a minimal root assembled
// in the namespace: the runtime directories (/usr, /lib, /lib64, /bin,
// /sbin) bind-mounted read-only, the verified image bind-mounted
// read-only at /image, a size-capped tmpfs scratch at /scratch, the
// egress socket bind-mounted at /cell/egress.sock, and the rootfs
// itself remounted read-only — so the identity store is not merely
// unwritable from a cell, it is UNREACHABLE (no path to it exists),
// and every write outside scratch fails. (Phase 4, FIX 2: the pre-fix
// form ran without a chroot and a pass/Tier-0 program read the
// daemon's identity.json and wrote into the vault store; the red
// team's escape payload is a permanent battery case.) Named limits
// of the SOFT form (stated, not hidden): the cell shares the host
// kernel (syscall surface is shared — SOFT is confinement, not a
// machine boundary); /proc inside is an empty tmpfs, because a fresh
// proc mount is refused by some host kernels in a user namespace and
// binding the host /proc would hand the cell /proc/<pid>/root — a
// door straight back to the host filesystem. HARD is a machine
// boundary and the activation record always names which class ran.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function which(bin) {
  for (const d of (process.env.PATH || '').split(':')) {
    if (!d) continue;
    const p = path.join(d, bin);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  return null;
}

// Probe both substrates. HARD requires /dev/kvm AND a firecracker
// binary; anything missing is named in `missing` — a host that cannot
// serve the required class refuses activations, it never silently
// downgrades (SPEC §2.2).
export function probeCells() {
  const missing = [];
  if (!fs.existsSync('/dev/kvm')) missing.push('/dev/kvm absent (no KVM on this host)');
  const fc = which('firecracker');
  if (!fc) missing.push('firecracker binary not on PATH');
  const hard = { available: missing.length === 0, missing, binary: fc };
  let soft = { available: false, kind: null, binary: null };
  const bw = which('bwrap');
  if (bw) {
    soft = { available: true, kind: 'bwrap', binary: bw };
  } else {
    try {
      const t = spawnSync('unshare', ['-Urmpfn', 'true'], { timeout: 5000 });
      if (t.status === 0) soft = { available: true, kind: 'unshare', binary: which('unshare') };
    } catch {}
  }
  return { hard, soft };
}

// ---------------------------------------------------------------------------
// Staging lifecycle. One directory per activation under the daemon's
// cells root: image/ (payload, made read-only in the cell), scratch/
// (tmpfs mount point — RAM only), egress.sock (the one channel out),
// marker.json (lease + heartbeat + child pid, for the orphan reaper).
// ---------------------------------------------------------------------------

export function createStaging(cellsRoot, activationId) {
  const root = path.join(cellsRoot, activationId);
  const image = path.join(root, 'image');
  const scratch = path.join(root, 'scratch');
  const rootfs = path.join(root, 'rootfs');
  fs.mkdirSync(image, { recursive: true, mode: 0o700 });
  fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
  fs.mkdirSync(rootfs, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(root, 0o700); } catch {}
  return {
    root, image, scratch, rootfs,
    egressSock: path.join(root, 'egress.sock'),
    markerPath: path.join(root, 'marker.json'),
  };
}

export function stagePayload(staging, relpath, bytes, { executable = false } = {}) {
  const segs = relpath.split('/');
  if (segs.includes('..') || path.isAbsolute(relpath)) throw new Error(`stage: bad relpath ${relpath}`);
  const dest = path.join(staging.image, relpath);
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  fs.writeFileSync(dest, bytes, { mode: executable ? 0o700 : 0o600 });
  return dest;
}

export function writeMarker(staging, marker) {
  const tmp = `${staging.markerPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(marker, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, staging.markerPath);
}

export function readMarker(markerPath) {
  try { return JSON.parse(fs.readFileSync(markerPath, 'utf8')); } catch { return null; }
}

export function listCellMarkers(cellsRoot) {
  let names = [];
  try { names = fs.readdirSync(cellsRoot); } catch { return []; }
  const out = [];
  for (const name of names) {
    const markerPath = path.join(cellsRoot, name, 'marker.json');
    const marker = readMarker(markerPath);
    if (marker) out.push({ activationId: name, root: path.join(cellsRoot, name), markerPath, marker });
  }
  return out;
}

// Destroy = the staging tree is gone and we can prove it. Returns true
// only when the path no longer exists afterwards (SPEC §2.4 step 7: a
// destroy that cannot be confirmed is an incident, not a footnote).
export function destroyStaging(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  return !fs.existsSync(root);
}

// ---------------------------------------------------------------------------
// SOFT runner (unshare form). The payload runs as argv[0] inside the
// namespaces; its environment is minimal and names the cell's three
// places: SA_IMAGE (read-only), SA_SCRATCH (RAM, cwd), SA_EGRESS (the
// socket that is its only way out).
// ---------------------------------------------------------------------------

function shQuote(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

export function runSoftCell({ staging, argv, env = {}, scratchMb = 256, cpuSeconds = 60, wallMs = 300000, onStdout = null, onStderr = null }) {
  const rootfs = staging.rootfs;
  const q = shQuote;
  // Host paths under the image become cell paths under /image; the
  // runtime's own path stays valid because its directory is bound at
  // the same absolute location inside the rootfs.
  const toCell = (p) => {
    if (p === staging.image) return '/image';
    if (typeof p === 'string' && p.startsWith(staging.image + '/')) return `/image/${p.slice(staging.image.length + 1)}`;
    return p;
  };
  const cellArgv = argv.map(toCell);
  const stdBinds = ['usr', 'lib', 'lib64', 'bin', 'sbin'];
  const execDir = path.dirname(process.execPath);
  const extraBinds = stdBinds.some((d) => execDir === `/${d}` || execDir.startsWith(`/${d}/`)) ? [] : [execDir];
  const chrootBin = ['/usr/sbin/chroot', '/sbin/chroot', '/usr/bin/chroot'].find((p) => fs.existsSync(p)) || 'chroot';
  const cellEnv = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: '/scratch',
    TMPDIR: '/tmp',
    SA_IMAGE: '/image',
    SA_SCRATCH: '/scratch',
    SA_EGRESS: '/cell/egress.sock',
    ...env,
  };
  const envArgs = Object.entries(cellEnv).map(([k, v]) => `${k}=${v}`);
  // The mount sequence either completes in full or the cell does not
  // boot: confinement that fails partway is a boot failure, never a
  // quieter cell. Every step is chained with &&.
  const inner = [
    'mount --make-rprivate / 2>/dev/null',
    `mount -t tmpfs tmpfs ${q(rootfs)}`,
    `mkdir -p ${['usr', 'lib', 'lib64', 'bin', 'sbin', 'etc', 'dev', 'proc', 'image', 'scratch', 'cell', 'tmp'].map((d) => q(`${rootfs}/${d}`)).join(' ')}`,
    ...stdBinds.map((d) => `if [ -d /${d} ]; then mount --bind /${d} ${q(`${rootfs}/${d}`)} && mount -o remount,ro,bind ${q(`${rootfs}/${d}`)}; else true; fi`),
    ...extraBinds.map((d) => `mkdir -p ${q(rootfs + d)} && mount --bind ${q(d)} ${q(rootfs + d)} && mount -o remount,ro,bind ${q(rootfs + d)}`),
    // The dynamic loader reads its cache from /etc — the ONLY host
    // /etc file the cell ever sees (copied, not bound).
    `(cp /etc/ld.so.cache ${q(`${rootfs}/etc/ld.so.cache`)} 2>/dev/null || true)`,
    `mount -t tmpfs tmpfs ${q(`${rootfs}/dev`)}`,
    ...['null', 'zero', 'full', 'random', 'urandom', 'tty'].map((dv) => `touch ${q(`${rootfs}/dev/${dv}`)} && mount --bind /dev/${dv} ${q(`${rootfs}/dev/${dv}`)}`),
    `mount -t tmpfs tmpfs ${q(`${rootfs}/proc`)}`,
    `mount --bind ${q(staging.image)} ${q(`${rootfs}/image`)}`,
    `mount -o remount,ro,bind ${q(`${rootfs}/image`)}`,
    `mount -t tmpfs -o size=${Math.max(8, scratchMb)}M,mode=0700 tmpfs ${q(`${rootfs}/scratch`)}`,
    `mount -t tmpfs -o size=16M tmpfs ${q(`${rootfs}/tmp`)}`,
    `touch ${q(`${rootfs}/cell/egress.sock`)}`,
    `mount --bind ${q(staging.egressSock)} ${q(`${rootfs}/cell/egress.sock`)}`,
    // Last: the rootfs itself goes read-only. Scratch/tmp/dev/proc are
    // separate mounts underneath and stay as they were made; every
    // other path in the cell now refuses writes with EROFS.
    `mount -o remount,ro,bind ${q(rootfs)}`,
    `cd ${q(`${rootfs}/scratch`)}`,
    `ulimit -t ${Math.max(1, Math.ceil(cpuSeconds))}`,
    `ulimit -f ${Math.max(1024, scratchMb * 1024)}`,
    'exec "$@"',
  ].join(' && ');
  const fullArgv = [chrootBin, rootfs, '/usr/bin/env', '-i', ...envArgs, ...cellArgv];
  const child = spawn('unshare', ['-Urmpfn', 'bash', '-c', inner, 'sa-cell', ...fullArgv],
    { env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let killedBy = null;
  let stdoutTail = Buffer.alloc(0);
  let stderrTail = Buffer.alloc(0);
  const tail = (buf, chunk) => Buffer.concat([buf, chunk]).subarray(-65536);
  if (child.stdout) child.stdout.on('data', (c) => { stdoutTail = tail(stdoutTail, c); if (onStdout) onStdout(c); });
  if (child.stderr) child.stderr.on('data', (c) => { stderrTail = tail(stderrTail, c); if (onStderr) onStderr(c); });
  const timer = setTimeout(() => { killedBy = 'wall-clock'; killTree(); }, wallMs);
  function killTree() {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
  }
  const done = new Promise((resolve) => {
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exit: null, signal: null, killedBy: killedBy || `spawn-error: ${err.message}`, stdout: stdoutTail, stderr: stderrTail });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ exit: code, signal, killedBy, stdout: stdoutTail, stderr: stderrTail });
    });
  });
  return {
    pid: child.pid,
    done,
    kill(reason = 'daemon') { if (!killedBy) killedBy = reason; killTree(); },
  };
}

// HARD dispatcher — the same interface, gated on the real substrate.
// The Firecracker host runner is a separate component on the KVM/SPACE
// host (SPEC §2.9); where the substrate is absent this refuses with the
// missing pieces named. It never pretends to have run.
export function runHardCell() {
  const { hard } = probeCells();
  throw new Error(`hard-cell-unavailable: ${hard.missing.join('; ')}`);
}
