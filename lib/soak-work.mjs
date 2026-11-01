// Observable, bounded local inference. No engine internals, cloud fallback, downloads or owner-chat access.
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { homedir, totalmem } from 'node:os';
import { join } from 'node:path';
import { routeLane, ROUTER_CONTEXT } from './fast-route.mjs';
import { localModelTurn } from './local-turn.mjs';
import { chat } from './tool-call.mjs';
import { evaluateSoak, SOAK_LANES } from './soak-evidence.mjs';
import { colorImage, PROBES, writerJob } from './soak-fixtures.mjs';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function loopbackBase(value) {
  const u = new URL(value);
  if (u.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(u.hostname) || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw new Error('LOOPBACK_ONLY');
  return u.origin;
}
export function parseGpu(text) {
  // Same non-root AGXAccelerator signal as ronin-launcher/app/src-tauri/src/machine.rs.
  const match = /"Device Utilization %"\s*=\s*(\d+)/.exec(text);
  const n = match ? Number(match[1]) : null;
  return n != null && n >= 0 && n <= 100 ? n : null;
}
function command(path, args) { try { return execFileSync(path, args, { encoding: 'utf8', timeout: 3000, maxBuffer: 4 << 20, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; } }
export function parseThermal(therm) {
  if (therm == null || /error|failed/i.test(therm)) return null;
  const level = /(?:thermal warning level|Thermal_Level)\s*[:=]?\s*(\d+)/i.exec(therm);
  const limit = /CPU_Speed_Limit\s*=\s*(\d+)/.exec(therm);
  if (!level && !limit && !/No thermal warning level has been recorded/i.test(therm)) return null;
  return Number(level?.[1] ?? 0) > 0 || Number(limit?.[1] ?? 100) < 100;
}
// Admission policy, not a measured model peak. Keep OS/app reserve plus loader overhead.
export const HOST_RESERVE_FRACTION = 0.25;
export const LOAD_OVERHEAD_BYTES = 2 ** 30;
export function parseHostMemory(text, totalBytes) {
  const page = /page size of (\d+) bytes/.exec(text ?? '');
  const counts = ['free', 'inactive', 'speculative'].map((name) =>
    new RegExp(`Pages ${name}:\\s*(\\d+)\\.`).exec(text ?? '')?.[1]);
  const available = page && counts.every((n) => n != null)
    ? Number(page[1]) * counts.reduce((sum, n) => sum + Number(n), 0) : null;
  return { hostTotalBytes: totalBytes, hostAvailableBytes: available };
}
function checkHostMemory(s, budget = 0) {
  if (!Number.isFinite(s.hostTotalBytes) || s.hostTotalBytes <= 0 ||
      !Number.isFinite(s.hostAvailableBytes) || s.hostAvailableBytes < 0 || s.hostAvailableBytes > s.hostTotalBytes)
    throw new Error('HOST_MEMORY_TELEMETRY_MISSING');
  const required = s.hostTotalBytes * HOST_RESERVE_FRACTION + budget + (budget ? LOAD_OVERHEAD_BYTES : 0);
  if (s.hostAvailableBytes < required) throw new Error(budget ? 'HOST_MEMORY_ADMISSION_FAILED' : 'HOST_MEMORY_RESERVE_ABORT');
}
export function machineSample() {
  // Never sysctl or sudo. Unknown telemetry stays null, not a fabricated zero.
  const gpu = command('/usr/sbin/ioreg', ['-r', '-d', '1', '-c', 'AGXAccelerator']);
  const ps = command('/bin/ps', ['-axo', 'rss=,comm=']);
  let rssBytes = ps == null ? null : 0;
  for (const line of (ps ?? '').split('\n')) { const m = /^\s*(\d+)\s+(.+)$/.exec(line); if (m && /ollama|llama-server|Kingmaker\.app\/Contents\//.test(m[2])) rssBytes += Number(m[1]) * 1024; }
  const therm = command('/usr/bin/pmset', ['-g', 'therm']);
  const hot = parseThermal(therm);
  return { rssBytes, gpuPct: gpu == null ? null : parseGpu(gpu), hot, ...parseHostMemory(command('/usr/bin/vm_stat', []), totalmem()) };
}
export function crashReports(since) {
  const dir = join(homedir(), 'Library/Logs/DiagnosticReports');
  try { return readdirSync(dir).filter((f) => /^(Kingmaker|Solomon|ollama|llama)/i.test(f) && statSync(join(dir, f)).mtimeMs >= since); } catch { return null; }
}
// Optional caller-supplied observation, never inferred from the selected model pack.
// The CLI can read a freshly exported system_profiler JSON, without collecting serial numbers.
export function hardwareIdentity(data) {
  const h = data?.SPHardwareDataType?.[0];
  const ram = /^(\d+(?:\.\d+)?) GB$/.exec(h?.physical_memory ?? '');
  return h?.chip_type && ram ? { chip: h.chip_type, ramGb: Number(ram[1]), source: 'provided-system-profiler-json' } : { chip: null, ramGb: null };
}
export function validateConfig(config) {
  const base = loopbackBase(config.base ?? 'http://127.0.0.1:11434');
  const healthBase = loopbackBase(config.healthBase ?? 'http://127.0.0.1:3001');
  for (const lane of SOAK_LANES) if (typeof config.models?.[lane] !== 'string' || !config.models[lane] || config.models[lane].length > 200) throw new Error(`MODEL_CONFIG_MISSING:${lane}`);
  const n = config.minJobs ?? 5, context = config.context;
  if (!Number.isInteger(n) || n < 1 || n > 20) throw new Error('JOB_COUNT_MUST_BE_1_TO_20');
  if (!Number.isInteger(context) || context < 2048 || context > 16384) throw new Error('CONTEXT_MUST_BE_2048_TO_16384');
  const timeoutMs = config.timeoutMs ?? 90000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 180000) throw new Error('INVALID_TIMEOUT');
  const maxResidentBytes = config.maxResidentBytes;
  if (!Number.isFinite(maxResidentBytes) || maxResidentBytes <= 0 || maxResidentBytes > 40 * 2 ** 30) throw new Error('MEMORY_BUDGET_REQUIRED');
  return { ...config, base, healthBase, minJobs: n, context, timeoutMs, maxResidentBytes };
}
export async function runWorkSoak(input, { fetchImpl = fetch, sample = machineSample, crashes = crashReports, wait = sleep, now = Date.now, log = () => {}, baseline = null, preflightOnly = false, identity = null, schedule = setInterval, cancel = clearInterval } = {}) {
  const config = validateConfig(input), runId = randomUUID(), startedMs = now();
  const report = { schema: 1, runId, startedMs, endedMs: null, status: 'running', minJobs: config.minJobs,
    scope: 'source-wrapper synthetic jobs (routeLane → localModelTurn); coder/vision/reasoning are direct model probes, not closed-engine jobs',
    machine: identity?.source === 'provided-system-profiler-json' ? identity : { chip: null, ramGb: null }, runtime: null, config: { ...config, machine: undefined }, receipts: [], jobs: [], samples: [], unloads: [], health: [], crashes: null, failures: [],
    recoveryToleranceBytes: 64 * 2 ** 20 };
  // Hardware identity is intentionally not inferred from a profile or historical benchmark.
  const fail = (code, detail = '') => report.failures.push({ code, detail });
  const api = async (base, path, body, timeout = 5000) => {
    const r = await fetchImpl(base + path, { method: body ? 'POST' : 'GET', redirect: 'error', headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeout) });
    if (!r.ok) throw new Error(`${path}:HTTP_${r.status}`);
    return r.json();
  };
  const loaded = async () => { const j = await api(config.base, '/api/ps'); if (!Array.isArray(j.models)) throw new Error('MODEL_RESIDENCY_MISSING'); return j.models; };
  const checkHealth = async () => {
    let status = 0; try { status = (await fetchImpl(config.healthBase + '/api/health', { redirect: 'error', signal: AbortSignal.timeout(4000) })).status; } catch { /* recorded below */ }
    report.health.push({ at: now(), status }); if (status !== 200) throw new Error('HEALTH_FAILED');
  };
  const takeSample = async (phase) => {
    const models = await loaded(), s = { ...sample(), at: now(), phase, models: models.map((m) => ({ name: m.name ?? m.model, bytes: m.size, gpuBytes: m.size_vram ?? null })), modelBytes: models.every((m) => typeof m.size === 'number' && m.size >= 0) ? models.reduce((n, m) => n + m.size, 0) : null };
    report.samples.push(s);
    if (s.hot !== false) throw new Error(s.hot ? 'THERMAL_ABORT' : 'THERMAL_EVIDENCE_MISSING');
    if (s.modelBytes == null) throw new Error('MEMORY_EVIDENCE_MISSING');
    if (s.modelBytes > config.maxResidentBytes) throw new Error('MEMORY_BUDGET_EXCEEDED');
    checkHostMemory(s);
    return s;
  };
  let activeModel = null, baselineRss = null;
  const release = async (model) => {
    const u = { model, acknowledged: false, absent: false, settled: false }; report.unloads.push(u);
    try {
      const j = await api(config.base, '/api/generate', { model, keep_alive: 0 }, 15000);
      u.acknowledged = j.done === true && j.done_reason === 'unload';
      let stable = 0;
      for (let i = 0; i < 10; i++) {
        await wait(1000); const models = await loaded();
        u.absent = !models.some((m) => m.name === model || m.model === model);
        const s = await takeSample('settled');
        if (u.absent && models.length === 0 && baselineRss != null && s.rssBytes != null && s.rssBytes <= baselineRss + report.recoveryToleranceBytes) stable++; else stable = 0;
        if (stable >= 3) { u.settled = true; break; }
      }
    } catch (e) { u.error = e.message; }
    if (!u.acknowledged || !u.absent || !u.settled) throw new Error('UNLOAD_OR_MEMORY_RECOVERY_FAILED');
  };
  let sequence = 0;
  const invoke = async (lane, jobId, call, validate) => {
    if ((await loaded()).length) throw new Error('UNEXPECTED_RESIDENCY');
    await checkHealth(); checkHostMemory(await takeSample('before'), config.maxResidentBytes);
    activeModel = config.models[lane];
    const controller = new AbortController(), deadline = setTimeout(() => controller.abort(new Error('CALL_TIMEOUT')), config.timeoutMs);
    let sampling = null, sampleError = null;
    // Every caller joins the same sample. A timer tick still in flight is evidence we must await, not skip.
    const tick = () => {
      if (!sampling) sampling = (async () => {
        try { await takeSample('inference'); await checkHealth(); }
        catch (e) { if (!sampleError) { sampleError = e; fail(e.message); } controller.abort(e); }
      })().finally(() => { sampling = null; });
      return sampling;
    };
    const timer = schedule(tick, 1000);
    const own = [];
    const observedFetch = async (url, init) => {
      if (String(url) !== config.base + '/api/chat') throw new Error('UNEXPECTED_INFERENCE_ROUTE');
      const body = JSON.parse(init.body);
      if (body.model !== activeModel || body.stream !== false) throw new Error('INFERENCE_CONTRACT_CHANGED');
      body.options = { ...body.options, num_predict: lane === 'router' ? 20 : 256 };
      body.keep_alive = '30s'; // explicit bounded harness residency; routing choices are untouched
      const rec = { id: `${runId}:${++sequence}`, runId, jobId, lane, provider: 'ollama', transport: 'loopback-http', endpoint: '/api/chat',
        requestModel: body.model, context: body.options.num_ctx, startedMs: now(), endedMs: null, httpStatus: null, outcome: 'error', validated: false };
      report.receipts.push(rec); own.push(rec);
      try {
        const r = await fetchImpl(url, { ...init, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.any([controller.signal, init.signal].filter(Boolean)) });
        rec.httpStatus = r.status;
        const j = await r.clone().json();
        Object.assign(rec, { model: j.model, done: j.done, doneReason: j.done_reason, generated: j.eval_count, evalNs: j.eval_duration,
          outputSha256: createHash('sha256').update(String(j.message?.content ?? '')).digest('hex'),
          promptTokens: j.prompt_eval_count, promptNs: j.prompt_eval_duration, outcome: r.ok && !j.error ? 'ok' : 'error' });
        return r;
      } catch (e) { rec.error = e.name; throw e; } finally { rec.endedMs = now(); }
    };
    try {
      const result = await call(observedFetch);
      cancel(timer); // Freeze periodic sampling before draining and checking the final observation.
      await tick();
      if (sampleError) throw sampleError;
      const resident = report.samples.filter((s) => s.phase === 'inference').flatMap((s) => s.at >= own[0]?.startedMs ? s.models ?? [] : []).filter((m) => m.name === activeModel && m.bytes > 0 && m.gpuBytes > 0);
      own.forEach((r) => { r.residentModelBytes = resident.length ? Math.max(...resident.map((m) => m.bytes)) : null; r.residentGpuBytes = resident.length ? Math.max(...resident.map((m) => m.gpuBytes)) : null; });
      if (!resident.length) throw new Error(`LOCAL_RESIDENCY_NOT_OBSERVED:${lane}`);
      if (!own.length || own.some((r) => r.httpStatus !== 200 || r.done !== true || r.doneReason !== 'stop' || r.model !== r.requestModel || !(r.generated > 0) || !(r.evalNs > 0))) throw new Error(`INFERENCE_RECEIPT_INVALID:${lane}`);
      const valid = validate(result); own.forEach((r) => { r.validated = valid; });
      if (!valid) throw new Error(`VALIDATION_FAILED:${lane}`);
      return result;
    } finally {
      clearTimeout(deadline); cancel(timer);
      // Drain even when the provider failed; cleanup must not overlap a late sample.
      if (sampling) await sampling;
      const model = activeModel;
      try { await release(model); activeModel = null; } catch (e) { fail(e.message, model); throw e; }
      await checkHealth();
      // A late sampling error cannot be swallowed by a pending return from the try block.
      if (sampleError) throw sampleError;
    }
  };
  try {
    await checkHealth(); report.runtime = (await api(config.base, '/api/version')).version ?? null;
    const tags = (await api(config.base, '/api/tags')).models;
    if (!Array.isArray(tags)) throw new Error('INSTALLED_MODELS_MISSING');
    report.installed = SOAK_LANES.map((lane) => ({ lane, model: config.models[lane], present: tags.some((m) => (m.name === config.models[lane] || m.model === config.models[lane]) && !m.remote_host && !m.remote_model) }));
    for (const m of report.installed) if (!m.present) fail('MODEL_NOT_INSTALLED', `${m.lane}:${m.model}`);
    if (report.failures.length) throw new Error('PREFLIGHT_FAILED');
    const residentBefore = await loaded();
    report.admission = { reservation: config.exclusive === true ? 'operator-declared' : 'not-reserved', inFlight: null,
      residentBefore: residentBefore.map((m) => ({ model: m.name ?? m.model, bytes: m.size ?? null })) };
    // Residency is NOT an in-flight signal. A cold, reserved endpoint is required so cleanup cannot unload
    // another client's warm model. An operator declaration or harness-only lock cannot reserve production.
    if (residentBefore.length) throw new Error('PREEXISTING_RESIDENCY_REQUIRES_RESERVATION');
    const initial = await takeSample('baseline');
    baselineRss = initial.rssBytes;
    if (initial.gpuPct == null) throw new Error('GPU_TELEMETRY_MISSING');
    if (baselineRss == null) throw new Error('RSS_TELEMETRY_MISSING');
    checkHostMemory(initial, config.maxResidentBytes);
    report.admission.hostMemory = { reserveFraction: HOST_RESERVE_FRACTION, loadOverheadBytes: LOAD_OVERHEAD_BYTES, modelBudgetBytes: config.maxResidentBytes, availableBytes: initial.hostAvailableBytes, totalBytes: initial.hostTotalBytes };
    if (preflightOnly) { report.status = 'preflight-only'; return report; }
    if (config.exclusive !== true) throw new Error('EXCLUSIVE_ENDPOINT_REQUIRED');
    for (let i = 0; i < config.minJobs; i++) {
      const fixture = writerJob(i), job = { id: `${runId}:job:${i}`, runId, status: 'running', validation: false };
      report.jobs.push(job); log(`Synthetic job ${i + 1}/${config.minJobs}`);
      try {
        job.route = await invoke('router', job.id, (fetchImpl) => routeLane(fixture.prompt, { model: config.models.router, base: config.base, timeoutMs: config.timeoutMs, fetchImpl }), (r) => r.by === 'router' && r.lane === 'write');
        await invoke('writer', job.id, (fetchImpl) => localModelTurn(config.models.writer, fixture.prompt, { context: config.context, temperature: 0, base: config.base, fetchImpl }), fixture.validate);
        job.validation = true; job.status = 'completed';
      } catch (e) { job.status = 'failed'; throw e; }
    }
    for (const probe of PROBES) {
      // Both colors must pass: a vision model saying the same color without seeing the image fails.
      for (const red of (probe.image ? [true, false] : [null])) {
        const id = `${runId}:probe:${probe.lane}:${red}`; log(`Probe ${probe.lane}${red == null ? '' : red ? ' red' : ' blue'}`);
        await invoke(probe.lane, id, (fetchImpl) => chat({ model: config.models[probe.lane], base: config.base, timeoutMs: config.timeoutMs, fetchImpl,
          options: { num_ctx: config.context, num_predict: 256 }, messages: [{ role: 'user', content: probe.prompt, ...(probe.image ? { images: [colorImage(red)] } : {}) }] }),
        (j) => probe.validate(String(j.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim(), red));
      }
    }
    report.status = 'complete';
  } catch (e) { fail(e.message); report.status = 'aborted'; }
  finally {
    if (activeModel) { try { await release(activeModel); } catch (e) { fail(e.message, activeModel); } }
    report.endedMs = now(); report.crashes = crashes(startedMs);
    report.result = evaluateSoak(report, { baseline });
  }
  return report;
}
