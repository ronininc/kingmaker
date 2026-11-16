// The remaining write paths routed through approved external storage (lib/external-storage.mjs), on ISOLATED fixtures:
// temp directories stand in for mount points (the real exFAT/FAT32 run is test/external-storage-routes-image.test.mjs).
//   memory     the engine's data folder (SOLOMON_DATA_DIR) — exercised through startBackend with a STAND-IN engine
//              (test/fixtures/external-storage/stub-engine.mjs) that opens <data>/sqlite/solomon.db exactly where the
//              engine's getDataRoot would; the real engine is never started here.
//   files      kingmakerHome / homeFolder / saveHomeFile / listArtifacts / reportsDir / tidyDesktop.
//   fleet      acceptAbilityRelease / applyRevocations (signed releases from the real ability pipeline).
//   iteration  createLocalBrain({ iterate: true }) → iterateMethod into the store the method came from.
// For each: save + retrieval through the normal path, reconnect under a changed mount path, missing drive, read-only
// drive, interrupted write + recovery, preservation of existing files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  approveDrive, clearStorageCache, copyTreeToDrive, describeVolume, engineMemoryLocation, recoverDrive, resolveStorage, resolveStorageCached,
  safeWriteFile, writeTarget, JOURNAL_DIR,
} from '../lib/external-storage.mjs';
import { startBackend, startBlockers } from '../lib/runtime.mjs';
import { resolvePaths } from '../lib/paths.mjs';
import { homeFolder, kingmakerHome, kingmakerHomePath, saveHomeFile, tidyDesktop } from '../lib/kingmaker-home.mjs';
import { listArtifacts } from '../lib/artifacts.mjs';
import { reportsDir } from '../lib/evidence.mjs';
import { acceptAbilityRelease, applyRevocations, approveAbility, createOwnerAuthority, pinOwnerTrust, proposeAbility, reviewProposal, revokeAbility } from '../lib/ability-pipeline.mjs';
import { FLEET_DISCLOSURE_DIGEST, BOX_WORDING_VERSION } from '../lib/sharing.mjs';
import { createLocalBrain, handleMethodRequest } from '../lib/method-request.mjs';
import { iterateMethod, methodStoreIndexUrl } from '../lib/method-iteration.mjs';

const STUB = fileURLToPath(new URL('./fixtures/external-storage/stub-engine.mjs', import.meta.url));
const LIB = new URL('../lib/external-storage.mjs', import.meta.url).href;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const UUID = 'CDF24AEF-BA6E-364B-AA29-AB5F032396F8';
const treeHash = (dir) => { const out = {}; const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else out[p.slice(dir.length)] = sha(readFileSync(p)); } }; walk(dir); return out; };
const noTemps = (dir) => !Object.keys(treeHash(dir)).some((p) => p.includes('.km-tmp-'));

function world() {
  const base = mkdtempSync(join(tmpdir(), 'km-ext-routes-'));
  const state = join(base, 'state'); mkdirSync(state, { recursive: true });
  const mount = join(base, 'Volumes', 'KMUSB'); mkdirSync(mount, { recursive: true });
  // something of the owner's already on the drive: must never change
  mkdirSync(join(mount, 'Photos')); writeFileSync(join(mount, 'Photos', 'a.jpg'), 'JPEGDATA');
  const vol = (over = {}) => describeVolume({ platform: 'darwin', name: 'KMUSB', mountPoint: mount, device: '/dev/disk9s1', fsType: 'exfat', fsName: 'ExFAT', totalBytes: 64 << 20, availableBytes: 60 << 20, readOnly: false, removable: true, internal: false, encrypted: null, stableId: { kind: 'mac-volume-uuid', value: UUID }, bus: 'USB', ...over });
  const moveMount = () => { const moved = join(base, 'Volumes', 'KMUSB 1'); renameSync(mount, moved); return moved; };
  const work = (n) => { const d = join(base, 'tasks', n); mkdirSync(d, { recursive: true }); return d; };
  const env = { SOL_GHOST_HOME: state, HOME: base };
  return { base, state, mount, vol, moveMount, work, env, done: () => { clearStorageCache(); rmSync(base, { recursive: true, force: true }); } };
}
const killChild = (code) => spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });

// ═════════════════════════════ memory (the engine's MemPalace data folder) ═════════════════════════════
function engine(w) {
  const env = { HOME: w.base, PATH: process.env.PATH, SOL_GHOST_HOME: w.state };
  const p = resolvePaths(env, w.base);
  return { env, paths: { ...p, runtimeSource: 'bundle', binary: process.execPath, headlessEntry: STUB } };
}
async function engineRun({ paths, env }, storage, remember = null) {
  const b = await startBackend({ paths, port: 0, secrets: { nonce: 'n'.repeat(64), voiceKey: 'v'.repeat(64) }, env: { ...env, ...(remember ? { STUB_REMEMBER: remember } : {}) }, storage });
  await b.ready;
  const ex = await b.exited;
  assert.equal(ex.code, 0);
  await new Promise((r) => setTimeout(r, 100)); // the log stream flushes after exit
  const line = readFileSync(b.logPath, 'utf8').split('\n').find((l) => l.startsWith('STUB_MEMORY '));
  assert(line, readFileSync(b.logPath, 'utf8'));
  return { ...JSON.parse(line.slice('STUB_MEMORY '.length)), backendEnv: b.backendEnv };
}

test('memory: the engine opens its memory on the drive; a second engine start retrieves it; a changed mount path is followed', async () => {
  const w = world();
  try {
    const before = sha(readFileSync(join(w.mount, 'Photos', 'a.jpg')));
    const e = approveDrive({ state: w.state, volume: w.vol(), roles: ['memory'], confirm: true });
    const eng = engine(w);
    let storage = resolveStorage({ state: w.state, volumes: [w.vol()] });
    const r1 = await engineRun(eng, storage, 'the boat is blue');
    assert.equal(r1.data, join(e.root, 'memory')); assert.equal(r1.backendEnv.SOLOMON_DATA_DIR, join(e.root, 'memory'));
    assert.deepEqual(r1.rows, ['the boat is blue']);
    assert(existsSync(join(e.root, 'memory', 'sqlite', 'solomon.db')));
    assert.equal(existsSync(join(eng.paths.runtimeHome, 'data', 'sqlite')), false, 'no memory store on this Mac');
    assert.equal(r1.backendEnv.SOLOMON_INDEX_DIR, join(eng.paths.runtimeHome, 'data', 'knowledge', 'index'), 'the knowledge library stays on this Mac');
    assert.equal(r1.backendEnv.SOLOMON_SECURE_ROOT, join(w.base, '.solomon-secure'), 'keys stay on this Mac (test HOME)');
    const r2 = await engineRun(eng, storage);
    assert.deepEqual(r2.rows, ['the boat is blue'], 'retrieved by a new engine process');
    // reconnect under a changed mount path
    const moved = w.moveMount();
    storage = resolveStorage({ state: w.state, volumes: [w.vol({ mountPoint: moved })] });
    const r3 = await engineRun(eng, storage, 'second');
    assert.equal(r3.data, join(moved, 'Kingmaker', e.installId, 'memory'));
    assert.deepEqual(r3.rows, ['the boat is blue', 'second']);
    assert.equal(sha(readFileSync(join(moved, 'Photos', 'a.jpg'))), before, 'pre-existing data on the drive untouched');
  } finally { w.done(); }
});

test('memory: missing or read-only drive → "Unavailable: memory", the engine is not started and no internal memory store is created', async () => {
  const w = world();
  try {
    approveDrive({ state: w.state, volume: w.vol(), roles: ['memory'], confirm: true });
    const eng = engine(w);
    const quiet = { desktopPid: () => null, otherHeadless: () => null, isPortFree: async () => true, exists: () => true };
    for (const [storage, why] of [[resolveStorage({ state: w.state, volumes: [] }), /not connected/], [resolveStorage({ state: w.state, volumes: [w.vol({ readOnly: true })] }), /read-only/]]) {
      assert.equal(engineMemoryLocation({ state: w.state, internalDir: join(eng.paths.runtimeHome, 'data'), storage }).where, 'refused');
      await assert.rejects(startBackend({ paths: eng.paths, port: 0, secrets: { nonce: 'n', voiceKey: 'v' }, env: eng.env, storage }), (err) => {
        assert.match(err.message, /^STORAGE_UNAVAILABLE: Unavailable: memory — it is assigned to drive "KMUSB"/); assert.match(err.message, why);
        assert.match(err.message, /no second memory store was created on this Mac/); return true;
      });
      const blockers = await startBlockers(eng.paths, 0, { ...quiet, env: eng.env, storage });
      assert(blockers.some((b) => /^Unavailable: memory/.test(b)), blockers.join('\n'));
    }
    assert.equal(existsSync(join(eng.paths.runtimeHome, 'data')), false, 'no internal data folder');
    assert.equal(existsSync(eng.paths.logs), false, 'nothing was spawned (no server log)');
  } finally { w.done(); }
});

test('memory: an uncopied memory is refused, an interrupted copy leaves no half database, the verified copy keeps this Mac\'s original', async () => {
  const w = world();
  try {
    const eng = engine(w);
    const internal = join(eng.paths.runtimeHome, 'data');
    const r0 = await engineRun(eng, undefined, 'remembered on this Mac'); // no drive approved yet: internal, as before
    assert.equal(r0.data, internal);
    const original = treeHash(join(internal, 'sqlite'));
    const e = approveDrive({ state: w.state, volume: w.vol(), roles: ['memory'], confirm: true });
    const storage = resolveStorage({ state: w.state, volumes: [w.vol()] });
    await assert.rejects(startBackend({ paths: eng.paths, port: 0, secrets: { nonce: 'n', voiceKey: 'v' }, env: eng.env, storage }), /has no memory database yet.*kingmaker storage copy memory/);
    const t = writeTarget(storage, 'memory', null);
    const target = { ...t, dir: join(t.dir, 'sqlite') };
    // interrupted copy: the process is killed between the temp write and the rename
    const child = killChild(`const { copyTreeToDrive } = await import(${JSON.stringify(LIB)}); await copyTreeToDrive({ from: ${JSON.stringify(join(internal, 'sqlite'))}, target: ${JSON.stringify({ dir: target.dir, root: target.root })}, fault: async (s) => { if (s === 'after-temp-write') process.kill(process.pid, 'SIGKILL'); } });`);
    assert.equal(child.signal, 'SIGKILL');
    assert.equal(existsSync(join(target.dir, 'solomon.db')), false, 'no partial database appeared');
    assert.equal(engineMemoryLocation({ state: w.state, internalDir: internal, storage }).where, 'refused', 'still refused after the interruption');
    const rec = recoverDrive(e.root);
    assert(rec.some((x) => /rolled-back/.test(x.outcome))); assert.deepEqual(readdirSync(join(e.root, JOURNAL_DIR)), []); assert(noTemps(e.root));
    // the verified copy
    const out = await copyTreeToDrive({ from: join(internal, 'sqlite'), target });
    assert.equal(out.verified, true); assert(out.copied.some((c) => c.path === 'solomon.db')); assert.deepEqual(out.conflicts, []);
    assert.deepEqual(treeHash(join(internal, 'sqlite')), original, 'this Mac\'s memory is preserved, byte for byte');
    const r1 = await engineRun(eng, storage, 'remembered on the drive');
    assert.equal(r1.data, join(e.root, 'memory')); assert.deepEqual(r1.rows, ['remembered on this Mac', 'remembered on the drive']);
    assert.deepEqual(treeHash(join(internal, 'sqlite')), original, 'the original was not written to after the move');
  } finally { w.done(); }
});

// ═════════════════════════════ files (Kingmaker's Files folder) ═════════════════════════════
const primeFiles = (w, volumes) => resolveStorageCached({ state: w.state, volumes, ttlMs: 60_000 });

test('files: saved to the drive and found through the normal path (homeFolder, listArtifacts, reports); a changed mount path is followed', async () => {
  const w = world();
  try {
    const e = approveDrive({ state: w.state, volume: w.vol(), roles: ['files'], confirm: true });
    primeFiles(w, [w.vol()]);
    const files = join(e.root, 'files');
    assert.equal(kingmakerHome(w.env, w.base), files);
    assert.equal(kingmakerHome({ ...w.env, KINGMAKER_HOME: join(w.base, 'elsewhere') }, w.base), files, 'the approved drive wins over KINGMAKER_HOME');
    assert.equal(homeFolder('pictures', { env: w.env, home: w.base }), join(files, 'Pictures'));
    const saved = await saveHomeFile('documents', 'note.txt', 'hello drive', { env: w.env, home: w.base });
    assert.equal(saved, join(files, 'Documents', 'note.txt')); assert.deepEqual(readdirSync(join(e.root, JOURNAL_DIR)), [], 'verified save, journal cleared');
    assert(listArtifacts({ home: w.base, env: w.env }).some((a) => a.path === saved && a.where === 'Kingmaker'), 'listed under Artifacts');
    assert.equal(reportsDir(w.env, w.base), join(files, 'Reports'));
    assert.equal(existsSync(join(w.state, 'Files')), false, 'no internal Files folder');
    const moved = w.moveMount();
    primeFiles(w, [w.vol({ mountPoint: moved })]);
    const there = join(moved, 'Kingmaker', e.installId, 'files');
    assert.equal(kingmakerHome(w.env, w.base), there);
    assert.equal(readFileSync(join(there, 'Documents', 'note.txt'), 'utf8'), 'hello drive');
  } finally { w.done(); }
});

test('files: missing drive → explicit unavailable everywhere; nothing is made on this Mac; Desktop tidy-up skipped', async () => {
  const w = world();
  try {
    const e = approveDrive({ state: w.state, volume: w.vol(), roles: ['files'], confirm: true });
    mkdirSync(join(w.base, 'Desktop')); writeFileSync(join(w.base, 'Desktop', 'Kingmaker Ad 1.mp4'), 'MP4');
    primeFiles(w, []);
    assert.throws(() => kingmakerHome(w.env, w.base), /STORAGE_UNAVAILABLE: Unavailable: your files — they are assigned to drive "KMUSB": drive "KMUSB" is not connected.*no second Files folder/);
    assert.throws(() => homeFolder('documents', { env: w.env, home: w.base }), /STORAGE_UNAVAILABLE/);
    await assert.rejects(saveHomeFile('documents', 'x.txt', 'x', { env: w.env, home: w.base }), /STORAGE_UNAVAILABLE/);
    assert.equal(kingmakerHomePath(w.env, w.base), join(e.root, 'files'), 'settings for the engine name the drive, not an internal stand-in');
    assert.doesNotThrow(() => listArtifacts({ home: w.base, env: w.env }));
    assert.deepEqual(tidyDesktop({ env: w.env, home: w.base }), []);
    assert(existsSync(join(w.base, 'Desktop', 'Kingmaker Ad 1.mp4')), 'Desktop file left where it is');
    assert.equal(existsSync(join(w.state, 'Files')), false, 'no internal Files folder created');
  } finally { w.done(); }
});

test('files: read-only drive → readable, every save refused; interrupted save → old file intact, recovered on the next start', async () => {
  const w = world();
  try {
    const e = approveDrive({ state: w.state, volume: w.vol(), roles: ['files'], confirm: true });
    primeFiles(w, [w.vol()]);
    const note = await saveHomeFile('documents', 'note.txt', 'ORIGINAL', { env: w.env, home: w.base });
    primeFiles(w, [w.vol({ readOnly: true })]);
    assert.equal(readFileSync(join(kingmakerHome(w.env, w.base), 'Documents', 'note.txt'), 'utf8'), 'ORIGINAL');
    assert.throws(() => homeFolder('documents', { env: w.env, home: w.base }), /STORAGE_UNAVAILABLE: Unavailable: saving your files — drive "KMUSB" is mounted read-only/);
    await assert.rejects(saveHomeFile('documents', 'note.txt', 'NEW', { env: w.env, home: w.base }), /read-only/);
    assert.equal(homeFolder('documents', { env: w.env, home: w.base, make: false }), join(e.root, 'files', 'Documents'));
    // interrupted save (killed before the rename)
    const child = killChild(`const { safeWriteFile } = await import(${JSON.stringify(LIB)}); await safeWriteFile(${JSON.stringify(note)}, Buffer.alloc(1 << 20, 9), { root: ${JSON.stringify(e.root)}, fault: async (s) => { if (s === 'before-rename') process.kill(process.pid, 'SIGKILL'); } });`);
    assert.equal(child.signal, 'SIGKILL');
    assert.equal(readFileSync(note, 'utf8'), 'ORIGINAL');
    const r = resolveStorage({ state: w.state, volumes: [w.vol()] }); // next start
    assert.match(r.recovered[0].outcome, /rolled-back.*previous file is intact/); assert(noTemps(e.root));
  } finally { w.done(); }
});

test('files: copying this Mac\'s Files folder to the drive is verified, keeps the originals, and leaves a conflicting drive file alone', async () => {
  const w = world();
  try {
    const internal = join(w.state, 'Files');
    mkdirSync(join(internal, 'Documents'), { recursive: true }); writeFileSync(join(internal, 'Documents', 'old.txt'), 'OLD');
    writeFileSync(join(internal, 'Documents', 'clash.txt'), 'MAC');
    const before = treeHash(internal), photos = treeHash(join(w.mount, 'Photos'));
    const e = approveDrive({ state: w.state, volume: w.vol(), roles: ['files'], confirm: true });
    mkdirSync(join(e.root, 'files', 'Documents'), { recursive: true }); writeFileSync(join(e.root, 'files', 'Documents', 'clash.txt'), 'DRIVE');
    const out = await copyTreeToDrive({ from: internal, target: writeTarget(resolveStorage({ state: w.state, volumes: [w.vol()] }), 'files', internal) });
    assert.deepEqual(out.copied.map((c) => c.path), [join('Documents', 'old.txt')]); assert.deepEqual(out.conflicts.map((c) => c.path), [join('Documents', 'clash.txt')]);
    assert.equal(out.verified, true);
    assert.deepEqual(treeHash(internal), before, 'originals untouched'); assert.deepEqual(treeHash(join(w.mount, 'Photos')), photos);
    assert.equal(readFileSync(join(e.root, 'files', 'Documents', 'clash.txt'), 'utf8'), 'DRIVE');
  } finally { w.done(); }
});

// ═════════════════════════════ fleet abilities ═════════════════════════════
const fleetMethod = (id = 'tide-table-summary') => `# Method\n\n\`\`\`kingmaker-method\n${JSON.stringify({ id, version: '1.0', title: 'Tide table summary', domain: 'tides', inputs: { prompt: '', expect: '' }, weights: { role: 'writer' },
  steps: [{ n: 1, id: 'solve', type: 'reason', into: 'answer', preamble: 'Summarize the tide table in one line.', prompt: '{{inputs.prompt}}' }, { n: 2, id: 'record', type: 'render', path: 'answer.txt', template: '{{answer}}' },
    { n: 3, id: 'receipt', type: 'write-json', path: 'r.json', value: { method: id } }, { n: 4, id: 'check', type: 'verify', assertions: [{ file: 'r.json', field: 'method', equals: id }, { file: 'answer.txt', contains: '{{inputs.expect}}' }] }] }, null, 2)}\n\`\`\`\n`;
const tideReasoner = async ({ prompt }) => `Tides: high and low — ${prompt}`;
async function signedRelease(w) {
  const owner = join(w.base, 'owner'), a = join(w.base, 'install-a');
  mkdirSync(join(a, 'fleet'), { recursive: true });
  writeFileSync(join(a, 'fleet', 'sharing.json'), JSON.stringify({ on: true, shown: true, at: 'x', by: 'owner', how: 'box: share', wording: BOX_WORDING_VERSION, disclosureDigest: FLEET_DISCLOSURE_DIGEST }));
  writeFileSync(join(a, 'fleet', 'install-id'), 'synthetic-install-a\n');
  const ownerDir = join(owner, 'owner-authority');
  const trust = createOwnerAuthority(ownerDir); pinOwnerTrust(w.state, trust);
  const prop = proposeAbility({ state: a, methodText: fleetMethod(), rights: { source: 'own-work', attested: true, testInput: { prompt: 'high 06:10 2.1m, low 12:20 0.3m', expect: 'high' } } });
  const ev = await reviewProposal(prop.bundle, { reasoner: tideReasoner });
  assert.equal(ev.passed, true);
  return { release: approveAbility({ bundle: prop.bundle, evidence: ev, ownerDir }), ownerDir };
}

test('fleet abilities: accepted onto the drive (verified), run from the fleet layer there; reconnect at a new path; revocation quarantines on the drive', async () => {
  const w = world();
  try {
    const { release, ownerDir } = await signedRelease(w);
    const e = approveDrive({ state: w.state, volume: w.vol(), roles: ['fleet-abilities'], confirm: true });
    let storage = resolveStorage({ state: w.state, volumes: [w.vol()] });
    const acc = acceptAbilityRelease({ state: w.state, release, storage });
    assert.equal(acc.status, 'accepted', acc.reason); assert.equal(acc.drive, 'KMUSB');
    const store = join(e.root, 'fleet', 'abilities', 'methods');
    assert.equal(acc.path, join(store, 'tide-table-summary.method.md'));
    assert.deepEqual(readdirSync(join(e.root, JOURNAL_DIR)), []);
    assert.equal(existsSync(join(w.state, 'fleet', 'abilities')), false, 'no internal fleet store');
    assert.match(readFileSync(join(w.state, 'fleet', 'accepted.jsonl'), 'utf8'), /"drive":"KMUSB"/, 'the acceptance receipt stays with this install');
    const r = await handleMethodRequest('Kingmaker, run the tide table summary', { brain: createLocalBrain({ state: w.state, remote: false, reasoner: tideReasoner, storage }), workDir: w.work('f1'), inputs: { prompt: 'high 05:00', expect: '' } });
    assert.equal(r.outcome, 'completed', r.lines.join('\n')); assert.equal(r.method.layer, 'fleet abilities'); assert.equal(r.method.drive, 'KMUSB');
    // a second acceptance keeps the prior version beside it (preservation), on the drive
    assert.equal(acceptAbilityRelease({ state: w.state, release, storage }).status, 'accepted');
    assert(existsSync(join(store, 'tide-table-summary.prev.method.md')));
    // reconnect under a changed mount path, then revoke
    const moved = w.moveMount();
    storage = resolveStorage({ state: w.state, volumes: [w.vol({ mountPoint: moved })] });
    const rev = revokeAbility({ id: 'tide-table-summary', version: '1.0', reason: 'test', ownerDir });
    const q = applyRevocations({ state: w.state, revocations: [rev], storage });
    assert.deepEqual(q.map((x) => [x.quarantined, x.drive]), [[true, 'KMUSB']]);
    const movedRoot = join(moved, 'Kingmaker', e.installId);
    assert(existsSync(join(movedRoot, 'fleet', 'quarantine', 'tide-table-summary-1.0.method.md')), 'quarantined on the same drive');
    assert.deepEqual(JSON.parse(readFileSync(join(movedRoot, 'fleet', 'abilities', 'methods', 'index.json'), 'utf8')).methods, []);
    assert.equal(existsSync(join(w.state, 'fleet', 'quarantine')), false);
    assert.equal(readFileSync(join(moved, 'Photos', 'a.jpg'), 'utf8'), 'JPEGDATA');
  } finally { w.done(); }
});

test('fleet abilities: missing or read-only drive → refused, nothing written on this Mac; interrupted save → index intact, recovered', async () => {
  const w = world();
  try {
    const { release, ownerDir } = await signedRelease(w);
    const e = approveDrive({ state: w.state, volume: w.vol(), roles: ['fleet-abilities'], confirm: true });
    for (const [vols, why] of [[[], /not connected/], [[w.vol({ readOnly: true })], /read-only/]]) {
      const storage = resolveStorage({ state: w.state, volumes: vols });
      const acc = acceptAbilityRelease({ state: w.state, release, storage });
      assert.equal(acc.status, 'refused'); assert.match(acc.reason, /^STORAGE_UNAVAILABLE: owner-approved fleet abilities are assigned to drive "KMUSB"/); assert.match(acc.reason, why);
      const rev = revokeAbility({ id: 'tide-table-summary', version: '1.0', reason: 'test', ownerDir });
      const q = applyRevocations({ state: w.state, revocations: [rev], storage });
      assert.equal(q[0].quarantined, false); assert.match(q[0].reason, /STORAGE_UNAVAILABLE/);
    }
    assert.equal(existsSync(join(w.state, 'fleet', 'abilities')), false, 'no internal fleet store');
    // interrupted synchronous save of the fleet index
    const storage = resolveStorage({ state: w.state, volumes: [w.vol()] });
    assert.equal(acceptAbilityRelease({ state: w.state, release, storage }).status, 'accepted');
    const index = join(e.root, 'fleet', 'abilities', 'methods', 'index.json'), before = readFileSync(index, 'utf8');
    const child = killChild(`const { safeWriteFileSync } = await import(${JSON.stringify(LIB)}); safeWriteFileSync(${JSON.stringify(index)}, '{"broken":', { root: ${JSON.stringify(e.root)}, fault: (s) => { if (s === 'after-temp-write') process.kill(process.pid, 'SIGKILL'); } });`);
    assert.equal(child.signal, 'SIGKILL');
    assert.equal(readFileSync(index, 'utf8'), before, 'the index is the intact previous version');
    assert.match(recoverDrive(e.root)[0].outcome, /rolled-back/); assert(noTemps(e.root));
  } finally { w.done(); }
});

// ═════════════════════════════ method iteration ═════════════════════════════
const methodText = (id, title) => `# ${title}\n\n\`\`\`kingmaker-method\n${JSON.stringify({ id, version: '1.0', title, domain: id.split('-')[0], inputs: { prompt: '' }, steps: [
  { n: 1, id: 'solve', type: 'reason', into: 'answer', preamble: 'Answer.', prompt: '{{inputs.prompt}}' },
  { n: 2, id: 'rec', type: 'write-json', path: 'r.json', value: { method: id, answer: '{{answer}}' } },
  { n: 3, id: 'check', type: 'verify', assertions: [{ file: 'r.json', field: 'method', equals: id }] }] }, null, 2)}\n\`\`\`\n`;
function putStore(dir, id, title) {
  mkdirSync(dir, { recursive: true });
  const file = `${id}.method.md`; writeFileSync(join(dir, file), methodText(id, title));
  let prior = []; try { prior = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')).methods; } catch { prior = []; }
  writeFileSync(join(dir, 'index.json'), JSON.stringify({ schema: 'kingmaker.methods/1', methods: [...prior.filter((m) => m.id !== id), { id, title, domain: id.split('-')[0], file, quality: { tier: 'draft', score: 50, basis: 'fixture' } }] }));
}
const answer = async ({ prompt }) => `answer for ${prompt}`;
const versionIn = (dir, id) => JSON.parse(/```kingmaker-method\n([\s\S]*?)```/.exec(readFileSync(join(dir, `${id}.method.md`), 'utf8'))[1]).version;
const iterRun = (w, storage, request, tag, prompt = 'Boston') => handleMethodRequest(request, { brain: createLocalBrain({ state: w.state, storage, reasoner: answer, methodHunt: false, iterate: true }), workDir: w.work(tag), inputs: { prompt } });

test('iteration: a drive method\'s next version is filed in ITS store on the drive (verified), and the next run reads it; reconnect follows the new path; a fleet method stays in the fleet store', async () => {
  const w = world();
  try {
    const e = approveDrive({ state: w.state, volume: w.vol(), roles: ['user-methods', 'fleet-abilities'], confirm: true });
    const user = join(e.root, 'abilities', 'methods'), fleet = join(e.root, 'fleet', 'abilities', 'methods');
    putStore(user, 'tide-table', 'Tide table'); putStore(fleet, 'knot-guide', 'Knot guide');
    let storage = resolveStorage({ state: w.state, volumes: [w.vol()] });
    const r = await iterRun(w, storage, 'run the tide table', 'i1');
    assert.equal(r.outcome, 'completed', r.lines.join('\n')); assert.equal(r.method.drive, 'KMUSB');
    assert.equal(versionIn(user, 'tide-table'), '1.1'); assert.match(readFileSync(join(user, 'tide-table.method.md'), 'utf8'), /## Iteration log/);
    assert.deepEqual(readdirSync(join(e.root, JOURNAL_DIR)), [], 'verified saves, journal cleared');
    assert.equal(existsSync(join(w.state, 'abilities', 'methods')), false, 'no internal user store'); assert.equal(existsSync(join(w.state, 'brain-library', 'methods', 'tide-table.method.md')), false);
    const ms = await createLocalBrain({ state: w.state, storage, reasoner: answer, methodHunt: false }).loop.conductor.listMethods();
    assert.equal(ms.find((m) => m.id === 'tide-table').version, '1.1', 'the next run reads the iterated file');
    const f = await iterRun(w, storage, 'run the knot guide', 'i2');
    assert.equal(f.outcome, 'completed', f.lines.join('\n'));
    assert.equal(versionIn(fleet, 'knot-guide'), '1.1'); assert.equal(existsSync(join(user, 'knot-guide.method.md')), false, 'a fleet ability is not copied into the user\'s library');
    const moved = w.moveMount();
    storage = resolveStorage({ state: w.state, volumes: [w.vol({ mountPoint: moved })] });
    await iterRun(w, storage, 'run the tide table', 'i3');
    assert.equal(versionIn(join(moved, 'Kingmaker', e.installId, 'abilities', 'methods'), 'tide-table'), '1.2');
    assert.equal(readFileSync(join(moved, 'Photos', 'a.jpg'), 'utf8'), 'JPEGDATA');
  } finally { w.done(); }
});

test('iteration: read-only drive → not filed (recorded), drive unchanged; missing drive → an internal method iterates in its own internal store only', async () => {
  const w = world();
  try {
    const e = approveDrive({ state: w.state, volume: w.vol(), roles: ['user-methods'], confirm: true });
    const user = join(e.root, 'abilities', 'methods'); putStore(user, 'tide-table', 'Tide table');
    const before = treeHash(e.root);
    const ro = resolveStorage({ state: w.state, volumes: [w.vol({ readOnly: true })] });
    const brain = createLocalBrain({ state: w.state, storage: ro, reasoner: answer, methodHunt: false, iterate: true });
    const run = await brain.loop.run('tide table', { workDir: w.work('ro'), inputs: { prompt: 'Boston' } });
    assert.equal(run.conduction.status, 'completed');
    const it = run.trace.find((t) => t.phase === 'iteration');
    assert.equal(it.status, 'failed'); assert.match(it.detail, /STORAGE_UNAVAILABLE: your own methods are on drive "KMUSB": drive "KMUSB" is mounted read-only/);
    assert.deepEqual(treeHash(e.root), before, 'read-only drive unchanged');
    assert.equal(existsSync(join(w.state, 'abilities', 'methods', 'tide-table.method.md')), false, 'no internal duplicate');
    // missing drive: the drive's method is not offered; a method already on this Mac iterates where it lives
    putStore(join(w.state, 'fleet', 'abilities', 'methods'), 'knot-guide', 'Knot guide');
    const gone = resolveStorage({ state: w.state, volumes: [] });
    const k = await iterRun(w, gone, 'run the knot guide', 'm1');
    assert.equal(k.outcome, 'completed', k.lines.join('\n'));
    assert.equal(versionIn(join(w.state, 'fleet', 'abilities', 'methods'), 'knot-guide'), '1.1');
    assert.equal(existsSync(join(w.state, 'abilities', 'methods')), false, 'no internal user library created');
  } finally { w.done(); }
});

test('iteration: an interrupted save of the next version leaves the method of record intact; recovery cleans up', async () => {
  const w = world();
  try {
    const e = approveDrive({ state: w.state, volume: w.vol(), roles: ['user-methods'], confirm: true });
    const user = join(e.root, 'abilities', 'methods'); putStore(user, 'tide-table', 'Tide table');
    const before = treeHash(user);
    const put = (p, d) => safeWriteFile(p, d, { root: e.root, fault: async (s) => { if (s === 'before-rename') throw new Error('power cut'); } });
    await assert.rejects(iterateMethod({ methodId: 'tide-table', storeDir: user, sourceIndexUrl: methodStoreIndexUrl(user), inputUpdates: { prompt: 'x' }, put }), /power cut/);
    assert.equal(versionIn(user, 'tide-table'), '1.0', 'the method of record is intact');
    const r = resolveStorage({ state: w.state, volumes: [w.vol()] }); // next start
    assert(r.recovered.some((x) => /rolled-back/.test(x.outcome)));
    assert.deepEqual(treeHash(user), before); assert.deepEqual(readdirSync(join(e.root, JOURNAL_DIR)), []);
    // and the uninterrupted save then works through the same writer path
    const ok = await iterateMethod({ methodId: 'tide-table', storeDir: user, sourceIndexUrl: methodStoreIndexUrl(user), inputUpdates: { prompt: 'x' }, put: (p, d) => safeWriteFile(p, d, { root: e.root }) });
    assert.equal(ok.toVersion, '1.1'); assert.equal(versionIn(user, 'tide-table'), '1.1');
  } finally { w.done(); }
});
