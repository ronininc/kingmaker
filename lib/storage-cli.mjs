// lib/storage-cli.mjs — the headless surface for approved external storage (lib/external-storage.mjs):
//   kingmaker storage list [--json]                         mounted external volumes: name, space, filesystem limits, ids
//   kingmaker storage approve <mount> --roles r1,r2 [--yes]  approve one volume (asks on a terminal; --yes = your answer)
//   kingmaker storage status [--json]                       approved drives: connected / missing / read-only, per role
//   kingmaker storage copy <role>                           copy the internal store for a role to its drive (verified;
//                                                           originals kept)
//   kingmaker storage models                                where model files would be looked up (documented config only)
//   kingmaker storage eject-check <label>                   open files / pending writes on a drive (never unmounts)
//   kingmaker storage forget <label>                        remove an approval (the drive's data is left as is)
// Roles: user-methods, fleet-abilities, library-cache, models, memory.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolvePaths } from './paths.mjs';
import { localModelsDir } from './model-sync.mjs';
import {
  ROLES, approveDrive, copyStoreToDrive, discoverVolumes, ejectReadiness, forgetDrive, modelsLocation, readRegistry, resolveStorage, writeTarget,
} from './external-storage.mjs';

const flag = (args, name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] ?? null : null; };
const gb = (b) => (b == null ? '?' : `${(b / 2 ** 30).toFixed(b < 2 ** 30 ? 3 : 1)} GiB`);
const yn = (v) => (v === true ? 'yes' : v === false ? 'no' : 'unknown');

function describe(v) {
  const c = v.capabilities;
  return [
    `${v.name ?? '(no name)'} at ${v.mountPoint} — ${v.fsName ?? v.fsType}, ${gb(v.availableBytes)} free of ${gb(v.totalBytes)}${v.readOnly ? ', READ-ONLY' : ''}`,
    `  removable ${yn(v.removable)}, internal ${yn(v.internal)}, encrypted ${yn(v.encrypted)}, bus ${v.bus ?? 'unknown'}`,
    `  case-sensitive ${yn(c.caseSensitive)}, symlinks ${yn(c.symlinks)}, max file ${c.maxFileBytes >= Number.MAX_SAFE_INTEGER ? 'no practical limit' : `${c.maxFileBytes} bytes`}, xattrs ${yn(c.xattrs)}, journaling ${typeof c.journaling === 'string' ? c.journaling : yn(c.journaling)}`,
    `  id ${v.stableId ? `${v.stableId.kind} ${v.stableId.value}` : 'UNAVAILABLE'}; ${v.approvable ? 'can be approved' : `cannot be approved: ${v.notApprovable.join('; ')}`}`,
    ...c.notes.map((n) => `  note: ${n}`),
  ];
}

export async function cmdStorage(args) {
  const paths = resolvePaths();
  const state = paths.state;
  const [verb, ...rest] = args;
  const json = args.includes('--json');
  if (verb === 'list' || !verb) {
    const vols = discoverVolumes();
    if (json) console.log(JSON.stringify(vols, null, 2));
    else if (!vols.length) console.log('No external volumes are mounted.');
    else for (const v of vols) for (const l of describe(v)) console.log(l);
    return 0;
  }
  if (verb === 'approve') {
    const mount = rest.find((a, i) => !a.startsWith('--') && rest[i - 1] !== '--roles');
    const roles = String(flag(rest, '--roles') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!mount || !roles.length) { console.error(`usage: kingmaker storage approve <mount point> --roles ${Object.keys(ROLES).join(',')} [--yes]`); return 2; }
    const v = discoverVolumes({ extraMounts: [mount] }).find((x) => x.mountPoint === mount || x.mountPoint === mount.replace(/\/+$/, ''));
    if (!v) { console.error(`No mounted volume at ${mount}.`); return 1; }
    for (const l of describe(v)) console.log(l);
    console.log(`Kingmaker would create ${join(mount, 'Kingmaker', '<this install>')} and keep there: ${roles.map((r) => ROLES[r]?.what ?? r).join('; ')}. Nothing else on the drive is touched; it is never formatted, erased or re-permissioned.`);
    let ok = rest.includes('--yes');
    if (!ok && process.stdin.isTTY) {
      const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout });
      ok = /^y(es)?$/i.test((await rl.question('Approve this drive? [y/N] ')).trim()); rl.close();
    }
    if (!ok) { console.log('Not approved.'); return 1; }
    try { const e = approveDrive({ state, volume: v, roles, confirm: true }); console.log(`Approved "${e.label}" (${e.key}) for ${e.roles.join(', ')}. Folder: ${e.root}`); return 0; }
    catch (e) { console.error(e.message); return 1; }
  }
  if (verb === 'status') {
    const r = resolveStorage({ state });
    if (json) { console.log(JSON.stringify(r, null, 2)); return 0; }
    if (!r.configured) { console.log('No external drive is approved; everything is on this Mac.'); return 0; }
    for (const d of r.drives) console.log(`${d.label}: ${d.status}${d.mountPoint ? ` at ${d.mountPoint}` : ''} — roles ${d.roles.join(', ')}${d.reason ? ` (${d.reason})` : ''}`);
    for (const u of r.unavailable) console.log(`Unavailable: ${u.what} — ${u.reason}`);
    for (const n of r.notes) console.log(`Note: ${n}`);
    for (const x of r.recovered) console.log(`Recovered on "${x.drive}": ${x.outcome}${x.dest ? ` (${x.dest})` : ''}`);
    return 0;
  }
  if (verb === 'copy') {
    const role = rest[0];
    const internal = { 'user-methods': join(state, 'abilities', 'methods'), 'fleet-abilities': join(state, 'fleet', 'abilities', 'methods'), 'library-cache': join(state, 'brain-library', 'methods') }[role];
    if (!internal) { console.error('usage: kingmaker storage copy user-methods|fleet-abilities|library-cache'); return 2; }
    const t = writeTarget(resolveStorage({ state }), role, internal);
    if (t.where !== 'drive') { console.error(t.where === 'internal' ? `No approved drive holds ${role}.` : t.reason); return 1; }
    const out = await copyStoreToDrive({ from: internal, target: t });
    console.log(`Copied ${out.copied.length}, already there ${out.skipped.length}, conflicts ${out.conflicts.length}; verified ${out.verified}. ${out.originals}.`);
    return out.verified && !out.conflicts.length ? 0 : 1;
  }
  if (verb === 'models') {
    const m = modelsLocation({ resolved: resolveStorage({ state }), defaultDir: localModelsDir(process.env, homedir()) });
    if (json) console.log(JSON.stringify(m, null, 2)); else { console.log(`Models: ${m.dir ?? 'unavailable'} (${m.source})`); if (m.config) console.log(`To use it: ${m.config}`); if (m.note) console.log(m.note); }
    return 0;
  }
  if (verb === 'eject-check') {
    const r = resolveStorage({ state, recover: false });
    const d = r.drives.find((x) => x.label === rest[0] || x.key === rest[0]);
    if (!d?.mountPoint) { console.error(`"${rest[0]}" is not an approved, connected drive.`); return 1; }
    const e = ejectReadiness({ mountPoint: d.mountPoint, root: d.root });
    if (json) console.log(JSON.stringify(e, null, 2));
    else { console.log(e.note); if (e.lsofError) console.log(`  could not list open files: ${e.lsofError}`); for (const h of e.openHandles) console.log(`  open: ${h.command} (pid ${h.pid}) ${h.name}`); if (e.pendingWrites) console.log(`  writes in progress: ${e.pendingWrites}`); for (const j of e.unfinishedJournal) console.log(`  unfinished save: ${j}`); }
    return e.safeToEject ? 0 : 1;
  }
  if (verb === 'forget') {
    const n = forgetDrive({ state, key: rest[0] });
    console.log(n ? `Removed the approval for "${rest[0]}". Its files on the drive were left as they are.` : `No approved drive "${rest[0]}". Approved: ${readRegistry(state).drives.map((d) => d.label).join(', ') || 'none'}.`);
    return n ? 0 : 1;
  }
  console.error('usage: kingmaker storage list | approve <mount> --roles … | status | copy <role> | models | eject-check <label> | forget <label>');
  return 2;
}
