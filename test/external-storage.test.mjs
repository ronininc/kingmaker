// Approved external storage (lib/external-storage.mjs), on ISOLATED fixtures only: temp directories stand in for
// mount points, and discovery parsers run on captured/fixture text (macOS diskutil plists captured from hdiutil test
// images; Linux /proc/mounts + lsblk and Windows Get-Volume/Win32_Volume JSON are hand-written fixtures). No real drive
// is touched. The real-filesystem run (exFAT / FAT32 disk images) is test/external-storage-image.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  approveDrive, assertReadOnlyCommand, copyStoreToDrive, describeVolume, discoverMac, driveRootOf, ejectReadiness, fsCapabilities, linuxVolumes,
  macVolume, modelsLocation, parseDfK, parseLsofF, parseMacMount, parsePlist, readRegistry, recoverDrive, resolveStorage, safeWriteFile,
  storageLayers, userMethodsDestination, windowsVolumes, writeTarget, JOURNAL_DIR,
} from '../lib/external-storage.mjs';
import { createLocalBrain, handleMethodRequest } from '../lib/method-request.mjs';
import { writeMethod } from '../lib/method-writing.mjs';
import { promoteDraft } from '../lib/method-from-source.mjs';

const FIX = fileURLToPath(new URL('./fixtures/external-storage/', import.meta.url));
const fx = (n) => readFileSync(join(FIX, n), 'utf8');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const UUID = 'CDF24AEF-BA6E-364B-AA29-AB5F032396F8';

function world() {
  const base = mkdtempSync(join(tmpdir(), 'km-ext-'));
  const state = join(base, 'state'); mkdirSync(state, { recursive: true });
  const mount = join(base, 'Volumes', 'KMUSB'); mkdirSync(mount, { recursive: true });
  const vol = (over = {}) => describeVolume({ platform: 'darwin', name: 'KMUSB', mountPoint: mount, device: '/dev/disk9s1', fsType: 'exfat', fsName: 'ExFAT', totalBytes: 32 << 20, availableBytes: 30 << 20, readOnly: false, removable: true, internal: false, encrypted: null, stableId: { kind: 'mac-volume-uuid', value: UUID }, bus: 'USB', ...over });
  const work = (n) => { const d = join(base, 'tasks', n); mkdirSync(d, { recursive: true }); return d; };
  return { base, state, mount, vol, work, done: () => rmSync(base, { recursive: true, force: true }) };
}
const proposal = async () => JSON.stringify({ title: 'Miles to kilometres', domain: 'conversion', steps: [{ id: 'rule', type: 'note', text: 'km = miles × 1.609344' }, { id: 'convert', type: 'reason', preamble: 'Convert miles to kilometres.', prompt: '{{inputs.prompt}}' }] });
const reasoner = async ({ prompt }) => (/[\d.]+/.test(prompt) ? `${(Number(/[\d.]+/.exec(prompt)[0]) * 1.609344).toFixed(2)} km` : `answer for ${prompt}`);
const methodText = (id, title, domain = id.split('-')[0]) => `# ${title}\n\n\`\`\`kingmaker-method\n${JSON.stringify({ id, version: '1.0', title, domain, inputs: { prompt: '' }, steps: [
  { n: 1, id: 'solve', type: 'reason', into: 'answer', preamble: 'Answer.', prompt: '{{inputs.prompt}}' },
  { n: 2, id: 'rec', type: 'write-json', path: 'r.json', value: { method: id, answer: '{{answer}}' } },
  { n: 3, id: 'check', type: 'verify', assertions: [{ file: 'r.json', field: 'method', equals: id }] }] }, null, 2)}\n\`\`\`\n`;
function putStore(dir, id, title) {
  mkdirSync(dir, { recursive: true });
  const file = `${id}.method.md`; writeFileSync(join(dir, file), methodText(id, title));
  let prior = []; try { prior = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')).methods; } catch { prior = []; }
  writeFileSync(join(dir, 'index.json'), JSON.stringify({ schema: 'kingmaker.methods/1', methods: [...prior.filter((m) => m.id !== id), { id, title, domain: id.split('-')[0], file, quality: { tier: 'draft', score: 50, basis: 'fixture' } }] }));
}
const treeHash = (dir) => { const out = {}; const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else out[p.slice(dir.length)] = sha(readFileSync(p)); } }; walk(dir); return out; };

// ───────────── discovery parsers ─────────────
test('macOS: diskutil plists (captured from exFAT and FAT32 test images) → name, fs, id, removable, limits', () => {
  const ex = macVolume(parsePlist(fx('diskutil-exfat.plist')));
  assert.equal(ex.name, 'KMEXFAT'); assert.equal(ex.fsType, 'exfat'); assert.equal(ex.mountPoint, '/Volumes/KMEXFAT');
  assert.deepEqual(ex.stableId, { kind: 'mac-volume-uuid', value: UUID });
  assert.equal(ex.removable, true); assert.equal(ex.internal, false); assert.equal(ex.readOnly, false); assert.equal(ex.encrypted, null);
  assert.equal(ex.totalBytes, 33423360);
  const fat = describeVolume(macVolume(parsePlist(fx('diskutil-fat32.plist'))));
  assert.equal(fat.fsType, 'msdos'); assert.equal(fat.capabilities.maxFileBytes, 4 * 2 ** 30 - 1); assert.equal(fat.capabilities.symlinks, false);
  assert.equal(fat.capabilities.caseSensitive, false); assert.equal(fat.capabilities.journaling, false); assert.equal(fat.approvable, true);
  assert.equal(fsCapabilities('apfs', 'APFS (Case-sensitive)').caseSensitive, true);
  assert.equal(fsCapabilities('zfs').compatible, false);
});

test('macOS: mount / df parsing (spaces in names, read-only flag) and discovery runs only read-only commands', () => {
  const mounts = parseMacMount('/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)\n/dev/disk9s1 on /Volumes/My Drive (exfat, local, nodev, nosuid, noowners)\n/dev/disk8s1 on /Volumes/Old Card (msdos, local, nodev, nosuid, read-only, noowners)\n');
  assert.equal(mounts[1].mountPoint, '/Volumes/My Drive'); assert.equal(mounts[2].readOnly, true);
  const df = parseDfK('Filesystem 1024-blocks Used Available Capacity iused ifree %iused Mounted on\n/dev/disk9s1 32640 20 32620 1% 1 0 100% /Volumes/My Drive\n');
  assert.equal(df[0].availableBytes, 32620 * 1024); assert.equal(df[0].mountPoint, '/Volumes/My Drive');
  const calls = [];
  const run = (cmd, args) => { assertReadOnlyCommand(cmd, args); calls.push([cmd, ...args].join(' '));
    if (cmd === 'mount') return '/dev/disk9s1 on /Volumes/KMEXFAT (exfat, local, nodev, nosuid, noowners)\n/dev/disk8s1 on /Volumes/Old Card (msdos, local, read-only)\n';
    if (cmd === 'df') return 'Filesystem 1024-blocks Used Available Capacity iused ifree %iused Mounted on\n/dev/disk9s1 32640 20 32620 1% 1 0 100% /Volumes/KMEXFAT\n';
    if (cmd === 'diskutil') return args[2] === '/Volumes/KMEXFAT' ? fx('diskutil-exfat.plist') : '<plist version="1.0"><dict><key>VolumeName</key><string>Old Card</string><key>FilesystemType</key><string>msdos</string></dict></plist>';
    throw new Error('unexpected'); };
  const vols = discoverMac({ run, env: {} });
  assert.deepEqual(calls, ['mount', 'df -k', 'diskutil info -plist /Volumes/KMEXFAT', 'diskutil info -plist /Volumes/Old Card']);
  assert.equal(vols[0].availableBytes, 32620 * 1024); assert.equal(vols[0].approvable, true);
  assert.equal(vols[1].readOnly, true); assert.equal(vols[1].approvable, false); assert.match(vols[1].notApprovable.join(), /no stable identifier/);
  for (const [c, a] of [['diskutil', ['eraseDisk', 'ExFAT', 'X', 'disk9']], ['diskutil', ['partitionDisk', 'disk9']], ['diskutil', ['unmount', '/Volumes/X']], ['diskutil', ['mount', 'disk9s1']], ['chmod', ['777', '/Volumes/X']], ['mount', ['-t', 'exfat']], ['newfs_exfat', ['/dev/disk9s1']]]) {
    assert.throws(() => assertReadOnlyCommand(c, a), /STORAGE_COMMAND_REFUSED/);
  }
});

test('Linux (fixture text): /proc/mounts + lsblk JSON → USB FAT, LUKS-encrypted ext4, read-only SD card; system mounts not offered', () => {
  const v = linuxVolumes({ procMounts: fx('linux-proc-mounts.txt'), lsblk: fx('linux-lsblk.json') });
  const by = Object.fromEntries(v.map((x) => [x.mountPoint, x]));
  assert.equal(by['/'].approvable, false); assert.equal(by['/boot/efi'].approvable, false);
  const usb = by['/media/robbie/KM USB'];
  assert.equal(usb.name, 'KM USB'); assert.deepEqual(usb.stableId, { kind: 'linux-fs-uuid', value: '5e21-9a0f' }); assert.equal(usb.removable, true);
  assert.equal(usb.capabilities.maxFileBytes, 4 * 2 ** 30 - 1); assert.equal(usb.approvable, true); assert.equal(usb.availableBytes, 31000000000);
  const vault = by['/media/robbie/VAULT'];
  assert.equal(vault.encrypted, true); assert.equal(vault.fsType, 'ext4'); assert.equal(vault.capabilities.symlinks, true); assert.equal(vault.removable, true);
  const sd = by['/media/robbie/SDCARD'];
  assert.equal(sd.readOnly, true); assert.equal(sd.fsType, 'exfat'); assert.equal(sd.bus, 'mmc');
});

test('Windows (fixture text): Get-Volume and Win32_Volume JSON → volume GUID / serial ids', () => {
  const v = windowsVolumes(fx('windows-get-volume.json'));
  assert.equal(v.length, 2);
  assert.deepEqual(v[1].stableId, { kind: 'win-volume-guid', value: '7e57d00d-1234-11ef-9a6b-806e6f6e6963' });
  assert.equal(v[1].mountPoint, 'E:\\'); assert.equal(v[1].removable, true); assert.equal(v[1].capabilities.maxFileBytes, 4 * 2 ** 30 - 1);
  assert.equal(v[0].fsType, 'ntfs'); assert.equal(v[0].removable, false);
  const w = windowsVolumes(fx('windows-win32-volume.json'));
  assert.equal(w.length, 1, 'a single ConvertTo-Json object is accepted');
  assert.deepEqual(w[0].stableId, { kind: 'win-volume-serial', value: 'AABBCCDD' }); assert.equal(w[0].fsType, 'exfat'); assert.equal(w[0].removable, true);
});

// ───────────── approval ─────────────
test('approval: only on explicit confirmation; no stable id, internal disks and unknown filesystems are refused', () => {
  const w = world();
  try {
    assert.throws(() => approveDrive({ state: w.state, volume: w.vol(), roles: ['user-methods'] }), /STORAGE_APPROVAL_REQUIRED/);
    assert.throws(() => approveDrive({ state: w.state, volume: w.vol({ stableId: null }), roles: ['user-methods'], confirm: true }), /STORAGE_NO_STABLE_ID/);
    assert.throws(() => approveDrive({ state: w.state, volume: w.vol({ internal: true }), roles: ['user-methods'], confirm: true }), /STORAGE_NOT_APPROVABLE.*internal/);
    assert.throws(() => approveDrive({ state: w.state, volume: w.vol({ fsType: 'zfs', fsName: 'ZFS' }), roles: ['user-methods'], confirm: true }), /STORAGE_NOT_APPROVABLE/);
    assert.throws(() => approveDrive({ state: w.state, volume: w.vol(), roles: ['everything'], confirm: true }), /STORAGE_UNKNOWN_ROLE/);
    assert.equal(existsSync(join(w.mount, 'Kingmaker')), false, 'nothing written to the drive before approval');
    assert.equal(existsSync(join(w.state, 'storage', 'drives.json')), false);
    const e = approveDrive({ state: w.state, volume: w.vol(), roles: ['user-methods', 'fleet-abilities', 'library-cache'], confirm: true });
    const reg = readRegistry(w.state);
    assert.equal(reg.drives.length, 1); assert.equal(reg.drives[0].key, `mac-volume-uuid:${UUID}`); assert.equal(reg.drives[0].label, 'KMUSB');
    assert.deepEqual(reg.drives[0].roles, ['user-methods', 'fleet-abilities', 'library-cache']);
    assert.match(e.root, /Kingmaker\/fi_[a-f0-9]{32}$/);
    for (const rel of [['abilities', 'methods'], ['fleet', 'abilities', 'methods'], ['brain-library', 'methods']]) assert(existsSync(join(e.root, ...rel)));
    assert.equal(existsSync(join(e.root, 'models')), false, 'only the approved roles get folders');
    assert.equal(JSON.parse(readFileSync(join(e.root, 'owner.json'), 'utf8')).installId, reg.drives[0].installId);
    assert.equal(typeof reg.drives[0].capabilities.probed.caseSensitive, 'boolean');
    // a second drive may not take a role the first holds (one location per role)
    assert.throws(() => approveDrive({ state: w.state, volume: w.vol({ stableId: { kind: 'mac-volume-uuid', value: 'OTHER' }, name: 'OTHER' }), roles: ['user-methods'], confirm: true }), /STORAGE_ROLE_TAKEN/);
  } finally { w.done(); }
});

test('another install\'s root is refused, and other users\' folders on the drive are never read or changed', () => {
  const w = world();
  try {
    const other = join(w.mount, 'Kingmaker', 'fi_0000000000000000000000000000beef');
    mkdirSync(join(other, 'abilities', 'methods'), { recursive: true }); writeFileSync(join(other, 'owner.json'), JSON.stringify({ installId: 'fi_0000000000000000000000000000beef' }));
    putStore(join(other, 'abilities', 'methods'), 'secret-diary', 'Secret diary');
    mkdirSync(join(w.mount, 'Photos')); writeFileSync(join(w.mount, 'Photos', 'a.jpg'), 'JPEGDATA');
    const before = treeHash(w.mount);
    const e = approveDrive({ state: w.state, volume: w.vol(), roles: ['user-methods'], confirm: true });
    const brain = createLocalBrain({ state: w.state, storage: resolveStorage({ state: w.state, volumes: [w.vol()] }), reasoner, methodHunt: false });
    return brain.loop.conductor.listMethods().then((ms) => {
      assert.equal(ms.some((m) => m.id === 'secret-diary'), false, 'another install\'s methods are not a layer');
      const after = treeHash(w.mount);
      for (const [p, h] of Object.entries(before)) assert.equal(after[p], h, `unchanged: ${p}`);
      // a root that claims to be ours but belongs to another install → refused
      writeFileSync(join(e.root, 'owner.json'), JSON.stringify({ installId: 'fi_someoneelse', driveKey: e.key }));
      const r = resolveStorage({ state: w.state, volumes: [w.vol()] });
      assert.equal(r.drives[0].status, 'not-owned'); assert.equal(r.roles['user-methods'].dir, null);
      assert.throws(() => approveDrive({ state: w.state, volume: w.vol(), roles: ['user-methods'], confirm: true }), /STORAGE_NOT_OWNED/);
    }).finally(() => w.done());
  } catch (e) { w.done(); throw e; }
});

// ───────────── save + retrieval through the normal path ─────────────
test('a user method written to the drive is found and run by the normal Kingmaker path (listMethods → conductor → report)', async () => {
  const w = world();
  try {
    approveDrive({ state: w.state, volume: w.vol(), roles: ['user-methods'], confirm: true });
    const storage = resolveStorage({ state: w.state, volumes: [w.vol()] });
    const dest = userMethodsDestination(w.state, { storage });
    assert.equal(dest.where, 'drive');
    const wr = await writeMethod({ task: 'convert miles to kilometres', sample: '5 miles', expect: '8.05 km', draft: proposal, reasoner, model: 'stub', userStore: dest.dir, put: dest.put, draftsDir: join(w.state, 'abilities', 'drafts') });
    assert.equal(wr.status, 'promoted', wr.reason);
    assert(wr.path.startsWith(w.mount)); assert.equal(existsSync(join(w.state, 'abilities', 'methods', 'index.json')), false, 'no internal copy');
    assert.equal(readdirSync(join(dest.root, JOURNAL_DIR)).length, 0, 'journal cleared after verified saves');
    assert.match(readFileSync(join(dest.dir, 'authored.jsonl'), 'utf8'), /my-convert-miles-to-kilometres/);
    const brain = createLocalBrain({ state: w.state, storage, reasoner });
    const ms = await brain.loop.conductor.listMethods();
    const mine = ms.find((m) => m.id === 'my-convert-miles-to-kilometres');
    assert.equal(mine.layer, 0); assert.equal(mine.store, dest.dir);
    const r = await handleMethodRequest('Kingmaker, convert 12 miles to kilometres', { brain, workDir: w.work('a'), inputs: { prompt: '12 miles', expect: '' } });
    assert.equal(r.outcome, 'completed', r.lines.join('\n')); assert.equal(r.method.layer, 'your abilities'); assert.equal(r.method.drive, 'KMUSB');
    assert.equal(r.outputs.answer, '19.31 km'); assert.equal(r.network.external, 0);
    assert.match(r.lines[0], /from your abilities on drive "KMUSB"/);
    // promoteDraft (Kingmaker-written methods) files to the same drive store
    const p = await promoteDraft({ state: w.state, storage, text: methodText('boat-heading', 'Boat heading'), checks: [{ set: 'heldout', total: 2, passed: 2 }] });
    assert(p.path.startsWith(dest.dir));
  } finally { w.done(); }
});

test('layer order: drive stores join the same layers (user > fleet > library > built-in); the drive copy of a user method wins', async () => {
  const w = world();
  try {
    const e = approveDrive({ state: w.state, volume: w.vol(), roles: ['user-methods', 'fleet-abilities', 'library-cache'], confirm: true });
    putStore(join(w.state, 'abilities', 'methods'), 'tide-table', 'Tide table (internal)');
    putStore(join(e.root, 'abilities', 'methods'), 'tide-table', 'Tide table (drive)');
    putStore(join(e.root, 'fleet', 'abilities', 'methods'), 'fleet-knot', 'Fleet knot');
    putStore(join(e.root, 'brain-library', 'methods'), 'sail-trim', 'Sail trim');
    const storage = resolveStorage({ state: w.state, volumes: [w.vol()] });
    assert.deepEqual(storageLayers(storage), { user: [join(e.root, 'abilities', 'methods')], fleet: [join(e.root, 'fleet', 'abilities', 'methods')], library: [join(e.root, 'brain-library', 'methods')] });
    const ms = await createLocalBrain({ state: w.state, storage, reasoner, methodHunt: false }).loop.conductor.listMethods();
    const by = Object.fromEntries(ms.map((m) => [m.id, m]));
    assert.equal(ms.filter((m) => m.id === 'tide-table').length, 1, 'no duplicate entries');
    assert.equal(by['tide-table'].title, 'Tide table (drive)'); assert.equal(by['tide-table'].layer, 0);
    assert.equal(by['fleet-knot'].layer, 1); assert.equal(by['sail-trim'].layer, 2);
    assert(ms.some((m) => m.layer === 3), 'built-in catalog still present');
  } finally { w.done(); }
});

test('a hunted curated method is filed on the drive\'s library cache — not on the internal disk', async () => {
  const w = world();
  try {
    const e = approveDrive({ state: w.state, volume: w.vol(), roles: ['library-cache'], confirm: true });
    const storage = resolveStorage({ state: w.state, volumes: [w.vol()] });
    let calls = 0;
    const methodHunt = async ({ request, storeDir }) => {
      calls += 1; putStore(storeDir, 'sail-race-pilot', 'Sail race pilot');
      writeFileSync(join(storeDir, 'acquired.jsonl'), '{"id":"sail-race-pilot"}\n');
      const buf = readFileSync(join(storeDir, 'sail-race-pilot.method.md'));
      return { status: 'acquired', id: 'sail-race-pilot', version: '1.0', url: 'fixture://library', size: buf.length, sha256: sha(buf), armor: { verdict: 'clean' }, need: request, storeDir };
    };
    const brain = createLocalBrain({ state: w.state, storage, reasoner, methodHunt });
    const r = await handleMethodRequest('run the sail race pilot', { brain, workDir: w.work('h'), inputs: { prompt: 'wind 180' } });
    assert.equal(calls, 1); assert.equal(r.outcome, 'completed', r.lines.join('\n'));
    assert.equal(r.method.layer, 'curated library'); assert.equal(r.method.drive, 'KMUSB');
    assert(existsSync(join(e.root, 'brain-library', 'methods', 'sail-race-pilot.method.md')));
    assert.match(readFileSync(join(e.root, 'brain-library', 'methods', 'acquired.jsonl'), 'utf8'), /sail-race-pilot/);
    assert.equal(existsSync(join(w.state, 'brain-library', 'methods', 'sail-race-pilot.method.md')), false, 'no internal duplicate');
    assert.deepEqual(readdirSync(join(w.state, 'storage', 'staging')), [], 'staging cleaned');
  } finally { w.done(); }
});

// ───────────── reconnect / missing / read-only ─────────────
test('reconnect under a changed mount path: recognized by stable id; a same-named volume with another or no id is NOT used', async () => {
  const w = world();
  try {
    const e = approveDrive({ state: w.state, volume: w.vol(), roles: ['user-methods'], confirm: true });
    putStore(join(e.root, 'abilities', 'methods'), 'tide-table', 'Tide table');
    const moved = join(w.base, 'Volumes', 'KMUSB 1'); renameSync(w.mount, moved); // macOS mounts a second "KMUSB" as "KMUSB 1"
    const impostor = join(w.base, 'Volumes', 'KMUSB'); mkdirSync(impostor);
    const vols = [w.vol({ mountPoint: impostor, stableId: { kind: 'mac-volume-uuid', value: 'DIFFERENT' } }), w.vol({ mountPoint: join(w.base, 'Volumes', 'NOID'), stableId: null }), w.vol({ mountPoint: moved })];
    const r = resolveStorage({ state: w.state, volumes: vols });
    assert.equal(r.drives[0].status, 'connected'); assert.equal(r.drives[0].mountPoint, moved);
    assert(r.notes.some((n) => /new mount path/.test(n)));
    assert(r.notes.some((n) => /identifier \(mac-volume-uuid:DIFFERENT\) is not the approved drive's — not used/.test(n)));
    assert.equal(readRegistry(w.state).drives[0].lastMount, moved);
    const ms = await createLocalBrain({ state: w.state, storage: r, reasoner, methodHunt: false }).loop.conductor.listMethods();
    assert.equal(ms.find((m) => m.id === 'tide-table').store, join(moved, 'Kingmaker', e.installId, 'abilities', 'methods'));
    // only the same-named volume without an id is mounted → refused rather than guessed
    const r2 = resolveStorage({ state: w.state, volumes: [w.vol({ mountPoint: impostor, stableId: null })] });
    assert.equal(r2.drives[0].status, 'missing'); assert(r2.notes.some((n) => /identifier is unavailable — refused rather than guessed/.test(n)));
  } finally { w.done(); }
});

test('missing drive: each unavailable resource is reported; local abilities keep working; no cloud fetch; no silent duplicate library', async () => {
  const w = world();
  try {
    approveDrive({ state: w.state, volume: w.vol(), roles: ['user-methods', 'library-cache', 'models'], confirm: true });
    putStore(join(w.state, 'fleet', 'abilities', 'methods'), 'tide-table', 'Tide table'); // an unrelated local ability
    const storage = resolveStorage({ state: w.state, volumes: [] });
    assert.deepEqual(storage.unavailable.map((u) => u.role).sort(), ['library-cache', 'models', 'user-methods']);
    assert.match(storage.unavailable[0].reason, /drive "KMUSB" is not connected/);
    let hunts = 0;
    const brain = createLocalBrain({ state: w.state, storage, reasoner, methodHunt: async () => { hunts += 1; return { status: 'acquired' }; } });
    const ok = await handleMethodRequest('run the tide table', { brain, workDir: w.work('t'), inputs: { prompt: 'Boston' } });
    assert.equal(ok.outcome, 'completed', ok.lines.join('\n')); assert.equal(ok.method.layer, 'fleet abilities');
    assert(ok.lines.some((l) => /^Unavailable: your own methods — drive "KMUSB" is not connected\. Local abilities still work; nothing was fetched from a paid service instead\.$/.test(l)));
    const miss = await handleMethodRequest('run the sail race pilot', { brain, workDir: w.work('s'), inputs: { prompt: 'x' } });
    assert.equal(miss.outcome, 'refused'); assert.equal(hunts, 0, 'the curated hunt is not run while its cache drive is missing');
    assert.match(miss.hunt.detail, /assigned to drive "KMUSB".*no second copy was made on this Mac/);
    assert.equal(miss.network.external, 0);
    assert.equal(existsSync(join(w.state, 'brain-library', 'methods')), false, 'no internal library created');
    assert.throws(() => userMethodsDestination(w.state, { storage }), /STORAGE_UNAVAILABLE/);
    await assert.rejects(promoteDraft({ state: w.state, storage, text: methodText('boat-heading', 'Boat heading'), checks: [{ set: 'heldout', total: 1, passed: 1 }] }), /STORAGE_UNAVAILABLE/);
    assert.equal(existsSync(join(w.state, 'abilities', 'methods')), false, 'no internal user library created');
    const m = modelsLocation({ resolved: storage, env: {}, defaultDir: '/Users/x/.ollama/models' });
    assert.equal(m.dir, null); assert.equal(m.fallback, '/Users/x/.ollama/models'); assert.match(m.note, /Nothing is downloaded/);
  } finally { w.done(); }
});

test('read-only drive: its methods are still read; every save is refused and reported', async () => {
  const w = world();
  try {
    const e = approveDrive({ state: w.state, volume: w.vol(), roles: ['user-methods'], confirm: true });
    putStore(join(e.root, 'abilities', 'methods'), 'tide-table', 'Tide table');
    const storage = resolveStorage({ state: w.state, volumes: [w.vol({ readOnly: true })] });
    assert.equal(storage.drives[0].status, 'read-only'); assert.equal(storage.roles['user-methods'].writable, false);
    assert.match(storage.unavailable[0].what, /^saving your own methods/);
    const ms = await createLocalBrain({ state: w.state, storage, reasoner, methodHunt: false }).loop.conductor.listMethods();
    assert(ms.some((m) => m.id === 'tide-table'));
    assert.throws(() => userMethodsDestination(w.state, { storage }), /STORAGE_UNAVAILABLE.*read-only/);
    // approving a read-only volume with no Kingmaker folder writes nothing
    const w2 = world();
    try { assert.throws(() => approveDrive({ state: w2.state, volume: w2.vol({ readOnly: true }), roles: ['user-methods'], confirm: true }), /STORAGE_READ_ONLY/); assert.deepEqual(readdirSync(w2.mount), []); }
    finally { w2.done(); }
  } finally { w.done(); }
});

// ───────────── saves: interruption, recovery, limits ─────────────
test('interrupted save (in-process fault): the old file is intact, and recovery on the next start removes the temp', async () => {
  const w = world();
  try {
    const e = approveDrive({ state: w.state, volume: w.vol(), roles: ['user-methods'], confirm: true });
    const dest = join(e.root, 'abilities', 'methods', 'index.json');
    await safeWriteFile(dest, 'ORIGINAL', { root: e.root });
    await assert.rejects(safeWriteFile(dest, 'NEW CONTENT', { root: e.root, fault: async (stage) => { if (stage === 'before-rename') throw new Error('power cut'); } }), /power cut/);
    assert.equal(readFileSync(dest, 'utf8'), 'ORIGINAL');
    assert.equal(readdirSync(join(e.root, JOURNAL_DIR)).length, 1);
    assert(readdirSync(join(e.root, 'abilities', 'methods')).some((n) => n.includes('.km-tmp-')));
    const r = resolveStorage({ state: w.state, volumes: [w.vol()] }); // "next start"
    assert.equal(r.recovered.length, 1); assert.match(r.recovered[0].outcome, /rolled-back.*previous file is intact/);
    assert.deepEqual(readdirSync(join(e.root, JOURNAL_DIR)), []);
    assert.deepEqual(readdirSync(join(e.root, 'abilities', 'methods')), ['index.json']);
    assert.equal(readFileSync(dest, 'utf8'), 'ORIGINAL');
  } finally { w.done(); }
});

test('interrupted save (process killed with SIGKILL mid-transfer): no corrupt final file; recovery cleans up', () => {
  const w = world();
  try {
    const e = approveDrive({ state: w.state, volume: w.vol(), roles: ['user-methods'], confirm: true });
    const dest = join(e.root, 'abilities', 'methods', 'big.method.md');
    const lib = new URL('../lib/external-storage.mjs', import.meta.url).href;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const { safeWriteFile } = await import(${JSON.stringify(lib)});
      await safeWriteFile(${JSON.stringify(dest)}, Buffer.alloc(4 << 20, 7), { root: ${JSON.stringify(e.root)}, fault: async (s) => { if (s === 'after-temp-write') process.kill(process.pid, 'SIGKILL'); } });
    `], { encoding: 'utf8' });
    assert.equal(child.signal, 'SIGKILL');
    assert.equal(existsSync(dest), false, 'no final file appeared');
    const r = recoverDrive(e.root);
    assert.equal(r.length, 1); assert.match(r[0].outcome, /rolled-back.*no final file was created/);
    assert.deepEqual(readdirSync(join(e.root, 'abilities', 'methods')), []);
    // a crash AFTER the rename but before the journal was cleared → verified as completed
    writeFileSync(join(e.root, 'abilities', 'methods', 'done.txt'), 'DONE');
    writeFileSync(join(e.root, JOURNAL_DIR, 'x.json'), JSON.stringify({ op: 'write', dest: 'abilities/methods/done.txt', temp: 'abilities/methods/.done.txt.km-tmp-x', sha256: sha('DONE'), bytes: 4, pid: 999999 }));
    assert.match(recoverDrive(e.root)[0].outcome, /completed/);
  } finally { w.done(); }
});

test('limits: capacity, file size (FAT32 4 GiB), symlink destination and paths outside the root are refused before writing', async () => {
  const w = world();
  try {
    const fat = w.vol({ fsType: 'msdos', fsName: 'MS-DOS FAT32' });
    const e = approveDrive({ state: w.state, volume: fat, roles: ['user-methods', 'models'], confirm: true });
    const storage = resolveStorage({ state: w.state, volumes: [fat] });
    const t = writeTarget(storage, 'user-methods', null);
    assert.equal(t.maxFileBytes, 4 * 2 ** 30 - 1, 'the FAT32 limit travels with the write target');
    const dir = join(e.root, 'abilities', 'methods');
    await assert.rejects(safeWriteFile(join(dir, 'a.bin'), Buffer.alloc(2048), { root: e.root, maxFileBytes: 1024 }), /STORAGE_FILE_TOO_LARGE/);
    await assert.rejects(safeWriteFile(join(dir, 'a.bin'), Buffer.alloc(2048), { root: e.root, statfsImpl: async () => ({ bavail: 10, bsize: 4096 }) }), /STORAGE_NO_SPACE/);
    symlinkSync('/etc/hosts', join(dir, 'link.md'));
    await assert.rejects(safeWriteFile(join(dir, 'link.md'), 'x', { root: e.root }), /STORAGE_SYMLINK_REFUSED/);
    await assert.rejects(safeWriteFile(join(w.mount, 'Photos', 'x'), 'x', { root: e.root }), /STORAGE_OUTSIDE_ROOT/);
    assert.deepEqual(readdirSync(dir), ['link.md'], 'no temp, no partial file');
    assert.equal(existsSync(join(e.root, JOURNAL_DIR)) ? readdirSync(join(e.root, JOURNAL_DIR)).length : 0, 0);
    const m = modelsLocation({ resolved: storage, env: {}, defaultDir: '/x' });
    assert.equal(m.dir, join(e.root, 'models')); assert.match(m.config, /^OLLAMA_MODELS=/); assert.match(m.note, /has not changed the live Ollama configuration/); assert.match(m.note, /cannot hold a model file of 4294967296 bytes/);
  } finally { w.done(); }
});

test('copy to a drive is verified and preserves the internal originals; a conflicting file on the drive is left alone', async () => {
  const w = world();
  try {
    const e = approveDrive({ state: w.state, volume: w.vol(), roles: ['user-methods'], confirm: true });
    const internal = join(w.state, 'abilities', 'methods');
    putStore(internal, 'tide-table', 'Tide table'); putStore(internal, 'knot-tying', 'Knot tying');
    writeFileSync(join(e.root, 'abilities', 'methods', 'knot-tying.method.md'), 'SOMETHING ELSE');
    const before = treeHash(internal);
    const t = writeTarget(resolveStorage({ state: w.state, volumes: [w.vol()] }), 'user-methods', internal);
    const out = await copyStoreToDrive({ from: internal, target: t });
    assert.deepEqual(out.copied.map((c) => c.id), ['tide-table']); assert.deepEqual(out.conflicts.map((c) => c.id), ['knot-tying']); assert.equal(out.verified, true);
    assert.deepEqual(treeHash(internal), before, 'originals untouched');
    assert.equal(readFileSync(join(e.root, 'abilities', 'methods', 'knot-tying.method.md'), 'utf8'), 'SOMETHING ELSE');
  } finally { w.done(); }
});

test('safe-eject awareness: open handles and unfinished saves are reported; nothing is unmounted', () => {
  const w = world();
  try {
    const e = approveDrive({ state: w.state, volume: w.vol(), roles: ['user-methods'], confirm: true });
    const seen = [];
    const run = (cmd, args) => { assertReadOnlyCommand(cmd, args); seen.push(cmd); return 'p4242\ncPreview\nn/Volumes/KMUSB/doc.pdf\n'; };
    const busy = ejectReadiness({ mountPoint: w.mount, root: e.root, run });
    assert.equal(busy.safeToEject, false); assert.deepEqual(busy.openHandles, [{ pid: 4242, command: 'Preview', name: '/Volumes/KMUSB/doc.pdf' }]);
    assert.deepEqual(seen, ['lsof']); assert.match(busy.note, /never force-unmounts/);
    mkdirSync(join(e.root, JOURNAL_DIR), { recursive: true }); writeFileSync(join(e.root, JOURNAL_DIR, 'p.json'), '{}');
    const pend = ejectReadiness({ mountPoint: w.mount, root: e.root, run: () => '' });
    assert.equal(pend.safeToEject, false); assert.deepEqual(pend.unfinishedJournal, ['p.json']);
    rmSync(join(e.root, JOURNAL_DIR, 'p.json'));
    assert.equal(ejectReadiness({ mountPoint: w.mount, root: e.root, run: () => '' }).safeToEject, true);
    assert.deepEqual(parseLsofF(''), []);
  } finally { w.done(); }
});

test('no drives.json → nothing is discovered and the brain is unchanged', () => {
  const w = world();
  try {
    let discovered = 0;
    const r = resolveStorage({ state: w.state, discover: () => { discovered += 1; return []; } });
    assert.equal(r.configured, false); assert.equal(discovered, 0);
    assert.equal(createLocalBrain({ state: w.state, reasoner, methodHunt: false }).storage.configured, false);
    assert.equal(driveRootOf('/Volumes/X', 'fi_1'), '/Volumes/X/Kingmaker/fi_1');
  } finally { w.done(); }
});
