// Tests for the cold-start attack: the phase model (lib/cold-start.mjs), the weight-loading wins
// and startup staging (lib/model-warm.mjs), the resident engine (lib/resident-engine.mjs), and a
// smoke run of the bench harness itself (scripts/coldstart-bench.mjs).
// Run: node tests/coldstart.test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { COLD_START_PHASES, createPhaseTimer, formatPhaseTable, phaseVerdict } from '../lib/cold-start.mjs';
import { ollamaLoadBody, prewarmModel, prewarmModels, prewarmReflex, reflexPrewarmModel, runBackgroundStages, startupStagePlan } from '../lib/model-warm.mjs';
import { DecisionRouter } from '../lib/decision-router.mjs';
import { ensureResidentEngine, probeResidentEngine, stopResidentEngine } from '../lib/resident-engine.mjs';

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; console.log(`  ok - ${name}`); };

/* ---------------- the phase model ---------------- */
{
  const ids = COLD_START_PHASES.map((p) => p.id);
  ok('phase ids are the canonical six, in launch order', JSON.stringify(ids) === JSON.stringify(['process', 'preflight', 'engine', 'post-ready', 'first-decision', 'first-token']));
  ok('every phase carries a positive budget', COLD_START_PHASES.every((p) => p.budgetMs > 0));

  let t = 1_000;
  const timer = createPhaseTimer({ now: () => t });
  t += 120; timer.mark('process');
  t += 80; timer.mark('preflight', { kind: 'REAL' });
  timer.set('engine', 2_500, { kind: 'SIMULATED', note: 'fixture' });
  const rows = timer.rows();
  ok('mark() measures the delta since the last mark', rows[0].ms === 120 && rows[1].ms === 80);
  ok('set() records an externally measured phase with its kind', rows[2].ms === 2_500 && rows[2].kind === 'SIMULATED' && rows[2].note === 'fixture');
  ok('unmeasured phases stay visibly unmeasured', rows[3].ms === null && rows[3].withinBudget === null);
  ok('withinBudget compares against the phase budget', rows[2].withinBudget === true);
  assert.throws(() => timer.mark('bogus'), /unknown phase/); passed += 1; console.log('  ok - an unknown phase is refused');
  assert.throws(() => timer.set('engine', 1, { kind: 'ISH' }), /kind must be/); passed += 1; console.log('  ok - an unlabeled kind is refused (a number may not hide how it was got)');

  const verdict = phaseVerdict(rows);
  ok('verdict counts kinds separately', verdict.realCount === 2 && verdict.simulatedCount === 1 && verdict.measuredCount === 3);
  ok('a table with simulated rows is never "proven"', verdict.allRealWithinBudget === false);
  ok('unmeasured phases are named', JSON.stringify(verdict.unmeasured) === JSON.stringify(['post-ready', 'first-decision', 'first-token']));

  const full = COLD_START_PHASES.map((p) => ({ id: p.id, label: p.label, detail: p.detail, budgetMs: p.budgetMs, ms: 10, kind: 'REAL', note: null, withinBudget: true }));
  ok('all-real-and-within is the only proven verdict', phaseVerdict(full).allRealWithinBudget === true);
  const over = full.map((r) => (r.id === 'engine' ? { ...r, ms: 99_999, withinBudget: false } : r));
  ok('a real over-budget phase is named', JSON.stringify(phaseVerdict(over).realOverBudget) === JSON.stringify(['engine']) && phaseVerdict(over).allRealWithinBudget === false);

  const table = formatPhaseTable(rows);
  ok('the table prints the kind beside every measured number', table.includes('120 ms (REAL)') && table.includes('2500 ms (SIMULATED)') && table.includes('— unmeasured —'));
}

/* ---------------- model warm: pure pieces ---------------- */
{
  // There are no mac classes anymore (the metered-doctrine rework retired the bands and the
  // fit table with them): the pre-warm seat is the router's own pick, the same on every device.
  ok('the reflex pre-warm seat is the router\'s own pick, the same on every device (laya at this registry revision)',
    reflexPrewarmModel() === DecisionRouter.pickDecisionModel().name && reflexPrewarmModel() === 'laya');

  const body = ollamaLoadBody('some-model');
  ok('the load body is a load: no prompt, not streamed, keep_alive held, mmap pinned',
    body.model === 'some-model' && body.stream === false && body.keep_alive === '30m' && body.options.use_mmap === true && !('prompt' in body));
  ok('keep_alive is caller-shaped', ollamaLoadBody('m', { keepAlive: '5m' }).keep_alive === '5m');
}

/* ---------------- model warm: pre-warm behavior ---------------- */
{
  const calls = [];
  const okFetch = async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return { ok: true, status: 200, text: async () => '{}' }; };
  const r = await prewarmModel({ model: 'seat-a', baseUrl: 'http://ollama.test', fetchImpl: okFetch });
  ok('a pre-warm posts the load body to /api/generate', r.ok && calls[0].url === 'http://ollama.test/api/generate' && calls[0].body.model === 'seat-a' && calls[0].body.options.use_mmap === true);

  const errFetch = async () => ({ ok: false, status: 500, text: async () => 'no' });
  const r500 = await prewarmModel({ model: 'seat-b', baseUrl: 'http://ollama.test', fetchImpl: errFetch });
  ok('an HTTP refusal is an outcome, not an exception', r500.ok === false && /HTTP 500/.test(r500.error));
  const downFetch = async () => { throw new Error('connect ECONNREFUSED'); };
  const rDown = await prewarmModel({ model: 'seat-c', baseUrl: 'http://ollama.test', fetchImpl: downFetch });
  ok('a dead Ollama is an outcome, not an exception', rDown.ok === false && /ECONNREFUSED/.test(rDown.error));

  calls.length = 0;
  const many = await prewarmModels({ models: ['a', 'a', ' b ', '', 'b'], baseUrl: 'http://ollama.test', fetchImpl: okFetch });
  ok('prewarmModels dedupes, trims and keeps order', many.length === 2 && many[0].model === 'a' && many[1].model === 'b' && calls.length === 2);
}
{
  const answering = { decide: async () => [{ kind: 'auto-proceed', questionName: 'warmup' }] };
  const warm = await prewarmReflex({ router: answering });
  ok('a reflex warm that the endpoint answers is warm', warm.ok === true && warm.model === 'laya');
  const silent = { decide: async () => [{ kind: 'transport-failed', questionName: 'warmup', reason: 'reflex layer unreachable: fetch failed' }] };
  const cold = await prewarmReflex({ router: silent });
  ok('a transport failure is a missed warm, with its reason', cold.ok === false && /did not answer|unreachable/.test(cold.error));
  const bad = await prewarmReflex({ model: 'not-a-registered-model' });
  ok('an unregistered reflex model is a missed warm, never a throw', bad.ok === false && bad.error.length > 0);
}

/* ---------------- startup staging ---------------- */
{
  const plan = startupStagePlan({ brainModels: ['chat-seat', 'chat-seat', ' coder-seat '], chromeSync: true });
  ok('the blocking stages are exactly the safety two, first', JSON.stringify(plan.slice(0, 2).map((s) => s.id)) === JSON.stringify(['rules-check', 'hands-warm']) && plan.slice(0, 2).every((s) => s.mode === 'blocking'));
  ok('reflex warm is background and names its model', plan[2].id === 'reflex-warm' && plan[2].mode === 'background' && plan[2].model === 'laya');
  ok('brain seats are deduped background stages', JSON.stringify(plan.filter((s) => s.id.startsWith('brain-warm:')).map((s) => s.id)) === JSON.stringify(['brain-warm:chat-seat', 'brain-warm:coder-seat']));
  ok('chrome sync can be left out of the plan', !startupStagePlan({ chromeSync: false }).some((s) => s.id === 'chrome-sync'));

  const order = [];
  const { outcomes } = runBackgroundStages([
    { id: 'one', run: async () => { order.push('one'); } },
    { id: 'two', run: async () => { order.push('two'); throw new Error('boom'); } },
    { id: 'three', run: async () => { order.push('three'); } },
  ], { log: () => {} });
  const results = await outcomes;
  ok('background stages all run; a failure is an outcome among outcomes',
    order.length === 3 && results.map((r) => r.ok).join(',') === 'true,false,true' && /boom/.test(results[1].error));
}

/* ---------------- resident engine: probe ---------------- */
{
  const paths = { stateFile: '/nowhere/daemon.json' };
  const noHealth = async () => null;
  const yesHealth = async () => ({ ok: true });
  const base = { paths, port: 3001 };

  ok('no state + nothing answering = down', (await probeResidentEngine({ ...base, readState: () => null, alive: () => false, healthCheck: noHealth })).state === 'down');
  ok('no state + something answering = foreign (never reused, never stopped)',
    (await probeResidentEngine({ ...base, readState: () => null, alive: () => false, healthCheck: yesHealth })).state === 'foreign');
  ok('stale state (pid gone, silence) = down', (await probeResidentEngine({ ...base, readState: () => ({ pid: 4242 }), alive: () => false, healthCheck: noHealth })).state === 'down');
  const orphan = await probeResidentEngine({ ...base, readState: () => ({ pid: 4242, backendPid: 4343 }), alive: () => false, healthCheck: yesHealth });
  ok('launcher gone + its engine still answering = orphaned (adoptable)', orphan.state === 'orphaned' && orphan.backendPid === 4343);
  ok('launcher gone + an answerer the state cannot name = foreign', (await probeResidentEngine({ ...base, readState: () => ({ pid: 4242 }), alive: () => false, healthCheck: yesHealth })).state === 'foreign');
  const ready = await probeResidentEngine({ ...base, readState: () => ({ pid: 4242, backendPid: 4343, startedAt: '2026-10-21T00:00:00.000Z' }), alive: () => true, healthCheck: yesHealth, now: () => Date.parse('2026-10-21T00:01:00.000Z') });
  ok('live pid + answering health = ready, with its uptime', ready.state === 'ready' && ready.backendPid === 4343 && ready.uptimeMs === 60_000);
  ok('live pid + silent health = starting, not ready', (await probeResidentEngine({ ...base, readState: () => ({ pid: 4242 }), alive: () => true, healthCheck: noHealth })).state === 'starting');
}

/* ---------------- resident engine: ensure ---------------- */
{
  const paths = { stateFile: '/nowhere/daemon.json' };
  let starts = 0;
  const start = async () => { starts += 1; return { backend: { child: { pid: 777 } }, daemonState: { pid: 100, backendPid: 777, port: 3001 } }; };

  const reused = await ensureResidentEngine({ paths, port: 3001, start, probe: async () => ({ state: 'ready', pid: 5, port: 3001 }) });
  ok('a ready resident is reused — no second start', reused.reused === true && starts === 0);

  const written = [];
  const started = await ensureResidentEngine({
    paths, port: 3001, start,
    probe: async () => ({ state: 'down' }),
    writeState: (p, s) => written.push(s),
    supervise: (b) => ({ supervised: b }),
  });
  ok('a down resident is started once, its state written, supervision wrapped',
    started.reused === false && starts === 1 && written.length === 1 && written[0].backendPid === 777 && started.supervisor.supervised === started.backend);

  const refused = await ensureResidentEngine({ paths, port: 3001, start, probe: async () => ({ state: 'foreign', reason: 'not ours' }) });
  ok('a foreign engine is refused, never started over', refused.refused === true && starts === 1);

  const seq = [{ state: 'starting', pid: 9 }, { state: 'ready', pid: 9, port: 3001 }];
  const waited = await ensureResidentEngine({ paths, port: 3001, start, probe: async () => seq.shift() ?? { state: 'ready', pid: 9, port: 3001 }, sleep: async () => {} });
  ok('a starting resident is waited for, then reused', waited.reused === true && starts === 1);

  const wedged = await ensureResidentEngine({ paths, port: 3001, start, probe: async () => ({ state: 'starting', pid: 9 }), attachWaitMs: 0, sleep: async () => {} });
  ok('a resident that never answers is refused, not doubled', wedged.refused === true && starts === 1);

  const adopted = await ensureResidentEngine({ paths, port: 3001, start, probe: async () => ({ state: 'orphaned', pid: 9, backendPid: 10, port: 3001 }) });
  ok('an orphaned engine is adopted — reused, never restarted', adopted.reused === true && adopted.adopted === true && adopted.resident.backendPid === 10 && starts === 1);
}

/* ---------------- resident engine: stop ---------------- */
{
  const paths = { stateFile: '/nowhere/daemon.json' };
  const none = await stopResidentEngine({ paths, readState: () => null, clearState: () => {} });
  ok('stopping nothing is a report, not an error', none.stopped === false && /nothing recorded/.test(none.reason));

  let cleared = 0;
  const stale = await stopResidentEngine({ paths, readState: () => ({ pid: 55 }), alive: () => false, clearState: () => { cleared += 1; } });
  ok('a stale state is cleared and reported stopped', stale.stopped === true && cleared === 1);

  const signals = [];
  let lives = 2; // alive for the verify + first poll, gone after SIGTERM lands
  const graceful = await stopResidentEngine({
    paths, readState: () => ({ pid: 55 }),
    alive: () => (lives > 0 ? (lives -= 1, true) : false),
    kill: (pid, sig) => signals.push(sig),
    clearState: () => { cleared += 1; },
    graceMs: 1_000, pollMs: 1, sleep: async () => {},
  });
  // alive() calls: initial check (true), waitGone poll (true), waitGone poll (false → gone)
  ok('SIGTERM then gone = a clean stop, state cleared', graceful.stopped === true && graceful.escalated === false && signals.join() === 'SIGTERM' && cleared === 2);

  signals.length = 0;
  let stubborn = true;
  const forced = await stopResidentEngine({
    paths, readState: () => ({ pid: 56 }),
    alive: () => stubborn,
    kill: (pid, sig) => { signals.push(sig); if (sig === 'SIGKILL') stubborn = false; },
    clearState: () => {},
    graceMs: 5, forceWaitMs: 50, pollMs: 1, // real tiny sleeps: the grace must actually lapse
  });
  ok('a grace ignored earns exactly one SIGKILL', forced.stopped === true && forced.escalated === true && signals.join() === 'SIGTERM,SIGKILL');

  let killed = false;
  const notOurs = await stopResidentEngine({
    paths, readState: () => ({ pid: 57 }), alive: () => true,
    kill: () => { killed = true; }, verify: async () => false, clearState: () => {},
  });
  ok('an unverified pid is never signalled', notOurs.stopped === false && killed === false && /not Kingmaker/.test(notOurs.reason));
}

/* ---------------- the bench harness itself ---------------- */
{
  const out = execFileSync(process.execPath, ['scripts/coldstart-bench.mjs', '--json'], { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8', timeout: 120_000 });
  const report = JSON.parse(out);
  ok('the bench reports all six phases', report.rows.length === 6);
  ok('every measured bench row wears its kind', report.rows.every((r) => r.ms == null || (r.kind === 'REAL' || r.kind === 'SIMULATED')));
  const engine = report.rows.find((r) => r.id === 'engine');
  ok('the fixture engine row is SIMULATED, never REAL', engine.kind === 'SIMULATED' && engine.ms != null);
  const decision = report.rows.find((r) => r.id === 'first-decision');
  ok('the mock decision row is REAL transport cost, and says the model is not in it', decision.kind === 'REAL' && /NOT in this number/.test(decision.note));
  ok('the bench verdict refuses to call this proven', report.verdict.allRealWithinBudget === false && report.verdict.simulatedCount >= 2);
}

console.log(`\ncoldstart: ${passed} checks passed`);
