import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSoak, counterDelta, compareBaseline, SOAK_LANES } from '../lib/soak-evidence.mjs';
import { validateCode, colorImage, writerJob } from '../lib/soak-fixtures.mjs';
import { parseHostMemory, parseGpu, parseThermal, hardwareIdentity, loopbackBase, validateConfig, runWorkSoak } from '../lib/soak-work.mjs';
const baseline = { host: { chip: 'test chip', ramGb: 24, ollama: 'test runtime' }, context: 8192, results: SOAK_LANES.map((model) => ({ model, speed: { genTokS: 10 } })) };
baseline.results[0].context = 2048;
function evidence() {
  return { runId: 'r', startedMs: 1, endedMs: 10, status: 'complete', minJobs: 1, machine: { chip: 'test chip', ramGb: 24 }, runtime: 'test runtime',
    receipts: SOAK_LANES.map((lane) => ({ id: lane, runId: 'r', jobId: ['router', 'writer'].includes(lane) ? 'j' : `probe:${lane}`, lane, provider: 'ollama', transport: 'loopback-http', httpStatus: 200, done: true, doneReason: 'stop', outcome: 'ok', generated: 10, evalNs: 1e9, residentModelBytes: 1000, residentGpuBytes: 900, requestModel: lane, model: lane, context: lane === 'router' ? 2048 : 8192, validated: true, startedMs: 2, endedMs: 9 })),
    jobs: [{ id: 'j', runId: 'r', status: 'completed', validation: true, route: { lane: 'write', by: 'router' } }], health: [{ status: 200 }], crashes: [],
    samples: [{ phase: 'baseline', hostTotalBytes: 24 * 2 ** 30, hostAvailableBytes: 16 * 2 ** 30, rssBytes: 100 }, { phase: 'inference', modelBytes: 1000, gpuPct: 20 }, ...Array.from({ length: 3 }, () => ({ phase: 'settled', hostTotalBytes: 24 * 2 ** 30, hostAvailableBytes: 16 * 2 ** 30, rssBytes: 100, modelBytes: 0 }))],
    unloads: [{ acknowledged: true, absent: true, settled: true }] };
}
const check = (r) => evaluateSoak(r, { baseline });
const has = (r, code) => assert.ok(check(r).failures.some((f) => f.code === code), code);
test('complete proof counts jobs once and sums generated decode tokens, not prompt tokens', () => { const r = check(evidence()); assert.equal(r.ok, true); assert.equal(r.localCompletedJobs, 1); assert.equal(r.localGeneratedTokens, 50); assert.equal(r.lanes.writer.decodeTokS, 10); });
test('cloud-only output cannot pass', () => { const r = evidence(); r.receipts.forEach((x) => { x.provider = 'cloud'; }); has(r, 'ZERO_LOCAL_GENERATED_TOKENS'); has(r, 'ZERO_LOCAL_COMPLETED_JOBS'); assert.equal(check(r).cloudCompletedJobs, 1); });
test('zero tokens, missing receipts and nonempty generic output cannot pass', () => { const r = evidence(); r.receipts.forEach((x) => { x.generated = 0; x.answer = 'fine'; x.promptTokens = 900; }); has(r, 'ZERO_LOCAL_GENERATED_TOKENS'); has(r, 'ZERO_LOCAL_COMPLETED_JOBS'); r.receipts = []; has(r, 'LANE_UNEXERCISED'); });
test('missing or invalid lane output fails even with positive tokens', () => { const r = evidence(); r.receipts = r.receipts.filter((x) => x.lane !== 'vision'); has(r, 'LANE_UNEXERCISED'); const s = evidence(); s.receipts[4].validated = false; has(s, 'LANE_UNEXERCISED'); });
test('failed calls are requests, not completed jobs', () => { const r = evidence(); r.receipts[1].outcome = 'error'; assert.equal(check(r).failedCalls, 1); has(r, 'ZERO_LOCAL_COMPLETED_JOBS'); r.jobs[0].status = 'failed'; has(r, 'JOB_NOT_COMPLETED'); });
test('rule routes, fallback routes, unfinished and truncated calls do not prove inference completion', () => { for (const by of ['rule', 'default']) { const r = evidence(); r.jobs[0].route.by = by; has(r, 'ZERO_LOCAL_COMPLETED_JOBS'); } for (const field of ['done', 'doneReason']) { const r = evidence(); r.receipts[1][field] = field === 'done' ? false : 'length'; has(r, 'LOCAL_RECEIPT_INVALID'); } });
test('historical totals, duplicate receipts and unrelated jobs cannot satisfy run', () => { for (const change of [(r) => r.runId = 'old', (r) => r.startedMs = 0, (r) => r.endedMs = 11]) { const r = evidence(); change(r.receipts[0]); has(r, 'RECEIPT_SCOPE_INVALID'); has(r, 'ZERO_LOCAL_COMPLETED_JOBS'); } const r = evidence(); r.receipts.push(r.receipts[0]); has(r, 'RECEIPT_SCOPE_INVALID'); r.jobs.push(r.jobs[0]); has(r, 'JOB_SCOPE_INVALID'); });
test('thermal abort, incomplete run, health loss, crashes and missing memory/GPU all fail closed', () => { const r = evidence(); r.status = 'aborted'; has(r, 'RUN_INCOMPLETE'); r.health = []; has(r, 'HEALTH_FAILED_OR_MISSING'); r.crashes = ['Kingmaker.ips']; has(r, 'CRASH_DETECTED'); r.samples = []; has(r, 'INFERENCE_MEMORY_MISSING'); has(r, 'GPU_TELEMETRY_MISSING'); has(r, 'SETTLED_MEMORY_RECOVERY_MISSING'); r.unloads[0].absent = false; has(r, 'UNLOAD_OR_MEMORY_RECOVERY_FAILED'); });
test('requested N is mandatory', () => { const r = evidence(); r.minJobs = 2; has(r, 'INSUFFICIENT_LOCAL_JOBS'); });
test('counter reset/restart is never a positive or negative fabricated delta', () => { assert.equal(counterDelta({ generated: 3, since: 'a' }, { generated: 2, since: 'a' }).error, 'COUNTER_RESET'); assert.equal(counterDelta({ generated: 3, since: 'a' }, { generated: 99, since: 'b' }).error, 'COUNTER_RESET'); assert.equal(counterDelta({}, {}).error, 'COUNTER_MISSING'); assert.equal(counterDelta({ generated: 3, since: 'a' }, { generated: 9, since: 'a' }).delta, 6); const r = evidence(); r.counters = { before: { generated: 3, since: 'a' }, after: { generated: 99, since: 'b' } }; has(r, 'COUNTER_RESET'); });
test('baseline identity must match chip, RAM, exact model, context and runtime', () => { const a = { chip: 'test chip', ramGb: 24, model: 'writer', context: 8192, runtime: 'test runtime', tokS: 10 }; assert.equal(compareBaseline(a, baseline).status, 'matched'); for (const key of ['chip', 'ramGb', 'context', 'runtime']) assert.equal(compareBaseline({ ...a, [key]: 'other' }, baseline).status, 'mismatch'); assert.equal(compareBaseline({ ...a, model: 'other' }, baseline).status, 'unavailable'); assert.equal(compareBaseline({ ...a, chip: null }, baseline).status, 'unavailable'); const r = evidence(); r.machine.chip = null; has(r, 'BASELINE_UNAVAILABLE'); });
test('fixture checks do more than accept arbitrary nonempty strings', () => { assert.equal(writerJob(0).validate('ok'), false); assert.equal(validateCode('function add(a,b) { return a + b; }'), true); assert.equal(validateCode('function add(a,b) { return a - b; }'), false); assert.equal(validateCode('process.exit()'), false); assert.notEqual(colorImage(true), colorImage(false)); assert.equal(Buffer.from(colorImage(), 'base64').subarray(1, 4).toString(), 'PNG'); });
test('loopback only; redirects are not enabled and unknown GPU remains unknown', () => { for (const url of ['https://example.com', 'http://localhost', 'http://127.0.0.1.evil.com', 'http://user:pass@127.0.0.1', 'http://127.0.0.1/path']) assert.throws(() => loopbackBase(url)); assert.equal(loopbackBase('http://127.0.0.1:11434'), 'http://127.0.0.1:11434'); assert.equal(parseGpu('"Device Utilization %"=37'), 37); assert.equal(parseGpu('nothing'), null); assert.equal(parseGpu('"Device Utilization %"=900'), null); });
const config = { models: Object.fromEntries(SOAK_LANES.map((l) => [l, l])), context: 8192, maxResidentBytes: 100000, minJobs: 1, exclusive: true, timeoutMs: 1000 };
test('config rejects unbounded jobs/context/time/memory', () => { for (const patch of [{ minJobs: 0 }, { minJobs: 21 }, { context: 100000 }, { timeoutMs: 999999 }, { maxResidentBytes: null }]) assert.throws(() => validateConfig({ ...config, ...patch })); });
function server({ missing = false, busy = false, cloud = false, hot = false, failUnload = false } = {}) {
  const calls = []; let resident = [], n = 0;
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname, body = init.body ? JSON.parse(init.body) : null; calls.push({ path, body, redirect: init.redirect });
    let data;
    if (path === '/api/health') data = {};
    else if (path === '/api/version') data = { version: 'test runtime' };
    else if (path === '/api/tags') data = { models: (missing ? [] : SOAK_LANES).map((name) => ({ name })) };
    else if (path === '/api/ps') data = { models: busy ? [{ name: 'someone-elses', size: 1 }] : resident };
    else if (path === '/api/generate') { if (!failUnload) resident = []; data = { done: true, done_reason: failUnload ? 'stop' : 'unload' }; }
    else if (path === '/api/chat') {
      resident = [{ name: body.model, size: 1000, size_vram: 900 }];
      const content = body.model === 'router' ? '{"lane":"write"}' : body.model === 'writer' ? 'The cobalt lighthouse shines. It guides ships.' : body.model === 'coder' ? 'function add(a,b){return a+b;}' : body.model === 'vision' ? (body.messages[0].images[0] === colorImage(true) ? 'red' : 'blue') : 'No. A blicket is a dax and no dax is a wug.';
      data = { model: cloud ? 'remote-model' : body.model, done: true, done_reason: 'stop', eval_count: 10, eval_duration: 1e9, message: { content } };
    } else throw new Error('unexpected route');
    return new Response(JSON.stringify(data), { status: 200 });
  };
  return { calls, fetchImpl, sample: () => ({ hostTotalBytes: 24 * 2 ** 30, hostAvailableBytes: 16 * 2 ** 30, rssBytes: 100, gpuPct: 20, hot }), crashes: () => [], wait: async () => {}, now: () => ++n };
}
test('real orchestration uses production router/writer and image-bearing HTTP probes; unloads each model', async () => { const deps = server(); const r = await runWorkSoak(config, deps); assert.equal(r.status, 'complete'); assert.equal(r.result.localCompletedJobs, 1); assert.equal(r.result.localGeneratedTokens, 60); assert.equal(r.unloads.length, 6); assert.ok(r.unloads.every((u) => u.settled)); assert.equal(deps.calls.filter((c) => c.path === '/api/chat' && c.body.messages.some((m) => m.images)).length, 2); assert.ok(deps.calls.every((c) => c.redirect === 'error')); assert.ok(r.result.failures.every((f) => f.code === 'BASELINE_UNAVAILABLE')); });
test('preflight never runs, pulls or unloads models', async () => { const deps = server(); const r = await runWorkSoak(config, { ...deps, preflightOnly: true }); assert.equal(r.status, 'preflight-only'); assert.equal(r.result.ok, false); assert.ok(deps.calls.every((c) => !c.body)); });
test('busy endpoint and missing models abort without inference or unload', async () => { for (const option of [{ busy: true }, { missing: true }]) { const deps = server(option); const r = await runWorkSoak(config, deps); assert.equal(r.status, 'aborted'); assert.ok(deps.calls.every((c) => !c.body)); } });
test('thermal abort never starts inference', async () => { const deps = server({ hot: true }); const r = await runWorkSoak(config, deps); assert.ok(r.result.failures.some((f) => f.code === 'THERMAL_ABORT')); assert.ok(deps.calls.every((c) => !c.body)); });
test('foreign provider model cannot claim local completion', async () => { const deps = server({ cloud: true }); const r = await runWorkSoak(config, deps); assert.equal(r.result.localCompletedJobs, 0); assert.equal(r.result.ok, false); });
test('failed unload stops next work and fails the run', async () => { const deps = server({ failUnload: true }); const r = await runWorkSoak(config, deps); assert.equal(r.status, 'aborted'); assert.ok(r.result.failures.some((f) => f.code === 'UNLOAD_OR_MEMORY_RECOVERY_FAILED')); assert.equal(deps.calls.filter((c) => c.path === '/api/chat').length, 1); });

test('thermal command errors are unknown, never reported as heat or safe', () => { assert.equal(parseThermal('Error:Failed to get thermal warning level with error code 0xe00002bc'), null); assert.equal(parseThermal('No thermal warning level has been recorded'), false); assert.equal(parseThermal('CPU_Speed_Limit = 80'), true); assert.equal(parseThermal('Thermal_Level = 1'), true); assert.equal(parseThermal(''), null); });
test('provided hardware identity only retains chip and memory, never serials', () => { assert.deepEqual(hardwareIdentity({ SPHardwareDataType: [{ chip_type: 'Apple M5 Pro', physical_memory: '24 GB', serial_number: 'private' }] }), { chip: 'Apple M5 Pro', ramGb: 24, source: 'provided-system-profiler-json' }); assert.deepEqual(hardwareIdentity({}), { chip: null, ramGb: null }); });
test('runner can satisfy all gates with measured identity and matching baselines in fixtures only', async () => { const r = await runWorkSoak(config, { ...server(), identity: { chip: 'test chip', ramGb: 24, source: 'provided-system-profiler-json' }, baseline }); assert.equal(r.result.ok, true); });
test('failed cloud calls do not count as completed cloud jobs', () => { const r = evidence(); r.receipts.forEach((x) => { x.provider = 'cloud'; x.outcome = 'error'; }); assert.equal(check(r).cloudCompletedJobs, 0); });
test('unavailable thermal telemetry aborts without any inference', async () => { const deps = server(); const r = await runWorkSoak(config, { ...deps, sample: () => ({ hostTotalBytes: 24 * 2 ** 30, hostAvailableBytes: 16 * 2 ** 30, rssBytes: 100, gpuPct: 20, hot: null }) }); assert.ok(r.result.failures.some((f) => f.code === 'THERMAL_EVIDENCE_MISSING')); assert.ok(deps.calls.every((c) => !c.body)); });
test('baseline matching checks every context, not just the first model call', () => { const r = evidence(); r.receipts.push({ ...r.receipts[1], id: 'writer-other-context', context: 16384 }); has(r, 'BASELINE_MISMATCH'); });
test('missing RSS, missing GPU, and unreserved endpoint fail before any inference', async () => {
  for (const [patch, samplePatch, code] of [[{}, { hostTotalBytes: 24 * 2 ** 30, hostAvailableBytes: 16 * 2 ** 30, rssBytes: null }, 'RSS_TELEMETRY_MISSING'], [{}, { gpuPct: null }, 'GPU_TELEMETRY_MISSING'], [{ exclusive: false }, {}, 'EXCLUSIVE_ENDPOINT_REQUIRED']]) {
    const deps = server(); const r = await runWorkSoak({ ...config, ...patch }, { ...deps, sample: () => ({ hostTotalBytes: 24 * 2 ** 30, hostAvailableBytes: 16 * 2 ** 30, rssBytes: 100, gpuPct: 20, hot: false, ...samplePatch }) });
    assert.ok(r.result.failures.some((f) => f.code === code)); assert.ok(deps.calls.every((c) => !c.body));
  }
});
test('failed HTTP call is recorded and cleaned up, never completed', async () => {
  const deps = server(), network = deps.fetchImpl;
  const r = await runWorkSoak(config, { ...deps, fetchImpl: async (url, init) => new URL(url).pathname === '/api/chat' ? new Response(JSON.stringify({ error: 'failure' }), { status: 500 }) : network(url, init) });
  assert.equal(r.status, 'aborted'); assert.equal(r.result.localCompletedJobs, 0); assert.equal(r.result.failedCalls, 1); assert.ok(r.unloads[0].settled);
});
test('mid-inference thermal warning aborts, unloads owned model, and prevents later jobs', async () => {
  const deps = server(); let samples = 0;
  const r = await runWorkSoak(config, { ...deps, sample: () => ({ hostTotalBytes: 24 * 2 ** 30, hostAvailableBytes: 16 * 2 ** 30, rssBytes: 100, gpuPct: 20, hot: ++samples === 3 }) });
  assert.ok(r.result.failures.some((f) => f.code === 'THERMAL_ABORT')); assert.equal(r.status, 'aborted'); assert.equal(r.result.localCompletedJobs, 0); assert.equal(deps.calls.filter((c) => c.path === '/api/chat').length, 1); assert.ok(r.unloads[0].settled);
});
test('recovery requires three consecutive samples inside the memory tolerance', async () => {
  const deps = server(); let samples = 0;
  const r = await runWorkSoak(config, { ...deps, sample: () => ({ hostTotalBytes: 24 * 2 ** 30, hostAvailableBytes: 16 * 2 ** 30, rssBytes: ++samples < 3 ? 100 : 100 * 2 ** 20, gpuPct: 20, hot: false }) });
  assert.equal(r.status, 'aborted'); assert.ok(r.result.failures.some((f) => f.code === 'UNLOAD_OR_MEMORY_RECOVERY_FAILED')); assert.equal(r.result.localCompletedJobs, 0);
});

test('loopback response alone is not proof that Ollama ran a local model', () => { const r = evidence(); r.receipts.forEach((x) => { x.residentModelBytes = null; x.residentGpuBytes = null; }); has(r, 'ZERO_LOCAL_COMPLETED_JOBS'); has(r, 'ZERO_LOCAL_GENERATED_TOKENS'); });

test('warm residency is not mislabeled as active inference and is never unloaded', async () => { const deps = server({ busy: true }); const r = await runWorkSoak(config, deps); assert.equal(r.admission.inFlight, null); assert.equal(r.admission.residentBefore[0].model, 'someone-elses'); assert.ok(r.result.failures.some((f) => f.code === 'PREEXISTING_RESIDENCY_REQUIRES_RESERVATION')); assert.ok(!r.result.failures.some((f) => f.code === 'ENDPOINT_BUSY')); assert.ok(deps.calls.every((c) => !c.body)); });
for (const kind of ['health', 'thermal']) test(`deferred in-flight ${kind} failure cannot be lost after a successful provider reply`, async () => {
  const deps = server(); let tick, deferred = false, injected = false, thermalOnce = false;
  let release, entered; const gate = new Promise((r) => { release = r; }), started = new Promise((r) => { entered = r; });
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    if (deferred && !injected && path === (kind === 'health' ? '/api/health' : '/api/ps')) {
      injected = true; entered(); await gate;
      if (kind === 'health') return new Response('{}', { status: 503 });
      thermalOnce = true;
    }
    const response = await deps.fetchImpl(url, init);
    if (path === '/api/chat' && !deferred) {
      await tick(); // first observation proves residency, so the original race could otherwise pass
      deferred = true; void tick(); // hold a second observation while the successful reply returns
    }
    return response;
  };
  const pending = runWorkSoak(config, { ...deps, fetchImpl, schedule: (fn) => { tick = fn; return 1; }, cancel: () => {},
    sample: () => { const hot = thermalOnce; thermalOnce = false; return { hostTotalBytes: 24 * 2 ** 30, hostAvailableBytes: 16 * 2 ** 30, rssBytes: 100, gpuPct: 20, hot }; } });
  await started;
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(deps.calls.filter((c) => c.path === '/api/generate').length, 0, 'no cleanup before pending evidence settles');
  release();
  const r = await pending;
  assert.equal(r.status, 'aborted'); assert.equal(r.result.ok, false); assert.equal(r.result.localCompletedJobs, 0);
  assert.ok(r.result.failures.some((f) => f.code === (kind === 'health' ? 'HEALTH_FAILED' : 'THERMAL_ABORT')));
  assert.ok(r.unloads[0].acknowledged && r.unloads[0].absent && r.unloads[0].settled, 'cleanup still runs');
  assert.equal(deps.calls.filter((c) => c.path === '/api/chat').length, 1, 'no later job begins');
});

test('host memory parser excludes active, wired, compressed and duplicate purgeable pages', () => {
  assert.deepEqual(parseHostMemory('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 10.\nPages inactive: 20.\nPages speculative: 3.\nPages purgeable: 5.\nPages active: 90.', 24 * 2 ** 30), { hostTotalBytes: 24 * 2 ** 30, hostAvailableBytes: 33 * 16384 });
  assert.equal(parseHostMemory('', 24 * 2 ** 30).hostAvailableBytes, null);
});
test('missing headroom or insufficient admission budget never loads or unloads a model', async () => {
  for (const available of [null, 7 * 2 ** 30]) {
    const deps = server();
    const r = await runWorkSoak({ ...config, maxResidentBytes: 8 * 2 ** 30 }, { ...deps, sample: () => ({ ...deps.sample(), hostAvailableBytes: available }) });
    assert.equal(r.status, 'aborted');
    assert.ok(r.failures.some((f) => f.code === (available == null ? 'HOST_MEMORY_TELEMETRY_MISSING' : 'HOST_MEMORY_ADMISSION_FAILED')));
    assert.ok(deps.calls.every((c) => !c.body));
  }
});
test('host pressure during load aborts even before model residency is reported', async () => {
  const deps = server(); let samples = 0;
  const r = await runWorkSoak(config, { ...deps,
    sample: () => ({ ...deps.sample(), hostAvailableBytes: ++samples === 3 ? 5 * 2 ** 30 : 16 * 2 ** 30 }),
    fetchImpl: async (url, init) => {
      const response = await deps.fetchImpl(url, init);
      return new URL(url).pathname === '/api/ps' ? new Response('{"models":[]}') : response;
    } });
  assert.ok(r.failures.some((f) => f.code === 'HOST_MEMORY_RESERVE_ABORT'));
  assert.equal(r.result.localCompletedJobs, 0);
  assert.equal(deps.calls.filter((c) => c.path === '/api/chat').length, 1);
  assert.ok(r.unloads[0].settled);
});
