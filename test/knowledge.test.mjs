import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  availableLine, diskFloorBytes, EXTRACT_HEADROOM_BYTES, KNOWLEDGE_STAGES, knowledgeLayout, knowledgePlan, MIN_FREE_BYTES, pendingIndexBytes,
  provisionKnowledge, reapOrphanedJob, runPacedScript, servedFields, stageFits,
} from '../lib/knowledge.mjs';
import { cpuIdleBetween, MIN_DUTY, nextDuty, pacerFor, parsePressureLevel, parseSwapCounters, parseThermal, startingDuty } from '../lib/pacer.mjs';

const GIB = 1024 ** 3;
const calm = { pressureLevel: 'normal', pagingBytesPerSecond: 0, thermal: 'nominal', cpuIdle: 0.6 };

// ── the pacer (the engine's AIMD, same numbers) ──────────────────────────────
test('pace: congestion halves the duty, critical pressure drops it to the floor, headroom adds a tenth', () => {
  assert.deepEqual(nextDuty(1, calm), { duty: 1, congested: false, why: 'headroom' });
  assert.equal(nextDuty(0.5, calm).duty, 0.6);
  assert.equal(nextDuty(0.8, { ...calm, pressureLevel: 'warning' }).duty, 0.4);
  assert.equal(nextDuty(0.8, { ...calm, pressureLevel: 'critical' }).duty, MIN_DUTY);
  assert.match(nextDuty(1, { ...calm, pagingBytesPerSecond: 20 * 1048576 }).why, /paging 20 MB\/s/);
  assert.match(nextDuty(1, { ...calm, cpuIdle: 0.02 }).why, /CPU 98% busy/);
  assert.equal(nextDuty(0.1, { ...calm, thermal: 'hot' }).duty, MIN_DUTY, 'never below the floor: paced, never stopped');
  assert.equal(startingDuty(calm), 1);
  assert.equal(startingDuty({ ...calm, pressureLevel: 'warning' }), 0.25);
  assert.equal(startingDuty({ ...calm, pressureLevel: 'critical' }), MIN_DUTY);
  assert.equal(parsePressureLevel('4\n'), 'critical');
  assert.equal(parsePressureLevel('1'), 'normal');
  assert.equal(parseSwapCounters('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nSwapins: 10.\nSwapouts: 5.\n'), 15 * 16384);
  assert.equal(parseThermal('Note: No thermal warning level has been recorded'), 'nominal');
  assert.equal(parseThermal('CPU_Speed_Limit = 70'), 'hot');
  const t = (idle, busy) => [{ times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } }];
  assert.equal(cpuIdleBetween(t(0, 0), t(75, 25)), 0.75);
});

test('pace: the duty cycle pauses and resumes the group, and stop always leaves it running', () => {
  const sent = [];
  const timers = [];
  let feed;
  const pacer = pacerFor(4242, {
    signal: (pgid, sig) => sent.push(`${pgid}:${sig}`),
    source: { subscribe: (fn) => { feed = fn; return () => { feed = null; }; } },
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; }, clearTimer: () => {},
  });
  pacer.start();
  feed({ ...calm, pressureLevel: 'warning' }); // 1 → 0.5
  assert.equal(pacer.duty, 0.5);
  timers.shift().fn();                          // the full-duty period ends: a new cycle at 0.5
  assert.equal(timers[0].ms, 1_000, 'runs for half the period');
  timers.shift().fn();
  assert.deepEqual(sent, ['4242:SIGSTOP']);
  assert.equal(timers[0].ms, 1_000, 'then rests for the other half');
  const report = pacer.stop();
  assert.deepEqual(sent, ['4242:SIGSTOP', '4242:SIGCONT'], 'never left frozen');
  assert.equal(report.minDuty, 0.5);
  assert.equal(feed, null, 'sampling stops with the job');
});

// ── where the index goes ─────────────────────────────────────────────────────
const fakeProvision = (k = (dataDir) => ({ SOLOMON_DATA_DIR: dataDir }), status = () => ({ state: 'ABSENT' })) => ({
  desktopKnowledgeEnv: ({ dataDir }) => k(dataDir),
  knowledgeStatus: status,
});

test('the library is Kingmaker\'s own: index, sources and extracted under its data dir', () => {
  const plan = knowledgePlan({ env: {}, runtimeHome: '/sg/runtime', provision: fakeProvision(), home: '/Users/o', list: () => [] });
  assert.equal(plan.served, '/sg/runtime/data/knowledge/index', 'the core\'s SOLOMON_DATA_DIR/knowledge/index, read on every query');
  assert.equal(plan.sources, '/sg/runtime/data/knowledge/sources', 'an empty local corpus never falls back to the desktop app\'s');
  assert.equal(plan.extracted, '/sg/runtime/data/knowledge/extracted');
  assert.equal(plan.env.SOLOMON_INDEX_DIR, plan.served);
  // The provision module's shared fallback to ~/.solomon/knowledge is refused, root by root.
  const shared = knowledgePlan({ env: {}, runtimeHome: '/sg/runtime', home: '/Users/o', list: () => [],
    provision: fakeProvision((d) => ({ SOLOMON_DATA_DIR: d, SOLOMON_INDEX_DIR: '/Users/o/.solomon/knowledge/index', SOLOMON_CORPUS_DIR: '/Users/o/.solomon/knowledge/sources', SOLOMON_EXTRACTED_DIR: '/Users/o/.solomon/knowledge/extracted' })) });
  assert.deepEqual([shared.served, shared.sources, shared.extracted], ['/sg/runtime/data/knowledge/index', '/sg/runtime/data/knowledge/sources', '/sg/runtime/data/knowledge/extracted']);
  assert.ok(!JSON.stringify(shared.env).includes('/.solomon/'), 'no script is ever pointed into the desktop app\'s data dir');
  assert.equal(knowledgePlan({ env: {}, runtimeHome: '/sg/runtime', home: '/Users/o', list: () => [], provision: fakeProvision(() => ({ SOLOMON_DATA_DIR: '/Users/o/.solomon' })) }).served,
    '/sg/runtime/data/knowledge/index', 'even a whole data dir inside ~/.solomon');
  const elsewhere = knowledgePlan({ env: {}, runtimeHome: '/sg/runtime', home: '/Users/o', list: () => [], provision: fakeProvision(() => ({ SOLOMON_INDEX_DIR: '/Volumes/lib/index', SOLOMON_CORPUS_DIR: '/Volumes/lib/sources' })) });
  assert.deepEqual([elsewhere.served, elsewhere.sources, elsewhere.extracted], ['/Volumes/lib/index', '/Volumes/lib/sources', '/Volumes/lib/extracted'], 'an operator-chosen library outside ~/.solomon is honoured');
  const paths = { runtimeSource: 'bundle', resources: '/A/Contents/Resources', desktopModules: '/A/Contents/Resources/app.asar/desktop', fork: null };
  assert.deepEqual(knowledgeLayout(paths), { provisionModule: '/A/Contents/Resources/app.asar/desktop/knowledge-provision.mjs', scriptsDir: '/A/Contents/Resources/solomon-runtime/scripts' });
  assert.equal(knowledgeLayout({ runtimeSource: 'fork', desktopModules: '/r/engine/desktop', fork: { root: '/r/engine' } }).scriptsDir, '/r/engine/scripts');
});

test('room: the 8 GB Mac keeps its swap floor; a stage starts only when it fits', () => {
  assert.equal(diskFloorBytes({}, 8 * GIB), 20 * GIB);
  assert.equal(diskFloorBytes({ SOLOMON_DISK_FLOOR_GB: '25' }, 8 * GIB), 25 * GIB);
  assert.equal(diskFloorBytes({ SOLOMON_DISK_FLOOR_GB: '0' }, 8 * GIB), MIN_FREE_BYTES, 'off still keeps a minimum');
  assert.equal(diskFloorBytes({}, 16 * GIB), MIN_FREE_BYTES);
  const index = KNOWLEDGE_STAGES[0];
  const extract = KNOWLEDGE_STAGES[1];
  assert.equal(stageFits(index, { free: 22 * GIB, floor: 20 * GIB, pendingIndex: 1 * GIB }).ok, true);
  assert.equal(stageFits(index, { free: 22 * GIB, floor: 20 * GIB, pendingIndex: 3 * GIB }).ok, false);
  assert.equal(stageFits(extract, { free: 22 * GIB, floor: 20 * GIB, pendingIndex: 0 }).ok, false);
  assert.equal(stageFits(extract, { free: 20 * GIB + EXTRACT_HEADROOM_BYTES, floor: 20 * GIB, pendingIndex: 0 }).ok, true);
  const stats = { '/x/a/extracted.jsonl': { size: 100, mtimeMs: 5 }, '/x/b/extracted.jsonl': { size: 200, mtimeMs: 5 }, '/i/b.db': { size: 1, mtimeMs: 9 } };
  const stat = (p) => { if (!stats[p]) throw new Error('ENOENT'); return stats[p]; };
  assert.equal(pendingIndexBytes({ extracted: '/x', served: '/i' }, { list: () => ['a', 'b', '.receipts'], stat }), 150, 'only fields whose shard is missing or older, × 1.5');
});

// ── the job ──────────────────────────────────────────────────────────────────
function tempLayout({ own = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sg-know-'));
  const home = join(root, 'home');
  mkdirSync(join(home, '.solomon', 'knowledge', 'sources', 'language'), { recursive: true }); // the desktop app's: must be ignored
  writeFileSync(join(home, '.solomon', 'knowledge', 'sources', 'language', 'x.txt'), 'x');
  const scriptsDir = join(root, 'scripts');
  mkdirSync(scriptsDir);
  for (const s of KNOWLEDGE_STAGES) writeFileSync(join(scriptsDir, s.script), '');
  const paths = { runtimeHome: join(root, 'rt'), state: join(root, 'state'), logs: join(root, 'logs'), desktopModules: '/nowhere', resources: '/nowhere', runtimeSource: 'bundle' };
  if (own) { // Kingmaker's own corpus
    mkdirSync(join(paths.runtimeHome, 'data', 'knowledge', 'sources', 'language'), { recursive: true });
    writeFileSync(join(paths.runtimeHome, 'data', 'knowledge', 'sources', 'language', 'x.txt'), 'x');
  }
  mkdirSync(paths.state, { recursive: true });
  return { root, home, scriptsDir, paths, served: join(paths.runtimeHome, 'data', 'knowledge', 'index') };
}

test('provision: index what is extracted, say ONE line when it first becomes context, then wait for room', async () => {
  const t = tempLayout();
  const runs = [];
  const said = [];
  const lines = [];
  process.env.SOLOMON_DESKTOP_CONTROL_NONCE = 'should-never-reach-a-script';
  try {
    const result = await provisionKnowledge({
      paths: t.paths, env: {}, home: t.home, scriptsDir: t.scriptsDir, log: () => {}, reap: () => false,
      load: async () => fakeProvision(),
      announce: (l) => said.push(l), out: (l) => lines.push(l),
      floor: 20 * GIB, free: () => 21 * GIB,
      run: async ({ stage, env }) => {
        runs.push({ id: stage.id, env });
        if (stage.id === 'index') { mkdirSync(t.served, { recursive: true }); writeFileSync(join(t.served, 'language.db'), 'x'); writeFileSync(join(t.served, 'history.db'), 'x'); }
        return { code: 0, stoppedFor: null };
      },
    });
    assert.deepEqual(runs.map((r) => r.id), ['index'], 'the extraction needs more room than this Mac can spare: it waits');
    assert.equal(result.state, 'deferred-disk');
    assert.equal(result.stage, 'extract');
    assert.deepEqual(said, [availableLine(2)]);
    assert.equal(said[0], 'Your knowledge library is in: 2 fields of it now inform my answers.');
    assert.equal(lines.length, 1, 'one console line about the room, nothing spoken about it');
    assert.equal(runs[0].env.SOLOMON_INDEX_DIR, t.served);
    assert.equal(runs[0].env.SOLOMON_DESKTOP_CONTROL_NONCE, undefined, 'scripts never get the launch secrets');
    assert.deepEqual(servedFields(t.served).sort(), ['history', 'language']);
  } finally { delete process.env.SOLOMON_DESKTOP_CONTROL_NONCE; }
});

test('provision: all three stages with room; nothing said when the library was already context', async () => {
  const t = tempLayout();
  mkdirSync(t.served, { recursive: true });
  writeFileSync(join(t.served, 'language.db'), 'x');
  const said = [];
  const runs = [];
  const result = await provisionKnowledge({
    paths: t.paths, env: {}, home: t.home, scriptsDir: t.scriptsDir, reap: () => false,
    load: async () => fakeProvision(undefined, () => ({ state: 'PARTIAL' })),
    announce: (l) => said.push(l), floor: 4 * GIB, free: () => 200 * GIB,
    run: async ({ stage }) => { runs.push(stage.id); return { code: 0, stoppedFor: null }; },
  });
  assert.deepEqual(runs, ['index', 'extract', 'index']);
  assert.equal(result.state, 'partial', 'ran clean, but the library is honestly still partial');
  assert.deepEqual(said, []);
});

test('provision: a present library, no sources, or a stop all end quietly', async () => {
  const t = tempLayout();
  const never = async () => { throw new Error('must not run'); };
  assert.equal((await provisionKnowledge({ paths: t.paths, env: {}, home: t.home, scriptsDir: t.scriptsDir, reap: () => false, load: async () => fakeProvision(undefined, () => ({ state: 'PRESENT' })), run: never })).state, 'present');
  const desktopOnly = tempLayout({ own: false }); // only the desktop app's ~/.solomon has sources: Kingmaker must not use them
  assert.equal((await provisionKnowledge({ paths: desktopOnly.paths, env: {}, home: desktopOnly.home, scriptsDir: desktopOnly.scriptsDir, reap: () => false, load: async () => fakeProvision(), run: never })).state, 'no-sources');
  assert.equal((await provisionKnowledge({ paths: t.paths, env: {}, home: t.home, reap: () => false, load: async () => { throw new Error('no node:sqlite'); }, run: never })).state, 'unavailable');
  const r = await provisionKnowledge({ paths: t.paths, env: {}, home: t.home, scriptsDir: t.scriptsDir, reap: () => false, load: async () => fakeProvision(), free: () => 200 * GIB, run: async () => ({ code: null, stoppedFor: 'cancelled' }) });
  assert.equal(r.state, 'cancelled');
});

test('a running script is paced, stopped (resumable) at the disk floor or on abort, and never left frozen', async () => {
  const fakeChild = () => Object.assign(new EventEmitter(), { pid: 999_999, kill(sig) { this.killed = sig; setImmediate(() => this.emit('exit', null)); } });
  let child;
  let paceOpts;
  let pacerStops = 0;
  let diskLow = false;
  const spawnImpl = (bin, args, opts) => { child = fakeChild(); child.args = [bin, ...args]; child.opts = opts; return child; };
  const pace = (_pid, opts) => { paceOpts = opts; return { start() {}, stop() { pacerStops += 1; } }; };
  const started = [];
  const p = runPacedScript({ stage: KNOWLEDGE_STAGES[0], scriptsDir: '/s', nodeBin: '/node', env: { A: '1' }, spawnImpl, pace, diskLow: () => diskLow, onStart: (pid) => started.push(pid) });
  assert.deepEqual(child.args, ['/node', '--experimental-sqlite', '/s/solomon-index-knowledge.mjs']);
  assert.equal(child.opts.detached, true, 'its own process group, so pausing reaches its children');
  assert.deepEqual(started, [999_999]);
  paceOpts.onSignals(calm);
  assert.equal(child.killed, undefined, 'room left: keeps going');
  diskLow = true;
  paceOpts.onSignals(calm);
  const r = await p;
  assert.deepEqual(r, { code: -1, stoppedFor: 'disk' });
  assert.ok(pacerStops >= 1, 'resumed before it was stopped');

  const controller = new AbortController();
  const p2 = runPacedScript({ stage: KNOWLEDGE_STAGES[1], scriptsDir: '/s', nodeBin: '/node', env: {}, spawnImpl, pace, signal: controller.signal });
  controller.abort();
  assert.equal((await p2).stoppedFor, 'cancelled');
});

test('a job a killed Kingmaker left behind is resumed and stopped at the next start, a reused pid never', () => {
  const sent = [];
  const base = { read: () => JSON.stringify({ pid: 4321 }), alive: () => true, kill: (pid, sig) => sent.push(`${pid}:${sig}`), remove: () => {} };
  assert.equal(reapOrphanedJob('/j', { ...base, commandOf: () => '/usr/bin/node --experimental-sqlite /x/solomon-index-knowledge.mjs' }), true);
  assert.deepEqual(sent, ['-4321:SIGCONT', '-4321:SIGTERM']);
  assert.equal(reapOrphanedJob('/j', { ...base, commandOf: () => '/Applications/Safari.app/Contents/MacOS/Safari' }), false);
  assert.equal(sent.length, 2);
  assert.equal(reapOrphanedJob('/j', { ...base, read: () => { throw new Error('ENOENT'); } }), false);
});

test('provision: an owner meeting hold defers the next heavy stage; nothing starts', async () => {
  const t = tempLayout();
  const never = async () => { throw new Error('no stage may start during a meeting'); };
  const r = await provisionKnowledge({ paths: t.paths, env: {}, home: t.home, scriptsDir: t.scriptsDir, reap: () => false,
    load: async () => fakeProvision(), free: () => 200 * GIB, run: never, inMeeting: () => true });
  assert.equal(r.state, 'deferred-meeting');
});

test('the ~/.solomon guard survives ./, //, case, ~, symlinks and a different HOME', async () => {
  const { insideDesktopAppData } = await import('../lib/paths.mjs');
  const { mkdtempSync, mkdirSync, symlinkSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const home = mkdtempSync(join(tmpdir(), 'sg-home-'));
  mkdirSync(join(home, '.solomon', 'knowledge', 'sources'), { recursive: true });
  for (const p of [join(home, '.solomon'), `${home}/./.solomon/knowledge`, `${home}//.solomon/knowledge/index`, join(home, '.Solomon', 'knowledge'), '~/.solomon/knowledge']) {
    assert.equal(insideDesktopAppData(p, [home]), true, p);
  }
  const link = join(home, 'lib-link'); symlinkSync(join(home, '.solomon', 'knowledge'), link);
  assert.equal(insideDesktopAppData(join(link, 'sources'), [home]), true, 'a symlink into ~/.solomon is caught');
  assert.equal(insideDesktopAppData(join(home, '.solomon-secure'), [home]), false, 'a sibling name is not inside');
  assert.equal(insideDesktopAppData(join(home, '.solomon', '..archive', 'index'), [home]), true, 'a descendant name beginning with two dots remains inside the desktop app\'s data');
  assert.equal(insideDesktopAppData('/Volumes/lib/index', [home]), false);
  assert.equal(insideDesktopAppData(join(home, '.solomon', 'x'), ['/Users/other', home]), true, 'every HOME is checked');
});
