// lib/external-storage.mjs — approved EXTERNAL storage (USB drives, external SSD/HDD, SD cards) through the SAME
// method, model and memory layout as internal storage (owner, 2026-11-16).
//
//   discover   read-only: macOS `mount`, `df -k`, `diskutil info -plist <mount>`; Linux /proc/mounts + `lsblk -J`;
//              Windows `Get-Volume | ConvertTo-Json` / `Get-CimInstance Win32_Volume | ConvertTo-Json` (parsers only,
//              tested on fixture text). Every external command passes READ_ONLY_COMMANDS first: nothing here can
//              format, partition, erase, mount, unmount or chmod a drive.
//   approve    only on an explicit user selection (confirm: true). Recorded in <state>/storage/drives.json with the
//              drive's STABLE id (macOS VolumeUUID, else DiskUUID; Linux filesystem UUID; Windows volume GUID, else
//              serial) + label + the roles it may hold. A volume with no stable id is refused, never guessed.
//   layout     <drive>/Kingmaker/<install id>/ mirrors <state>: abilities/methods (user), fleet/abilities/methods
//              (fleet), brain-library/methods (the curated corpus cache), models, memory — each with its own index,
//              never mixed. owner.json pins the root to this install; a root owned by another install is refused and
//              other installs' roots are never read.
//   resolve    each start: approved drives are matched to mounted volumes by stable id only (a changed mount path is
//              followed; a same-named volume with a different or missing id is reported and NOT used). A connected
//              drive's stores become extra layers in the same order (user > fleet > library > built-in); a missing,
//              read-only or foreign drive is reported per resource and nothing is substituted (no cloud fallback, no
//              silent duplicate library on the internal disk).
//   save       safeWriteFile: capacity + filesystem-limit checks → journal → temp → fsync → read-back sha256 → rename
//              → fsync dir → read-back sha256 → journal cleared. recoverDrive() on the next start rolls back an
//              interrupted write (removes the temp; the previous final file, if any, is untouched).
//              Durability on macOS: Node's fsync (libuv uv__fs_fsync) already issues fcntl(F_FULLFSYNC), falling back
//              to F_BARRIERFSYNC, then fsync, when a filesystem refuses it — measured 2026-11-16 on this Mac: Node
//              fsyncSync ≈ 3.4 ms per call vs Python os.fsync 0.1 ms and fcntl F_FULLFSYNC 4.4 ms. No native code.
//   routed     user-methods (writeMethod/promoteDraft), fleet-abilities (acceptAbilityRelease/applyRevocations),
//              library-cache (the hunt), iteration (iterateMethod into the store a method came from), memory (the
//              engine's SOLOMON_DATA_DIR, engineMemoryLocation), files (kingmakerHome/homeFolder, filesLocation).
//   eject      ejectReadiness(): open handles (lsof, read-only), in-flight writes in this process, unfinished journal
//              entries. Kingmaker never unmounts or force-ejects.
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  accessSync, closeSync, constants as FS, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync,
  renameSync, rmSync, statSync, statfsSync, symlinkSync, unlinkSync, writeSync,
} from 'node:fs';
import { open, readFile, rename, statfs, unlink, lstat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { installationId } from './sharing.mjs';

export const STORAGE_SCHEMA = 'kingmaker.storage-drives/1';
export const OWNER_SCHEMA = 'kingmaker.storage-owner/1';
export const DRIVE_ROOT_DIR = 'Kingmaker';
export const JOURNAL_DIR = '.kingmaker-journal';
const TMP_MARK = '.km-tmp-';

/** The roles a drive may hold, and where each lives under the drive root (the same relative layout as <state>). */
export const ROLES = Object.freeze({
  'user-methods': { rel: ['abilities', 'methods'], layer: 'user', what: 'your own methods' },
  'fleet-abilities': { rel: ['fleet', 'abilities', 'methods'], layer: 'fleet', what: 'owner-approved fleet abilities' },
  'library-cache': { rel: ['brain-library', 'methods'], layer: 'library', what: 'the curated library cache (membership corpus)' },
  models: { rel: ['models'], layer: null, what: 'local model files (documented OLLAMA_MODELS config only)' },
  // memory: the engine's data folder (SOLOMON_DATA_DIR → <drive>/…/memory), whose sqlite/solomon.db holds the
  // engine's governed memory (MemPalace). Knowledge, keys and the vault stay on this Mac (see engineMemoryLocation).
  memory: { rel: ['memory'], layer: null, what: 'memory (the engine\'s MemPalace data folder)' },
  // files: Kingmaker's Files folder (what KINGMAKER_HOME / homeFolder point at: documents, pictures, reports…).
  files: { rel: ['files'], layer: null, what: 'your files (Kingmaker\'s Files folder)' },
});

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

// ───────────────────────────── read-only command guard ─────────────────────────────
/** The only external commands storage code may run. Anything else (erase, partition, mount, chmod…) throws. */
export function assertReadOnlyCommand(cmd, args = []) {
  const a = args.map(String);
  const ok = (cmd === 'diskutil' && (a[0] === 'info' || a[0] === 'list'))
    || (cmd === 'df' && a.every((x) => /^-[kPl]+$/.test(x) || x.startsWith('/')))
    || (cmd === 'mount' && a.length === 0)
    || (cmd === 'lsblk' && a.includes('-J'))
    || (cmd === 'lsof');
  if (!ok) throw new Error(`STORAGE_COMMAND_REFUSED: "${cmd} ${a.join(' ')}" is not a read-only discovery command`);
}
export function runReadOnly(cmd, args = [], { timeout = 8000 } = {}) {
  assertReadOnlyCommand(cmd, args);
  try { return execFileSync(cmd, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 << 20 }); }
  // lsof exits 1 when nothing is open; a command that ran and printed something keeps its output.
  catch (e) { if (typeof e.stdout === 'string' && (e.stdout || (cmd === 'lsof' && e.status === 1))) return e.stdout; throw e; }
}

// ───────────────────────────── parsers ─────────────────────────────
const XML_ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = (s) => String(s).replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : XML_ENT[e.toLowerCase()]));

/** A minimal XML property-list parser (dict, array, string, integer, real, true, false, date, data). */
export function parsePlist(xml) {
  const body = String(xml).replace(/<\?[\s\S]*?\?>/g, '').replace(/<![\s\S]*?>/g, '');
  const toks = [];
  const re = /<(\/?)([A-Za-z]+)[^>]*?(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(body))) {
    if (m[4] !== undefined) { if (m[4].trim()) toks.push({ t: 'text', v: m[4] }); else toks.push({ t: 'ws', v: m[4] }); }
    else toks.push({ t: m[1] ? 'close' : m[3] ? 'empty' : 'open', n: m[2] });
  }
  let i = 0;
  const next = () => { while (toks[i]?.t === 'ws') i++; return toks[i++]; };
  const textUntilClose = (name) => { let s = ''; while (toks[i] && toks[i].t !== 'close') s += toks[i++].v ?? ''; const c = toks[i++]; if (c?.n !== name) throw new Error(`plist: expected </${name}>`); return unxml(s); };
  function value(tok = next()) {
    if (!tok) throw new Error('plist: unexpected end');
    if (tok.t === 'empty') return ({ true: true, false: false, string: '', dict: {}, array: [] })[tok.n] ?? null;
    if (tok.t !== 'open') throw new Error(`plist: unexpected ${tok.t} ${tok.n ?? ''}`);
    switch (tok.n) {
      case 'plist': { const v = value(); next(); return v; }
      case 'dict': {
        const o = {};
        for (;;) {
          const k = next();
          if (k.t === 'close' && k.n === 'dict') return o;
          if (k.t !== 'open' || k.n !== 'key') throw new Error('plist: expected <key>');
          const key = textUntilClose('key');
          o[key] = value();
        }
      }
      case 'array': { const a = []; for (;;) { const t = next(); if (t.t === 'close' && t.n === 'array') return a; a.push(value(t)); } }
      case 'integer': return Number(textUntilClose('integer').trim());
      case 'real': return Number(textUntilClose('real').trim());
      case 'string': case 'date': return textUntilClose(tok.n);
      case 'data': return textUntilClose('data').replace(/\s+/g, '');
      default: return textUntilClose(tok.n);
    }
  }
  return value();
}

/** macOS `mount` output → [{ device, mountPoint, fsType, options, readOnly }]. */
export function parseMacMount(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const m = /^(.+?) on (.+) \(([^)]*)\)\s*$/.exec(line.trim());
    if (!m) continue;
    const opts = m[3].split(',').map((s) => s.trim()).filter(Boolean);
    out.push({ device: m[1], mountPoint: m[2], fsType: opts[0] ?? null, options: opts.slice(1), readOnly: opts.includes('read-only') });
  }
  return out;
}

/** `df -k` (macOS or Linux) → [{ device, totalBytes, usedBytes, availableBytes, mountPoint }]. Mount points may contain spaces. */
export function parseDfK(text) {
  const out = [];
  for (const line of String(text).split('\n').slice(1)) {
    // device  1K-blocks  used  avail  capacity  [iused ifree %iused]  mountpoint
    const m = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+%|-)\s+(?:(?:\d+|-)\s+(?:\d+|-)\s+(?:\d+%|-)\s+)?(\/.*)$/.exec(line.trim());
    if (!m) continue;
    out.push({ device: m[1], totalBytes: Number(m[2]) * 1024, usedBytes: Number(m[3]) * 1024, availableBytes: Number(m[4]) * 1024, mountPoint: m[6] });
  }
  return out;
}

const unoctal = (s) => String(s).replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
/** Linux /proc/mounts → [{ device, mountPoint, fsType, options, readOnly }]. Octal escapes (\040 = space) decoded. */
export function parseProcMounts(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 4) continue;
    const options = f[3].split(',');
    out.push({ device: unoctal(f[0]), mountPoint: unoctal(f[1]), fsType: f[2], options, readOnly: options.includes('ro') });
  }
  return out;
}

const bool = (v) => v === true || v === 1 || v === '1' || v === 'true';
/** `lsblk -J -b -o NAME,PATH,TYPE,FSTYPE,UUID,LABEL,RM,RO,HOTPLUG,TRAN,SIZE,FSAVAIL,FSSIZE,MOUNTPOINTS` → flat list,
 *  children inheriting their disk's removable/hotplug/transport and noting an encrypted (crypt/LUKS) ancestor. */
export function parseLsblkJson(text) {
  const doc = typeof text === 'string' ? JSON.parse(text) : text;
  const out = [];
  const walk = (dev, parent) => {
    const mps = (dev.mountpoints ?? (dev.mountpoint !== undefined ? [dev.mountpoint] : [])).filter(Boolean);
    const rec = {
      name: dev.name, path: dev.path ?? (dev.name ? `/dev/${dev.name}` : null), type: dev.type ?? null, fsType: dev.fstype ?? null,
      uuid: dev.uuid ?? null, label: dev.label ?? null, size: dev.size != null ? Number(dev.size) : null,
      fsAvail: dev.fsavail != null ? Number(dev.fsavail) : null, fsSize: dev.fssize != null ? Number(dev.fssize) : null,
      removable: bool(dev.rm) || bool(dev.hotplug) || Boolean(parent?.removable), readOnly: bool(dev.ro) || Boolean(parent?.readOnly && dev.ro == null),
      transport: dev.tran ?? parent?.transport ?? null, mountPoints: mps,
      encrypted: dev.type === 'crypt' || dev.fstype === 'crypto_LUKS' || Boolean(parent?.encrypted),
    };
    out.push(rec);
    for (const c of dev.children ?? []) walk(c, rec);
  };
  for (const d of doc.blockdevices ?? []) walk(d, null);
  return out;
}

/** Windows `Get-Volume | ConvertTo-Json` or `Get-CimInstance Win32_Volume | ConvertTo-Json` → volume records. */
export function parseWindowsVolumes(text) {
  let doc = typeof text === 'string' ? JSON.parse(text.replace(/^﻿/, '')) : text;
  if (!Array.isArray(doc)) doc = [doc];
  const DT = { 2: 'Removable', 3: 'Fixed', 4: 'Network', 5: 'CD-ROM', 6: 'RAM' };
  return doc.filter(Boolean).map((v) => {
    const uid = String(v.UniqueId ?? v.DeviceID ?? v.Path ?? '');
    const guid = /Volume\{([0-9a-fA-F-]{36})\}/.exec(uid)?.[1]?.toLowerCase() ?? null;
    const serial = v.SerialNumber != null ? (Number(v.SerialNumber) >>> 0).toString(16).toUpperCase().padStart(8, '0') : null;
    const letter = v.DriveLetter ? String(v.DriveLetter).replace(/:?$/, ':') : null;
    const driveType = typeof v.DriveType === 'number' ? DT[v.DriveType] ?? String(v.DriveType) : v.DriveType ?? null;
    const fs = String(v.FileSystem ?? v.FileSystemType ?? '').trim() || null;
    return {
      platform: 'win32', name: v.FileSystemLabel ?? v.Label ?? letter ?? null, mountPoint: letter ? `${letter}\\` : (v.Name ?? null), device: uid || null,
      fsType: fs ? fs.toLowerCase().replace(/^fat$/, 'fat16') : null, fsName: fs,
      totalBytes: v.Size ?? v.Capacity ?? null, availableBytes: v.SizeRemaining ?? v.FreeSpace ?? null,
      readOnly: null, removable: driveType === 'Removable', internal: driveType === 'Fixed' ? null : false,
      encrypted: null, stableId: guid ? { kind: 'win-volume-guid', value: guid } : serial ? { kind: 'win-volume-serial', value: serial } : null,
      bus: null, driveType,
    };
  });
}

/** `lsof -F pcn +f -- <mount>` → [{ pid, command, name }]. */
export function parseLsofF(text) {
  const out = []; let pid = null, cmd = null;
  for (const line of String(text).split('\n')) {
    if (!line) continue;
    const k = line[0], v = line.slice(1);
    if (k === 'p') { pid = Number(v); cmd = null; } else if (k === 'c') cmd = v; else if (k === 'n') out.push({ pid, command: cmd, name: v });
  }
  return out;
}

// ───────────────────────────── filesystem capabilities ─────────────────────────────
const MAX = Number.MAX_SAFE_INTEGER;
const FAT32_MAX_FILE = 4 * 2 ** 30 - 1;
/** Declared capabilities of a filesystem type (what Kingmaker relies on; the probe at approval measures the rest). */
export function fsCapabilities(fsType, fsName = '') {
  const t = String(fsType ?? '').toLowerCase(), n = String(fsName ?? '').toLowerCase();
  const cs = /case-sensitive/.test(n) ? true : null;
  const base = { fsType: t || null, compatible: true, caseSensitive: null, symlinks: null, maxFileBytes: MAX, xattrs: null, journaling: null, posixPermissions: null, notes: [] };
  if (['msdos', 'vfat', 'fat32', 'fat16', 'fat'].includes(t)) return { ...base, family: 'FAT', caseSensitive: false, symlinks: false, maxFileBytes: FAT32_MAX_FILE, xattrs: false, journaling: false, posixPermissions: false, notes: ['FAT32: no file of 4 GiB or more; no native symlinks (macOS emulates them as special files other systems do not follow); macOS stores extended attributes as ._ sidecar files; no journal (unplugging mid-write can damage the filesystem)'] };
  if (t === 'exfat') return { ...base, family: 'exFAT', caseSensitive: false, symlinks: false, xattrs: false, journaling: false, posixPermissions: false, notes: ['exFAT: no native symlinks (macOS emulates them as special files other systems do not follow), no POSIX permissions, no journal (unplugging mid-write can damage the filesystem)'] };
  if (t === 'apfs') return { ...base, family: 'APFS', caseSensitive: cs ?? false, symlinks: true, xattrs: true, journaling: 'copy-on-write metadata', posixPermissions: true };
  if (t === 'hfs') return { ...base, family: 'HFS+', caseSensitive: cs ?? false, symlinks: true, xattrs: true, journaling: /journaled/.test(n) ? true : null, posixPermissions: true };
  if (['ntfs', 'fuseblk', 'ntfs3'].includes(t)) return { ...base, family: 'NTFS', caseSensitive: false, symlinks: false, maxFileBytes: 16 * 2 ** 40, xattrs: false, journaling: true, posixPermissions: false, notes: ['NTFS: macOS mounts it read-only without a third-party driver; Kingmaker uses no reparse points'] };
  if (['ext4', 'ext3', 'xfs', 'btrfs', 'f2fs'].includes(t)) return { ...base, family: t, caseSensitive: true, symlinks: true, maxFileBytes: t === 'ext3' ? 2 * 2 ** 40 : 16 * 2 ** 40, xattrs: true, journaling: t !== 'f2fs', posixPermissions: true };
  return { ...base, compatible: false, notes: [`filesystem "${t || 'unknown'}" is not one Kingmaker knows the limits of — not offered`] };
}

const SYSTEM_MOUNTS = /^(\/|\/System\/Volumes\/.*|\/private\/var\/vm|\/dev|\/proc|\/sys|\/run|\/boot(\/.*)?|\/snap\/.*|\/var\/lib\/.*|\/Library\/Developer\/.*)$/;

/** One macOS volume from `diskutil info -plist` (+ the matching df and mount rows). */
export function macVolume(info, { df = null, mount = null } = {}) {
  const fsType = String(info.FilesystemType ?? mount?.fsType ?? '').toLowerCase() || null;
  const fsName = info.FilesystemName ?? info.FilesystemUserVisibleName ?? fsType;
  const stableId = info.VolumeUUID ? { kind: 'mac-volume-uuid', value: String(info.VolumeUUID).toUpperCase() }
    : info.DiskUUID ? { kind: 'mac-disk-uuid', value: String(info.DiskUUID).toUpperCase() } : null;
  // A disk image can be encrypted at the IMAGE layer (hdiutil -encryption) while its APFS volume reports Encryption:false
  // (measured 2026-11-16 on an AES-128 APFS image). diskutil cannot see that layer, so for a disk image "false" is
  // reported as unknown (null) rather than as "not encrypted".
  const apfsSays = info.Encryption === true || info.FileVault === true ? true : (info.Encryption === false || info.FileVault === false) ? false : null;
  const encrypted = apfsSays === false && info.BusProtocol === 'Disk Image' ? null : apfsSays;
  return {
    platform: 'darwin', name: info.VolumeName || info.MediaName || null, mountPoint: info.MountPoint ?? mount?.mountPoint ?? null,
    device: info.DeviceNode ?? mount?.device ?? null, fsType, fsName,
    totalBytes: df?.totalBytes ?? info.TotalSize ?? info.Size ?? null,
    availableBytes: df?.availableBytes ?? (info.APFSContainerFree || info.FreeSpace || null),
    readOnly: Boolean(mount?.readOnly) || info.WritableVolume === false,
    removable: Boolean(info.Removable || info.RemovableMedia || info.Ejectable),
    internal: info.Internal === true, encrypted, stableId, bus: info.BusProtocol ?? null,
  };
}

/** Annotate a volume with capabilities and whether it may be offered for approval (and why not). */
export function describeVolume(v) {
  const capabilities = fsCapabilities(v.fsType, v.fsName);
  const why = [];
  if (!v.mountPoint) why.push('not mounted');
  else if (SYSTEM_MOUNTS.test(v.mountPoint)) why.push('a system volume');
  if (v.internal === true) why.push('an internal disk (only external storage is offered)');
  if (!capabilities.compatible) why.push(capabilities.notes[0]);
  if (!v.stableId) why.push('no stable identifier is available — Kingmaker refuses rather than recognize it by name');
  return { ...v, capabilities, approvable: why.length === 0, notApprovable: why };
}

// ───────────────────────────── discovery ─────────────────────────────
/** macOS: `mount` + `df -k` + `diskutil info -plist` per candidate (under /Volumes, plus `extraMounts`). Read-only. */
/** KINGMAKER_STORAGE_MOUNTS: extra mount points (':'-separated) to consider besides /Volumes — e.g. a test image. */
const envMounts = (env = process.env) => String(env.KINGMAKER_STORAGE_MOUNTS ?? '').split(':').map((s) => s.trim()).filter(Boolean);
export function discoverMac({ run = runReadOnly, extraMounts = [], env = process.env } = {}) {
  extraMounts = [...extraMounts, ...envMounts(env)];
  const mounts = parseMacMount(run('mount', []));
  const df = parseDfK(run('df', ['-k']));
  const extra = new Set(extraMounts.map((p) => resolve(p)));
  const cands = mounts.filter((m) => (m.mountPoint.startsWith('/Volumes/') || extra.has(m.mountPoint) || [...extra].some((e) => realpathOr(e) === m.mountPoint)));
  return cands.map((m) => {
    let info = {};
    try { info = parsePlist(run('diskutil', ['info', '-plist', m.mountPoint])) ?? {}; } catch { info = {}; }
    return describeVolume(macVolume(info, { df: df.find((d) => d.mountPoint === m.mountPoint) ?? null, mount: m }));
  });
}
function realpathOr(p) { try { return realpathSync(p); } catch { return p; } }

/** Linux: /proc/mounts + `lsblk -J`. Exported for fixtures; real hardware is NOT tested here. */
export function linuxVolumes({ procMounts, lsblk }) {
  const mounts = parseProcMounts(procMounts), blocks = parseLsblkJson(lsblk);
  const out = [];
  for (const m of mounts) {
    const b = blocks.find((x) => x.mountPoints.includes(m.mountPoint)) ?? blocks.find((x) => x.path === m.device);
    if (!b) continue;
    out.push(describeVolume({
      platform: 'linux', name: b.label ?? basename(m.mountPoint), mountPoint: m.mountPoint, device: b.path, fsType: b.fsType ?? m.fsType, fsName: b.fsType ?? m.fsType,
      totalBytes: b.fsSize ?? b.size, availableBytes: b.fsAvail, readOnly: m.readOnly || b.readOnly, removable: b.removable,
      internal: !b.removable && !['usb', 'mmc', 'sd'].includes(b.transport) ? true : false, encrypted: b.encrypted,
      stableId: b.uuid ? { kind: 'linux-fs-uuid', value: String(b.uuid).toLowerCase() } : null, bus: b.transport,
    }));
  }
  return out;
}
export function discoverLinux({ run = runReadOnly, readProcMounts = () => readFileSync('/proc/mounts', 'utf8') } = {}) {
  return linuxVolumes({ procMounts: readProcMounts(), lsblk: run('lsblk', ['-J', '-b', '-o', 'NAME,PATH,TYPE,FSTYPE,UUID,LABEL,RM,RO,HOTPLUG,TRAN,SIZE,FSAVAIL,FSSIZE,MOUNTPOINTS']) });
}
/** Windows: give it the JSON of `Get-Volume | ConvertTo-Json` (fixture-tested only; no PowerShell is run here). */
export function windowsVolumes(json) { return parseWindowsVolumes(json).map(describeVolume); }

export function discoverVolumes({ platform = process.platform, ...opts } = {}) {
  if (platform === 'darwin') return discoverMac(opts);
  if (platform === 'linux') return discoverLinux(opts);
  return []; // Windows: no live discovery is wired; parseWindowsVolumes is fixture-tested only.
}

// ───────────────────────────── registry ─────────────────────────────
export const driveKey = (stableId) => (stableId?.kind && stableId?.value ? `${stableId.kind}:${stableId.value}` : null);
export const registryPath = (state) => join(state, 'storage', 'drives.json');
export function readRegistry(state) {
  try { const r = JSON.parse(readFileSync(registryPath(state), 'utf8')); if (r?.schema === STORAGE_SCHEMA && Array.isArray(r.drives)) return r; } catch { /* none */ }
  return { schema: STORAGE_SCHEMA, drives: [] };
}
function writeRegistry(state, reg) {
  const dir = join(state, 'storage'); mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSyncAtomic(registryPath(state), `${JSON.stringify(reg, null, 2)}\n`, 0o600);
}
function writeFileSyncAtomic(path, data, mode) {
  const tmp = `${path}${TMP_MARK}${process.pid}-${randomBytes(4).toString('hex')}`;
  const fd = openSync(tmp, 'wx', mode);
  try { writeSync(fd, Buffer.from(data)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
}
const thisInstall = (state) => installationId(state, () => `fi_${randomBytes(16).toString('hex')}`);
export const driveRootOf = (mountPoint, installId) => join(mountPoint, DRIVE_ROOT_DIR, installId);

function inside(root, p) { const r = relative(resolve(root), resolve(p)); return r === '' || (!r.startsWith(`..${sep}`) && r !== '..' && !isAbsolute(r)); }

/** Measure, inside our own root only, what the filesystem actually does (case folding, symlink creation). */
export function probeCapabilities(root) {
  const id = randomBytes(4).toString('hex'), a = join(root, `.km-probe-${id}`), link = join(root, `.km-probe-${id}-link`);
  const out = { caseSensitive: null, symlinks: null };
  try {
    writeFileSyncAtomic(a, 'probe', 0o600);
    out.caseSensitive = !existsSync(join(root, `.KM-PROBE-${id.toUpperCase()}`));
    try { symlinkSync(a, link); out.symlinks = true; } catch { out.symlinks = false; }
  } finally { for (const p of [link, a]) { try { unlinkSync(p); } catch { /* gone */ } } }
  return out;
}

/**
 * Record the user's approval of one volume for the given roles. Requires confirm: true (the user's own selection).
 * Creates <mount>/Kingmaker/<install id>/ with the role folders only; never formats, chmods or touches anything else.
 */
export function approveDrive({ state, volume, roles, confirm = false, now = () => new Date() }) {
  if (confirm !== true) throw new Error('STORAGE_APPROVAL_REQUIRED: a drive is used only after the user selects and approves it');
  const v = volume?.capabilities ? volume : describeVolume(volume ?? {});
  if (!v.stableId) throw new Error(`STORAGE_NO_STABLE_ID: "${v.name ?? v.mountPoint}" has no stable identifier — refused rather than guessed by name`);
  if (!v.approvable) throw new Error(`STORAGE_NOT_APPROVABLE: "${v.name}" is ${v.notApprovable.join('; ')}`);
  const want = [...new Set(roles ?? [])];
  if (!want.length) throw new Error('STORAGE_NO_ROLES: say which roles the drive may hold');
  for (const r of want) if (!ROLES[r]) throw new Error(`STORAGE_UNKNOWN_ROLE: "${r}" (known: ${Object.keys(ROLES).join(', ')})`);
  const reg = readRegistry(state), key = driveKey(v.stableId);
  for (const d of reg.drives) if (d.key !== key) for (const r of want) if (d.roles.includes(r)) throw new Error(`STORAGE_ROLE_TAKEN: "${r}" is already on drive "${d.label}" — remove it there first (one location per role, so writes never split)`);
  const installId = thisInstall(state);
  const root = driveRootOf(v.mountPoint, installId);
  const owner = readOwner(root);
  if (owner && owner.installId !== installId) throw new Error(`STORAGE_NOT_OWNED: ${root} belongs to another install — refused`);
  if (owner && owner.driveKey && owner.driveKey !== key) throw new Error(`STORAGE_ID_MISMATCH: ${root} was created on a different drive (${owner.driveKey}) — refused`);
  if (!owner) {
    if (v.readOnly) throw new Error(`STORAGE_READ_ONLY: "${v.name}" is mounted read-only and has no Kingmaker folder for this install — nothing was written`);
    mkdirSync(root, { recursive: true });
    writeFileSyncAtomic(join(root, 'owner.json'), `${JSON.stringify({ schema: OWNER_SCHEMA, installId, driveKey: key, createdAt: now().toISOString() }, null, 2)}\n`);
  }
  let probed = null;
  if (!v.readOnly) {
    for (const r of want) mkdirSync(join(root, ...ROLES[r].rel), { recursive: true });
    probed = probeCapabilities(root);
  }
  const prior = reg.drives.find((d) => d.key === key);
  const entry = {
    key, stableId: v.stableId, label: v.name, fsType: v.fsType, fsName: v.fsName, roles: [...new Set([...(prior?.roles ?? []), ...want])],
    installId, approvedAt: prior?.approvedAt ?? now().toISOString(), updatedAt: now().toISOString(), lastMount: v.mountPoint, lastSeenAt: now().toISOString(),
    capabilities: { ...v.capabilities, probed }, removable: v.removable, encrypted: v.encrypted,
  };
  reg.drives = [...reg.drives.filter((d) => d.key !== key), entry];
  writeRegistry(state, reg);
  return { ...entry, root };
}

/** Remove an approval (the registry entry only — the drive's data is never touched). */
export function forgetDrive({ state, key }) {
  const reg = readRegistry(state); const before = reg.drives.length;
  reg.drives = reg.drives.filter((d) => d.key !== key && d.label !== key);
  if (reg.drives.length !== before) writeRegistry(state, reg);
  return before - reg.drives.length;
}

function alive(pid) { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function readOwner(root) { try { return JSON.parse(readFileSync(join(root, 'owner.json'), 'utf8')); } catch { return null; } }
function writable(dir) { try { accessSync(dir, FS.W_OK); return true; } catch { return false; } }

/**
 * Match approved drives to mounted volumes (by stable id only) and say what each role can use right now.
 * `volumes` (already discovered) or `discover()` supplies the mounts; with no drives.json nothing is discovered.
 * → { configured, drives:[…], roles:{ role: { status, dir, writable, drive, reason } }, unavailable:[…], notes:[…], recovered:[…] }
 */
export function resolveStorage({ state, volumes = null, discover = discoverVolumes, recover = true, now = () => new Date() } = {}) {
  const reg = readRegistry(state);
  const res = { configured: reg.drives.length > 0, drives: [], roles: {}, unavailable: [], notes: [], recovered: [] };
  if (!res.configured) return res;
  let vols = volumes;
  if (!vols) { try { vols = discover(); } catch (e) { vols = []; res.notes.push(`volume discovery failed (${String(e.message).slice(0, 120)}) — every approved drive is treated as not connected`); } }
  let regChanged = false;
  for (const d of reg.drives) {
    const v = vols.find((x) => driveKey(x.stableId) === d.key);
    const rec = { key: d.key, label: d.label, roles: d.roles, status: 'missing', mountPoint: null, root: null, reason: null, availableBytes: null, capabilities: d.capabilities };
    for (const s of vols.filter((x) => x !== v && x.name && x.name === d.label)) {
      res.notes.push(s.stableId
        ? `a volume named "${s.name}" is mounted at ${s.mountPoint}, but its identifier (${driveKey(s.stableId)}) is not the approved drive's — not used`
        : `a volume named "${s.name}" is mounted at ${s.mountPoint}, but its identifier is unavailable — refused rather than guessed by name`);
    }
    if (!v) {
      rec.reason = `drive "${d.label}" is not connected`;
    } else {
      rec.mountPoint = v.mountPoint; rec.availableBytes = v.availableBytes ?? null;
      const root = driveRootOf(v.mountPoint, d.installId); rec.root = root;
      const owner = readOwner(root);
      if (!owner) { rec.status = 'root-missing'; rec.reason = `drive "${d.label}" is connected at ${v.mountPoint} but its Kingmaker folder ${root} is missing — not recreated silently (approve the drive again to set it up)`; }
      else if (owner.installId !== d.installId || (owner.driveKey && owner.driveKey !== d.key)) { rec.status = 'not-owned'; rec.reason = `${root} belongs to another install or drive — refused`; }
      else {
        rec.status = v.readOnly || !writable(root) ? 'read-only' : 'connected';
        if (rec.status === 'read-only') rec.reason = `drive "${d.label}" is mounted read-only — its methods can be read, nothing can be saved to it`;
        if (d.lastMount !== v.mountPoint) { res.notes.push(`drive "${d.label}" recognized by its identifier at a new mount path ${v.mountPoint} (was ${d.lastMount})`); d.lastMount = v.mountPoint; regChanged = true; }
        d.lastSeenAt = now().toISOString(); regChanged = true;
        if (recover && rec.status === 'connected') { const r = recoverDrive(root); if (r.length) res.recovered.push(...r.map((x) => ({ drive: d.label, ...x }))); }
      }
    }
    res.drives.push(rec);
    for (const role of d.roles) {
      const usable = rec.status === 'connected' || rec.status === 'read-only';
      res.roles[role] = { drive: d.label, key: d.key, status: rec.status, dir: usable ? join(rec.root, ...ROLES[role].rel) : null, root: usable ? rec.root : null, writable: rec.status === 'connected', reason: rec.reason, capabilities: d.capabilities };
      if (!usable) res.unavailable.push({ role, what: ROLES[role].what, drive: d.label, status: rec.status, reason: rec.reason });
      else if (rec.status === 'read-only') res.unavailable.push({ role, what: `saving ${ROLES[role].what}`, drive: d.label, status: rec.status, reason: rec.reason });
    }
  }
  if (regChanged) { try { writeRegistry(state, reg); } catch { /* state read-only: the match still stands for this run */ } }
  return res;
}

/** The method store directories a resolved storage adds, per conductor layer (drive stores only; internal stays separate). */
export function storageLayers(resolved) {
  const out = { user: [], fleet: [], library: [] };
  for (const [role, r] of Object.entries(resolved?.roles ?? {})) if (r.dir && ROLES[role].layer) out[ROLES[role].layer].push(r.dir);
  return out;
}

/** Where a role's WRITES go now: the drive (connected), refused (assigned but unavailable/read-only), or internal. */
export function writeTarget(resolved, role, internalDir) {
  const r = resolved?.roles?.[role];
  if (!r) return { where: 'internal', dir: internalDir };
  if (r.status === 'connected') return { where: 'drive', dir: r.dir, root: r.root, drive: r.drive, maxFileBytes: r.capabilities?.maxFileBytes ?? MAX };
  return { where: 'refused', dir: null, drive: r.drive, reason: `${ROLES[role].what} are assigned to drive "${r.drive}": ${r.reason} — nothing was saved, and no second copy was made on this Mac` };
}

// ───────────────────────────── safe saves ─────────────────────────────
const pending = new Map(); // root → count of writes in flight in this process
export const pendingWrites = (root) => pending.get(resolve(root)) ?? 0;

/**
 * Save `data` to `dest` (inside `root`) so a crash never leaves a corrupt final file:
 * limits + capacity → journal → temp → fsync → read-back sha256 → rename → fsync dir → read-back sha256 → journal cleared.
 * `fault(stage)` is a test hook ('after-temp-write' | 'before-rename').
 */
export async function safeWriteFile(dest, data, { root, maxFileBytes = MAX, reserveBytes = 1 << 20, fault = null, statfsImpl = statfs } = {}) {
  if (!root) throw new Error('safeWriteFile: root (the drive\'s Kingmaker folder) is required');
  if (!inside(root, dest)) throw new Error(`STORAGE_OUTSIDE_ROOT: ${dest} is outside ${root}`);
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  const want = sha256(buf), t0 = performance.now();
  if (buf.length > maxFileBytes) throw new Error(`STORAGE_FILE_TOO_LARGE: ${buf.length} bytes exceeds this filesystem's ${maxFileBytes}-byte file limit — refused before writing`);
  try { if ((await lstat(dest)).isSymbolicLink()) throw new Error(`STORAGE_SYMLINK_REFUSED: ${dest} is a symlink — refused`); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const dir = dirname(dest);
  const s = await statfsImpl(dir);
  const free = Number(s.bavail) * Number(s.bsize);
  if (free < buf.length + reserveBytes) throw new Error(`STORAGE_NO_SPACE: ${buf.length} bytes (+${reserveBytes} reserve) needed, ${free} available on the drive — refused before writing`);
  const key = resolve(root); pending.set(key, (pending.get(key) ?? 0) + 1);
  const id = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
  const jdir = join(root, JOURNAL_DIR), jfile = join(jdir, `${id}.json`);
  const temp = join(dir, `.${basename(dest)}${TMP_MARK}${id}`);
  try {
    mkdirSync(jdir, { recursive: true });
    await writeSynced(jfile, Buffer.from(JSON.stringify({ op: 'write', dest: relative(root, dest), temp: relative(root, temp), sha256: want, bytes: buf.length, startedAt: new Date().toISOString(), pid: process.pid })));
    await writeSynced(temp, buf);
    if (fault) await fault('after-temp-write', { temp, dest, jfile });
    if (sha256(await readFile(temp)) !== want) { await unlink(temp).catch(() => {}); throw new Error(`STORAGE_VERIFY_FAILED: the temporary copy of ${basename(dest)} did not read back intact — the original is untouched`); }
    if (fault) await fault('before-rename', { temp, dest, jfile });
    await rename(temp, dest);
    try { const dh = await open(dir, 'r'); try { await dh.sync(); } finally { await dh.close(); } } catch { /* some filesystems refuse a directory fsync */ }
    const got = sha256(await readFile(dest));
    if (got !== want) throw new Error(`STORAGE_VERIFY_FAILED: ${dest} read back as sha256 ${got.slice(0, 12)}…, expected ${want.slice(0, 12)}… — the journal entry is kept for recovery`);
    await unlink(jfile).catch(() => {});
    return { path: dest, bytes: buf.length, sha256: want, verified: true, ms: Math.round(performance.now() - t0) };
  } finally { pending.set(key, Math.max(0, (pending.get(key) ?? 1) - 1)); }
}
async function writeSynced(path, buf) {
  const fh = await open(path, 'wx');
  try { await fh.writeFile(buf); await fh.sync(); } finally { await fh.close(); }
}

/**
 * The same verified save, synchronous, for callers whose API is synchronous (acceptAbilityRelease, applyRevocations).
 * Identical steps and journal format, so recoverDrive() handles an interrupted one the same way.
 */
export function safeWriteFileSync(dest, data, { root, maxFileBytes = MAX, reserveBytes = 1 << 20, fault = null, statfsImpl = statfsSync } = {}) {
  if (!root) throw new Error('safeWriteFileSync: root (the drive\'s Kingmaker folder) is required');
  if (!inside(root, dest)) throw new Error(`STORAGE_OUTSIDE_ROOT: ${dest} is outside ${root}`);
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  const want = sha256(buf), t0 = performance.now();
  if (buf.length > maxFileBytes) throw new Error(`STORAGE_FILE_TOO_LARGE: ${buf.length} bytes exceeds this filesystem's ${maxFileBytes}-byte file limit — refused before writing`);
  try { if (lstatSync(dest).isSymbolicLink()) throw new Error(`STORAGE_SYMLINK_REFUSED: ${dest} is a symlink — refused`); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const dir = dirname(dest);
  const s = statfsImpl(dir);
  const free = Number(s.bavail) * Number(s.bsize);
  if (free < buf.length + reserveBytes) throw new Error(`STORAGE_NO_SPACE: ${buf.length} bytes (+${reserveBytes} reserve) needed, ${free} available on the drive — refused before writing`);
  const key = resolve(root); pending.set(key, (pending.get(key) ?? 0) + 1);
  const id = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
  const jdir = join(root, JOURNAL_DIR), jfile = join(jdir, `${id}.json`);
  const temp = join(dir, `.${basename(dest)}${TMP_MARK}${id}`);
  const synced = (path, b) => { const fd = openSync(path, 'wx', 0o600); try { writeSync(fd, b); fsyncSync(fd); } finally { closeSync(fd); } };
  try {
    mkdirSync(jdir, { recursive: true });
    synced(jfile, Buffer.from(JSON.stringify({ op: 'write', dest: relative(root, dest), temp: relative(root, temp), sha256: want, bytes: buf.length, startedAt: new Date().toISOString(), pid: process.pid })));
    synced(temp, buf);
    if (fault) fault('after-temp-write', { temp, dest, jfile });
    if (sha256(readFileSync(temp)) !== want) { try { unlinkSync(temp); } catch { /* gone */ } throw new Error(`STORAGE_VERIFY_FAILED: the temporary copy of ${basename(dest)} did not read back intact — the original is untouched`); }
    if (fault) fault('before-rename', { temp, dest, jfile });
    renameSync(temp, dest);
    try { const dfd = openSync(dir, 'r'); try { fsyncSync(dfd); } finally { closeSync(dfd); } } catch { /* some filesystems refuse a directory fsync */ }
    const got = sha256(readFileSync(dest));
    if (got !== want) throw new Error(`STORAGE_VERIFY_FAILED: ${dest} read back as sha256 ${got.slice(0, 12)}…, expected ${want.slice(0, 12)}… — the journal entry is kept for recovery`);
    try { unlinkSync(jfile); } catch { /* gone */ }
    return { path: dest, bytes: buf.length, sha256: want, verified: true, ms: Math.round(performance.now() - t0) };
  } finally { pending.set(key, Math.max(0, (pending.get(key) ?? 1) - 1)); }
}

/**
 * On the next start: finish or roll back every journaled write on a drive root, and sweep stray temp files.
 * Never touches a final file whose write did not complete. → [{ journal, outcome, dest }]
 */
export function recoverDrive(root) {
  const out = [], jdir = join(root, JOURNAL_DIR);
  let names = [];
  try { names = readdirSync(jdir).filter((n) => n.endsWith('.json')); } catch { names = []; }
  for (const n of names) {
    const jf = join(jdir, n);
    let j = null;
    try { j = JSON.parse(readFileSync(jf, 'utf8')); } catch { j = null; }
    if (!j) { rmSync(jf, { force: true }); out.push({ journal: n, outcome: 'discarded-partial-journal (no data had been written yet)' }); continue; }
    const temp = join(root, String(j.temp)), dest = join(root, String(j.dest));
    if (!inside(root, temp) || !inside(root, dest)) { out.push({ journal: n, outcome: 'ignored (paths outside the root)' }); continue; }
    if (alive(j.pid) && !(j.pid === process.pid && pendingWrites(root) === 0)) { out.push({ journal: n, dest: j.dest, outcome: 'in progress (its writer is still running) — left alone' }); continue; }
    if (existsSync(temp)) { rmSync(temp, { force: true }); rmSync(jf, { force: true }); out.push({ journal: n, dest: j.dest, outcome: existsSync(dest) ? 'rolled-back (interrupted before rename; the previous file is intact)' : 'rolled-back (interrupted before rename; no final file was created)' }); continue; }
    let ok = false; try { ok = sha256(readFileSync(dest)) === j.sha256; } catch { ok = false; }
    if (ok) { rmSync(jf, { force: true }); out.push({ journal: n, dest: j.dest, outcome: 'completed (renamed before the interruption; verified)' }); }
    else out.push({ journal: n, dest: j.dest, outcome: 'needs attention (final file does not match the journal; left as is)' });
  }
  // Stray temp files without a live journal entry (e.g. the journal was cleared but the temp unlink failed).
  let live = []; try { live = readdirSync(jdir).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)); } catch { live = []; }
  const sweep = (d, depth) => {
    let ents = []; try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = join(d, e.name);
      if (e.isDirectory() && depth < 6 && e.name !== JOURNAL_DIR) sweep(p, depth + 1);
      else if (e.isFile() && e.name.includes(TMP_MARK) && !live.includes(e.name.split(TMP_MARK)[1])) { rmSync(p, { force: true }); out.push({ outcome: 'removed stray temp file', dest: relative(root, p) }); }
    }
  };
  sweep(root, 0);
  return out;
}

/**
 * Where the user's own methods are saved right now: { dir, put, where, drive }. Internal when no drive holds the
 * user-methods role; the drive (verified writes) when it is connected; otherwise throws STORAGE_UNAVAILABLE — the
 * method is not silently saved to a second library on the internal disk.
 */
export function userMethodsDestination(state, { storage = undefined } = {}) {
  return roleDestination(state, 'user-methods', join(state, 'abilities', 'methods'), { storage });
}

/**
 * Where one role's WRITES go right now: { where: 'internal'|'drive', dir, root?, drive?, put, putSync }. put/putSync
 * are the verified drive writers (null when internal). Throws STORAGE_UNAVAILABLE when the role is assigned to a drive
 * that is missing, read-only or not ours — nothing is saved and no second copy is made on this Mac.
 */
export function roleDestination(state, role, internalDir, { storage = undefined } = {}) {
  const resolved = storage === undefined ? resolveStorage({ state }) : storage;
  const t = writeTarget(resolved, role, internalDir);
  if (t.where === 'refused') throw new Error(`STORAGE_UNAVAILABLE: ${t.reason}`);
  return { ...t, put: t.where === 'drive' ? driveWriter(t) : null, putSync: t.where === 'drive' ? driveWriterSync(t) : null };
}

/** A writer for method stores on a drive: put(path, data) = safeWriteFile with the drive's limits. */
export function driveWriter(target) {
  return (path, data) => safeWriteFile(path, data, { root: target.root, maxFileBytes: target.maxFileBytes ?? MAX });
}
/** The synchronous writer (safeWriteFileSync) for the same target. */
export function driveWriterSync(target) {
  return (path, data) => safeWriteFileSync(path, data, { root: target.root, maxFileBytes: target.maxFileBytes ?? MAX });
}

/**
 * The drive role a directory is, in a resolved storage, or null when it is not an approved drive's store.
 * → { role, drive, root, dir, writable, status, reason, maxFileBytes }
 */
export function driveRoleOf(resolved, dir) {
  if (!dir || !resolved?.configured) return null;
  const d = resolve(String(dir));
  for (const [role, r] of Object.entries(resolved.roles ?? {})) {
    if (r.dir && resolve(r.dir) === d) return { role, drive: r.drive, root: r.root, dir: r.dir, writable: r.writable, status: r.status, reason: r.reason, maxFileBytes: r.capabilities?.maxFileBytes ?? MAX };
  }
  return null;
}

// ───────────────────────────── cached resolution (hot paths) ─────────────────────────────
const cache = new Map(); // state → { at, mtimeMs, value }
/** True when <state>/storage/drives.json names a drive holding `role` (reads the registry only; no discovery). */
export function roleAssigned(state, role) { return readRegistry(state).drives.some((d) => d.roles.includes(role)); }
/**
 * resolveStorage, remembered for `ttlMs` per state (and re-run when drives.json changes), for code that asks often —
 * kingmakerHome() is called on many paths. Discovery runs only when a drive is approved at all.
 */
export function resolveStorageCached({ state, ttlMs = 5000, now = Date.now, ...opts } = {}) {
  let mtimeMs = 0; try { mtimeMs = statSync(registryPath(state)).mtimeMs; } catch { mtimeMs = 0; }
  const hit = cache.get(state);
  // Passing `volumes` is a fresh answer (a caller that has just discovered them): it always re-resolves.
  if (!opts.volumes && hit && hit.mtimeMs === mtimeMs && now() - hit.at < hit.ttlMs) return hit.value;
  const value = resolveStorage({ state, ...opts });
  let after = mtimeMs; try { after = statSync(registryPath(state)).mtimeMs; } catch { /* none */ }
  cache.set(state, { at: now(), mtimeMs: after, ttlMs, value });
  return value;
}
export function clearStorageCache() { cache.clear(); }

// ───────────────────────────── memory (the engine's MemPalace data folder) ─────────────────────────────
/** The engine keeps its governed memory (MemPalace, with the ledger) in <data>/sqlite/solomon.db (runtime-paths.ts). */
export const ENGINE_MEMORY_DB = Object.freeze(['sqlite', 'solomon.db']);
const hasMemoryDb = (dataDir) => { try { return statSync(join(dataDir, ...ENGINE_MEMORY_DB)).isFile(); } catch { return false; } };

/**
 * Where the engine's memory lives for this start. `internalDir` is the data folder the engine would use without a
 * drive (SOLOMON_DATA_DIR, else <runtime home>/data).
 *   no memory role   → { where: 'internal', dir: internalDir, env: {} }
 *   drive connected  → { where: 'drive', dir: <drive>/Kingmaker/<install>/memory, env: { SOLOMON_DATA_DIR } }
 *   otherwise        → { where: 'refused', reason }: the drive is missing / read-only / not ours, or it is still empty
 *                      while this Mac holds the memory database. The engine must NOT start: starting it would create
 *                      a second, empty memory store (on this Mac, or on the drive beside the uncopied one).
 */
export function engineMemoryLocation({ state, internalDir, storage = undefined }) {
  const resolved = storage === undefined ? resolveStorage({ state }) : storage;
  const r = resolved?.roles?.memory;
  if (!r) return { where: 'internal', dir: internalDir, env: {} };
  if (r.status !== 'connected') {
    return { where: 'refused', dir: null, drive: r.drive, status: r.status,
      reason: `Unavailable: memory — it is assigned to drive "${r.drive}": ${r.reason}. The engine was not started, so no second memory store was created on this Mac. Connect the drive (or remove its approval with "kingmaker storage forget") and start again.` };
  }
  if (!hasMemoryDb(r.dir) && internalDir && hasMemoryDb(internalDir)) {
    return { where: 'refused', dir: r.dir, drive: r.drive, status: 'not-copied',
      reason: `Unavailable: memory — drive "${r.drive}" holds the memory role but has no memory database yet, while this Mac still has one at ${join(internalDir, ...ENGINE_MEMORY_DB)}. The engine was not started (it would begin a second, empty memory). Run "kingmaker storage copy memory" while Kingmaker is stopped; the copy is verified and this Mac's copy is kept.` };
  }
  return { where: 'drive', dir: r.dir, root: r.root, drive: r.drive, env: { SOLOMON_DATA_DIR: r.dir } };
}

// ───────────────────────────── files (Kingmaker's Files folder) ─────────────────────────────
/**
 * Where Kingmaker's Files folder is: { where: 'internal'|'drive'|'unavailable', dir, writable, reason }. With no
 * drive holding the files role: the internal folder (`internalDir`). On a missing or foreign drive dir is null and the
 * reason says why — callers refuse, and nothing is made on this Mac instead. A read-only drive is readable only.
 */
export function filesLocation({ state, internalDir, storage = undefined, cached = true }) {
  if (storage === undefined && !roleAssigned(state, 'files')) return { where: 'internal', dir: internalDir, writable: true };
  const resolved = storage === undefined ? (cached ? resolveStorageCached({ state }) : resolveStorage({ state })) : storage;
  const r = resolved?.roles?.files;
  if (!r) return { where: 'internal', dir: internalDir, writable: true };
  if (r.dir) {
    return { where: 'drive', dir: r.dir, root: r.root, drive: r.drive, writable: r.writable, maxFileBytes: r.capabilities?.maxFileBytes ?? MAX,
      reason: r.writable ? null : `Unavailable: saving your files — ${r.reason}` };
  }
  const d = readRegistry(state).drives.find((x) => x.key === r.key);
  return { where: 'unavailable', dir: null, drive: r.drive, writable: false,
    expectedDir: d?.lastMount && d?.installId ? join(driveRootOf(d.lastMount, d.installId), ...ROLES.files.rel) : null,
    reason: `Unavailable: your files — they are assigned to drive "${r.drive}": ${r.reason}. Nothing was saved, and no second Files folder was made on this Mac.` };
}

/**
 * Copy a folder tree from this Mac to a drive (an explicit, authorized operation; used for memory and files). Every
 * file goes through safeWriteFile and is verified; NOTHING on this Mac is moved or deleted; a file already on the
 * drive with different bytes is left alone and reported; symlinks and special files are skipped and reported.
 * → { copied, skipped, conflicts, refused, verified, from, to, originals }
 */
export async function copyTreeToDrive({ from, target, filter = () => true, fault = null }) {
  const out = { copied: [], skipped: [], conflicts: [], refused: [], verified: true, from, to: target.dir };
  const put = (path, data) => safeWriteFile(path, data, { root: target.root, maxFileBytes: target.maxFileBytes ?? MAX, fault });
  const walk = async (rel) => {
    let ents = []; try { ents = readdirSync(join(from, rel), { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const r = rel ? join(rel, e.name) : e.name;
      if (!filter(r, e) || e.name.includes(TMP_MARK) || e.name === JOURNAL_DIR) continue;
      if (e.isSymbolicLink()) { out.refused.push({ path: r, reason: 'a symlink — not copied (Kingmaker puts no links on a drive)' }); continue; }
      if (e.isDirectory()) { mkdirSync(join(target.dir, r), { recursive: true }); await walk(r); continue; }
      if (!e.isFile()) { out.refused.push({ path: r, reason: 'not a regular file — not copied' }); continue; }
      const buf = readFileSync(join(from, r)), there = join(target.dir, r);
      if (existsSync(there)) {
        if (sha256(readFileSync(there)) === sha256(buf)) out.skipped.push(r);
        else out.conflicts.push({ path: r, reason: 'a different file with this name is already on the drive — left as is' });
        continue;
      }
      const w = await put(there, buf);
      if (sha256(readFileSync(join(from, r))) !== w.sha256) out.verified = false; // the source changed while it was copied
      out.copied.push({ path: r, sha256: w.sha256, bytes: w.bytes });
    }
  };
  mkdirSync(target.dir, { recursive: true });
  await walk('');
  return { ...out, originals: 'preserved (nothing on this Mac was moved or deleted)' };
}

/**
 * Copy an internal method store to a drive store (an explicit, authorized operation). Each file is written with
 * safeWriteFile and verified; the internal originals are NEVER moved or deleted. A same-id method with different bytes
 * already on the drive is left alone and reported. → { copied, skipped, conflicts, verified }
 */
export async function copyStoreToDrive({ from, target }) {
  const { normalizeMethodsIndex, METHODS_SCHEMA } = await import('./brain-library.mjs');
  const src = normalizeMethodsIndex(JSON.parse(readFileSync(join(from, 'index.json'), 'utf8')));
  mkdirSync(target.dir, { recursive: true });
  let dst = []; try { dst = normalizeMethodsIndex(JSON.parse(readFileSync(join(target.dir, 'index.json'), 'utf8'))); } catch { dst = []; }
  const put = driveWriter(target), out = { copied: [], skipped: [], conflicts: [], verified: true };
  const next = [...dst];
  for (const m of src) {
    const buf = readFileSync(join(from, m.file));
    const there = join(target.dir, m.file);
    if (existsSync(there)) {
      if (sha256(readFileSync(there)) === sha256(buf)) { out.skipped.push(m.id); if (!next.some((x) => x.id === m.id)) next.push(m); continue; }
      out.conflicts.push({ id: m.id, reason: 'a different file with this name is already on the drive — left as is' }); continue;
    }
    const r = await put(there, buf);
    out.copied.push({ id: m.id, sha256: r.sha256, bytes: r.bytes });
    next.splice(0, next.length, ...next.filter((x) => x.id !== m.id), m);
  }
  const doc = { schema: METHODS_SCHEMA, methods: next.map(({ id, title, domain, file, quality }) => ({ id, title, domain, file, quality })) };
  normalizeMethodsIndex(doc);
  await put(join(target.dir, 'index.json'), `${JSON.stringify(doc, null, 2)}\n`);
  for (const c of out.copied) { const f = src.find((m) => m.id === c.id).file; if (sha256(readFileSync(join(target.dir, f))) !== sha256(readFileSync(join(from, f)))) out.verified = false; }
  return { ...out, from, to: target.dir, originals: 'preserved (nothing on the internal disk was moved or deleted)' };
}

// ───────────────────────────── models + eject ─────────────────────────────
/**
 * Where model files would be looked up. Documented config only: Kingmaker never edits the live Ollama setup. When the
 * models role is on a connected drive, the answer carries the OLLAMA_MODELS line the user may set themselves.
 */
export function modelsLocation({ resolved, env = process.env, defaultDir }) {
  const explicit = String(env.OLLAMA_MODELS ?? '').trim();
  const r = resolved?.roles?.models;
  if (r && r.dir) return { dir: r.dir, source: `approved drive "${r.drive}"`, active: explicit === r.dir, config: `OLLAMA_MODELS="${r.dir}"`, note: `Set OLLAMA_MODELS in the environment Ollama starts with to use the drive; Kingmaker has not changed the live Ollama configuration${explicit && explicit !== r.dir ? ` (it is currently ${explicit})` : ''}. ${r.capabilities?.maxFileBytes && r.capabilities.maxFileBytes < 2 ** 40 ? `This filesystem cannot hold a model file of ${r.capabilities.maxFileBytes + 1} bytes or more.` : ''}`.trim() };
  if (r) return { dir: null, source: `approved drive "${r.drive}"`, active: false, unavailable: r.reason, fallback: explicit || defaultDir, note: `Models assigned to drive "${r.drive}" are unavailable (${r.reason}); local models in ${explicit || defaultDir} still work. Nothing is downloaded or fetched from a paid service instead.` };
  return { dir: explicit || defaultDir, source: explicit ? 'OLLAMA_MODELS' : 'default', active: true };
}

/** Is it safe to unplug? Open handles (lsof), in-flight writes here, unfinished journal entries. Never unmounts. */
export function ejectReadiness({ mountPoint, root = null, run = runReadOnly }) {
  let handles = [], lsofError = null;
  try { handles = parseLsofF(run('lsof', ['-F', 'pcn', '+f', '--', mountPoint])); } catch (e) { lsofError = String(e.message ?? e).slice(0, 120); }
  let journal = []; if (root) { try { journal = readdirSync(join(root, JOURNAL_DIR)).filter((n) => n.endsWith('.json')); } catch { journal = []; } }
  const inflight = root ? pendingWrites(root) : 0;
  const safe = !lsofError && handles.length === 0 && inflight === 0 && journal.length === 0;
  return { mountPoint, safeToEject: safe, openHandles: handles, pendingWrites: inflight, unfinishedJournal: journal, lsofError,
    note: safe ? 'Nothing is open or being written. Eject it from Finder; Kingmaker never unmounts a drive itself.' : 'Not safe yet: close the listed files / let the writes finish. Kingmaker never force-unmounts.' };
}

export function sizeOf(p) { try { return statSync(p).size; } catch { return null; } }
