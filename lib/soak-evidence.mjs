// Run-scoped evidence only. Model requests are not jobs, and text is not a provider receipt.
export const SOAK_LANES = Object.freeze(['router', 'writer', 'coder', 'vision', 'reasoning']);
export const positive = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;
export const nonnegative = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
export function counterDelta(before, after) {
  if (!before || !after || !nonnegative(before.generated) || !nonnegative(after.generated) || !before.since || !after.since) return { error: 'COUNTER_MISSING', delta: null };
  if (before.since !== after.since || after.generated < before.generated) return { error: 'COUNTER_RESET', delta: null };
  return { error: null, delta: after.generated - before.generated };
}
export function compareBaseline(actual, bench) {
  if (!actual.chip || !actual.ramGb || !actual.runtime || !actual.model || !actual.context) return { status: 'unavailable', reason: 'machine/model/context/runtime identity missing' };
  if (!bench) return { status: 'unavailable', reason: 'no measured baseline supplied' };
  const row = bench.results?.find((r) => r.model === actual.model);
  if (!row) return { status: 'unavailable', reason: 'model absent from measured baseline' };
  const mismatches = [];
  for (const [key, value] of Object.entries({ chip: bench.host?.chip, ramGb: bench.host?.ramGb, runtime: bench.host?.ollama, context: row.context ?? bench.context })) {
    if (actual[key] !== value) mismatches.push({ key, actual: actual[key], baseline: value ?? null });
  }
  if (bench.simulated) mismatches.push({ key: 'simulated', baseline: bench.simulated });
  if (mismatches.length) return { status: 'mismatch', mismatches };
  if (!positive(row.speed?.genTokS) || !positive(actual.tokS)) return { status: 'unavailable', reason: 'decode speed missing' };
  // Different prompts and lengths are explicitly not a speed-regression verdict.
  return { status: 'matched', measuredTokS: row.speed.genTokS, actualTokS: actual.tokS, ratio: actual.tokS / row.speed.genTokS, comparableWorkload: false };
}
export function evaluateSoak(report, { minJobs = report.minJobs ?? 5, baseline = null } = {}) {
  const failures = [...(report.failures ?? [])];
  const fail = (code, detail = '') => failures.push({ code, detail });
  if (!Number.isInteger(minJobs) || minJobs < 1) fail('INVALID_JOB_COUNT');
  if (!report.runId || !Number.isFinite(report.startedMs) || !Number.isFinite(report.endedMs) || report.endedMs < report.startedMs) fail('RUN_WINDOW_MISSING');
  if (report.status !== 'complete') fail('RUN_INCOMPLETE', report.status ?? 'missing');
  const ids = new Set();
  const receipts = (report.receipts ?? []).filter((r) => {
    const inScope = r.runId === report.runId && typeof r.jobId === 'string' && r.jobId && SOAK_LANES.includes(r.lane)
      && Number.isFinite(r.startedMs) && Number.isFinite(r.endedMs) && r.startedMs >= report.startedMs && r.endedMs <= report.endedMs && r.endedMs >= r.startedMs;
    const unique = typeof r.id === 'string' && !ids.has(r.id); ids.add(r.id);
    if (!inScope || !unique) { fail('RECEIPT_SCOPE_INVALID', r.id); return false; }
    return true;
  });
  const validLocal = (r) => r.provider === 'ollama' && r.transport === 'loopback-http' && r.httpStatus === 200 && r.done === true
    && r.doneReason === 'stop' && r.outcome === 'ok' && positive(r.generated) && Number.isInteger(r.generated)
    && positive(r.residentModelBytes) && positive(r.residentGpuBytes) && positive(r.evalNs) && typeof r.model === 'string' && r.model.length > 0 && r.model === r.requestModel && Number.isInteger(r.context) && positive(r.context);
  const local = receipts.filter(validLocal);
  const tokens = local.reduce((n, r) => n + r.generated, 0);
  if (!tokens) fail('ZERO_LOCAL_GENERATED_TOKENS');
  for (const r of receipts) if (r.provider === 'ollama' && !validLocal(r)) fail('LOCAL_RECEIPT_INVALID', r.id);
  const jobs = report.jobs ?? [], jobIds = new Set(); let localJobs = 0, cloudJobs = 0;
  for (const job of jobs) {
    if (jobIds.has(job.id) || job.runId !== report.runId) { fail('JOB_SCOPE_INVALID', job.id); continue; } jobIds.add(job.id);
    if (job.status !== 'completed' || job.validation !== true) { fail('JOB_NOT_COMPLETED', job.id); continue; }
    const rs = receipts.filter((r) => r.jobId === job.id);
    if (rs.some((r) => r.provider !== 'ollama')) {
      if (rs.length && rs.every((r) => r.httpStatus === 200 && r.done === true && r.doneReason === 'stop' && r.outcome === 'ok' && r.validated === true)) cloudJobs++;
      fail('CLOUD_SYNTHETIC_JOB', job.id); continue;
    }
    // A completed synthetic job is a real router decision AND a validated writer answer, not two requests.
    if (job.route?.by === 'router' && job.route.lane === 'write' && ['router', 'writer'].every((lane) => rs.some((r) => r.lane === lane && validLocal(r) && r.validated === true))) localJobs++;
    else fail('JOB_LOCAL_PROVENANCE_MISSING', job.id);
  }
  if (!localJobs) fail('ZERO_LOCAL_COMPLETED_JOBS');
  if (localJobs < minJobs) fail('INSUFFICIENT_LOCAL_JOBS', `${localJobs}/${minJobs}`);
  const lanes = Object.fromEntries(SOAK_LANES.map((lane) => {
    const rs = local.filter((r) => r.lane === lane), generated = rs.reduce((n, r) => n + r.generated, 0), ns = rs.reduce((n, r) => n + r.evalNs, 0);
    if (!rs.some((r) => r.validated === true)) fail('LANE_UNEXERCISED', lane);
    const groups = [...new Set(rs.map((r) => JSON.stringify([r.model, r.context])))];
    const comparisons = groups.map((key) => {
      const [model, context] = JSON.parse(key);
      const mr = rs.filter((r) => r.model === model && r.context === context), totalNs = mr.reduce((n, r) => n + r.evalNs, 0);
      const comparison = compareBaseline({ ...report.machine, runtime: report.runtime, model, context: mr[0]?.context, tokS: totalNs ? mr.reduce((n, r) => n + r.generated, 0) * 1e9 / totalNs : null }, baseline);
      if (comparison.status !== 'matched') fail(`BASELINE_${comparison.status.toUpperCase()}`, `${lane}: ${JSON.stringify(comparison)}`);
      return { model, context, ...comparison };
    });
    return [lane, { calls: rs.length, generated, decodeTokS: ns ? generated * 1e9 / ns : null, comparisons }];
  }));
  if (!report.health?.length || report.health.some((h) => h.status !== 200)) fail('HEALTH_FAILED_OR_MISSING');
  if (!Array.isArray(report.crashes)) fail('CRASH_EVIDENCE_MISSING'); else if (report.crashes.length) fail('CRASH_DETECTED');
  if (report.counters) { const d = counterDelta(report.counters.before, report.counters.after); if (d.error) fail(d.error); }
  const samples = report.samples ?? [], inference = samples.filter((s) => s.phase === 'inference');
  const memory = inference.map((s) => s.modelBytes).filter(positive), gpu = inference.map((s) => s.gpuPct).filter(nonnegative);
  if (!memory.length) fail('INFERENCE_MEMORY_MISSING');
  if (!gpu.length) fail('GPU_TELEMETRY_MISSING'); else if (!gpu.some(positive)) fail('GPU_ACTIVITY_NOT_OBSERVED');
  if (!report.unloads?.length || report.unloads.some((u) => !u.acknowledged || !u.absent || !u.settled)) fail('UNLOAD_OR_MEMORY_RECOVERY_FAILED');
  const baselineSample = samples.find((s) => s.phase === 'baseline');
  const settled = samples.filter((s) => s.phase === 'settled').slice(-3);
  if (!baselineSample || !nonnegative(baselineSample.rssBytes) || settled.length < 3 || settled.some((s) => !nonnegative(s.rssBytes) || s.modelBytes !== 0 || s.rssBytes > baselineSample.rssBytes + (report.recoveryToleranceBytes ?? 64 * 2 ** 20))) fail('SETTLED_MEMORY_RECOVERY_MISSING');
  return { ok: failures.length === 0, failures, localGeneratedTokens: tokens, localCompletedJobs: localJobs, cloudCompletedJobs: cloudJobs,
    attemptedJobs: jobs.length, failedCalls: receipts.filter((r) => r.outcome !== 'ok').length, lanes,
    inferenceMemoryPeakBytes: memory.length ? Math.max(...memory) : null, gpuPeakPct: gpu.length ? Math.max(...gpu) : null };
}
