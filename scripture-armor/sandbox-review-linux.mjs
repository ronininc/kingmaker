// sandbox-review-linux.mjs — Scripture Armor's Linux review lane, shipped
// in the product behind the stock sandbox-review interface (owner ruling
// 2026-11-05: the Linux sandbox lane sits in the product). Derived from the
// Hermes audit adapter, proven end-to-end against this same contract.
//
// Stock interface (scripture-armor/sandbox-review.mjs):
//   reviewUploadedFile(bytes, name, {readRoots = [], protectedRoots = []})
//     -> Promise<result> where result.schema === 'scripture-armor.file-review/1',
//        result.contentSha256 === sha256(bytes), result.commandAuthority === false,
//        result.targetExecuted === false; throws on any guard/sandbox failure.
// The repository job (repository-review.mjs) consumes exactly this through
// its `analyze` seam, so this module is a drop-in replacement for the
// `analyze` wiring in run-hermes-audit-seam.mjs / dashboard.mjs:
//
//   import {reviewUploadedFile} from './sandbox-review-linux.mjs';
//   analyze: (bytes, name) => reviewUploadedFile(bytes, name, {readRoots, protectedRoots})
//
// The stock module throws 'An unprivileged OS review sandbox is
// unavailable; review was not run.' on every non-darwin platform. This
// adapter implements the same contract on Linux with, in spawn order:
//   unshare(1) mount + network + PID namespaces (private propagation,
//   --kill-child), a pivot_root into a tmpfs that bind-mounts ONLY /usr
//   (ro), the Armor code root (ro), its sibling lib/ + package.json when
//   present (ro), each readRoot (ro, at /roots/<n>), the single target
//   file (ro, at /work/upload) and a writable scratch dir (/work/scratch);
//   a fresh empty network namespace (no interfaces, loopback down);
//   rlimits via prlimit (CPU 20 s, file size 16 MiB, 256 fds, no core);
//   privilege drop via setpriv to uid/gid 65534 (nobody) with inherited
//   capabilities cleared and no_new_privs; a scrubbed environment; the
//   same 25 s wall-clock timeout, 1 MiB stdout cap, exit-code and
//   result-schema validation, and workspace destruction on return as
//   the macOS path. See HERMES-REPORT.md for the honest isolation delta
//   vs Seatbelt (notably: no seccomp/syscall filtering — the stock
//   Seatbelt profile allows syscall* too — and no per-path deny rules
//   inside the visible tree; what is not bound in does not exist).
//
// Extra options beyond the stock signature (all optional, ignored by
// stock callers): codeRoot (Armor tree containing review-worker.mjs;
// default: $SCRIPTURE_ARMOR_CODE_ROOT, else this module's own directory —
// the shipped scripture-armor tree), timeoutMs (default 25000, same as stock).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INNER = path.join(HERE, 'linux-review-inner.sh');
const DROP_UID = 65534, DROP_GID = 65534; // nobody:nogroup
const DEFAULT_CODE_ROOT = process.env.SCRIPTURE_ARMOR_CODE_ROOT || HERE;

const liveReviews = new Map();
function cleanupReviews() {
  for (const [pid, root] of liveReviews) { try { process.kill(-pid, 'SIGKILL'); } catch {} try { fs.rmSync(root, {recursive: true, force: true}); } catch {} }
}
function removeReviewHandlers() { process.removeListener('exit', cleanupReviews); process.removeListener('SIGTERM', onReviewTerm); process.removeListener('SIGINT', onReviewInterrupt); }
function endReviewHost(signal) { cleanupReviews(); removeReviewHandlers(); if (process.listenerCount(signal) === 0) process.kill(process.pid, signal); }
function onReviewTerm() { endReviewHost('SIGTERM'); }
function onReviewInterrupt() { endReviewHost('SIGINT'); }
function trackReview(pid, root) {
  if (!Number.isInteger(pid)) return;
  if (!liveReviews.size) { process.once('exit', cleanupReviews); process.on('SIGTERM', onReviewTerm); process.on('SIGINT', onReviewInterrupt); }
  liveReviews.set(pid, root);
}
function untrackReview(pid) { liveReviews.delete(pid); if (!liveReviews.size) removeReviewHandlers(); }

// Descriptive plan for one review — the Linux analogue of macReviewPolicy's
// Seatbelt profile text. Its sha256 is recorded in review-shield.json and in
// the returned isolation block, exactly like policySha256 on macOS.
export function linuxReviewPlan({node, codeRoot, root, readRoots = [], protectedRoots = [], binary = false}) {
  return {
    mechanism: 'linux-namespaces+pivot_root+setpriv+prlimit',
    namespaces: ['mount', 'network', 'pid'],
    network: 'fresh empty network namespace; no interfaces configured, loopback down',
    filesystem: {
      root: 'fresh tmpfs, pivot_root, old root detached',
      readOnlyBinds: ['/usr', codeRoot, ...readRoots],
      targetFile: 'single file bind-mounted read-only at /work/upload',
      writable: ['/work/scratch', '/tmp (empty tmpfs)', '/dev/{null,zero,full,random,urandom}'],
      notPresent: 'host home, protectedRoots, vault paths and every other host path are not mounted at all',
      protectedRootsDeniedByAbsence: protectedRoots,
    },
    process: {uid: DROP_UID, gid: DROP_GID, capabilities: 'none inherited', noNewPrivs: true,
      rlimits: {cpuSeconds: 20, fileSizeBytes: 16 * 1024 * 1024, openFiles: 256, coreBytes: 0, processes: 256},
      nodeHeap: '--max-old-space-size=192 --max-semi-space-size=8', priority: 19},
    syscallFiltering: false,
    binaryHelperExecutables: binary ? 'whole /usr is present read-only; execution is limited by no_new_privs + unprivileged uid, not by an executable allowlist' : undefined,
    node,
  };
}

// Run an arbitrary command inside the same sandbox construction the review
// worker runs in. Exported for the escape-probe proof (and for tests); the
// review path below uses it with the stock worker command.
export function runSandboxedCommand({root, codeRoot, readRoots = [], command, env, timeoutMs = 25000, stdoutCap = 1024 * 1024}) {
  const libDir = path.join(path.dirname(codeRoot), 'lib');
  const pkgJson = path.join(path.dirname(codeRoot), 'package.json');
  const innerArgs = [
    root, codeRoot,
    fs.existsSync(libDir) ? libDir : '-',
    fs.existsSync(pkgJson) ? pkgJson : '-',
    String(DROP_UID), String(DROP_GID), String(readRoots.length),
    ...readRoots, '--', ...command,
  ];
  // As root, mount/net/pid namespaces need no user namespace. Unprivileged
  // callers get a user namespace mapping them to the drop uid (then the
  // setpriv "drop" is to their own mapped uid). The root path is the one
  // exercised on this VM; see HERMES-REPORT.md.
  const unshareArgs = ['--mount', '--net', '--pid', '--fork', '--kill-child=SIGKILL', '--propagation', 'private'];
  if (process.getuid?.() !== 0) {
    unshareArgs.push('--user', `--map-users=${DROP_UID},${process.getuid()},1`, `--map-groups=${DROP_GID},${process.getgid()},1`);
  }
  unshareArgs.push('/bin/sh', INNER, ...innerArgs);
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '', settled = false;
    const child = spawn('/usr/bin/unshare', unshareArgs, {env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'], detached: true});
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); untrackReview(child.pid); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => { kill(); finish(Error('Sandbox review timed out; no clean verdict was issued.')); }, timeoutMs);
    trackReview(child.pid, root);
    child.on('error', () => finish(Error('OS sandbox could not start; review was not run.')));
    child.stdout.on('data', (chunk) => { stdout += chunk; if (stdout.length > stdoutCap) { kill(); finish(Error('Review output limit exceeded.')); } });
    child.stderr.on('data', (chunk) => { if (stderr.length < 16384) stderr += chunk; });
    child.on('close', (code) => finish(null, {code, stdout, stderr}));
    try { os.setPriority(child.pid, 19); } catch { kill(); finish(Error('Low-priority review could not start.')); }
  });
}

export async function reviewUploadedFile(bytes, name, {readRoots = [], protectedRoots = [], codeRoot = DEFAULT_CODE_ROOT, timeoutMs = 25000} = {}) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 16 * 1024 * 1024 || typeof name !== 'string' || name.length > 256 || /[\0\r\n]/.test(name)) throw Error('A single nonempty file up to 16 MiB is required.');
  if (process.platform !== 'linux' || !fs.existsSync('/usr/bin/unshare') || !fs.existsSync('/usr/bin/setpriv') || !fs.existsSync('/usr/bin/prlimit')) throw Error('An unprivileged OS review sandbox is unavailable; review was not run.');
  const node = fs.realpathSync(process.execPath);
  codeRoot = fs.realpathSync(codeRoot);
  if (!fs.existsSync(path.join(codeRoot, 'review-worker.mjs'))) throw Error('Armor review worker not found in code root; review was not run.');
  const {classifyBuffer} = await import(pathToFileURL(path.join(codeRoot, 'scan.mjs')));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'armor-review-')));
  fs.chmodSync(root, 0o711); // traverse-only; contents gated per-file below, tree destroyed on return
  const input = path.join(root, 'upload'), scratch = path.join(root, 'scratch');
  try {
    fs.mkdirSync(scratch, {mode: 0o777});
    // NOTE: unlike the macOS path (0400, owner-read), the input is 0444 and
    // scratch 0777. On this VM's overlayfs chown(2) returns EPERM even for
    // root, so ownership cannot be transferred to the drop uid; the
    // namespace boundary (0711 parent, random path, ≤25 s lifetime,
    // destroyed on return) is what gates host-side access. Recorded as an
    // isolation delta in HERMES-REPORT.md.
    fs.writeFileSync(input, bytes, {mode: 0o444, flag: 'wx'});
    fs.chmodSync(scratch, 0o777);
    const tools = readRoots.map((p) => fs.realpathSync(p));
    if (tools.some((p) => p === path.parse(p).root || p === os.homedir() || os.homedir().startsWith(p + path.sep) || p === os.tmpdir())) throw Error('Unsafe review runtime scope.');
    const reviewId = crypto.randomUUID();
    const plan = linuxReviewPlan({node, codeRoot, root, readRoots: tools, protectedRoots, binary: classifyBuffer(bytes.subarray(0, 16384), name) === 'binary'});
    const planSha256 = crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex');
    fs.writeFileSync(path.join(root, 'review-shield.json'), JSON.stringify({reviewId, planSha256, sandbox: 'linux-namespace', network: false, vault: false, ownerKeysCopied: false}), {mode: 0o400, flag: 'wx'});
    const env = {PATH: '/usr/bin:/bin', HOME: '/work/scratch', TMPDIR: '/work/scratch', LANG: 'en_US.UTF-8',
      _JAVA_OPTIONS: '-Xmx512m -XX:ActiveProcessorCount=1 -Djava.io.tmpdir=/work/scratch'};
    for (const key of ['SCRIPTURE_GHIDRA_HOME', 'JAVA_HOME']) {
      if (!process.env[key] || !tools.length) continue;
      try {
        const real = fs.realpathSync(process.env[key]);
        const idx = tools.indexOf(tools.find((t) => real === t || real.startsWith(t + path.sep)));
        if (idx >= 0) env[key] = '/roots/' + idx + real.slice(tools[idx].length);
      } catch {}
    }
    const {code, stdout} = await runSandboxedCommand({
      root, codeRoot, readRoots: tools, env, timeoutMs,
      command: [node, '--max-old-space-size=192', '--max-semi-space-size=8',
        path.join('/armor/scripture-armor', 'review-worker.mjs'), '/work/upload', '/work/scratch', path.basename(name)],
    });
    if (code !== 0) throw Error('OS sandbox review failed; no clean verdict was issued.');
    let result;
    try {
      result = JSON.parse(stdout);
      if (result.schema !== 'scripture-armor.file-review/1' || result.contentSha256 !== crypto.createHash('sha256').update(bytes).digest('hex') || result.commandAuthority !== false || result.targetExecuted !== false) throw Error();
    } catch { throw Error('Review returned an invalid result.'); }
    return {...result, sandbox: 'linux-namespace', isolation: {reviewId, planSha256, network: false, vault: false, ownerKeysCopied: false, workspaceDestroyedOnReturn: true, nextReview: 'fresh-workspace', originalFileRemoved: false}};
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
}
