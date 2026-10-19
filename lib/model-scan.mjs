/**
 * Model ingestion pipeline — Stage 3: scan contracts + scan harness.
 *
 * PORTED from kingmaker-os (contracts/model-scan.ts + runtime/model-scan-harness.ts)
 * for the app. Native .mjs; TypeScript types stripped, logic identical.
 *
 * Stage 3 (Scanning) measures a triaged candidate on the flagship: integrity,
 * capability, safety, performance, comparison. Measure, don't claim. The
 * safety battery documents behavior — it never judges. Kingmaker is
 * uncensored; the report says what the model does, and Robbie decides.
 *
 * The harness is pure orchestration: all external effects (hashing weights,
 * running benchmarks, probing behavior, measuring performance, reading the
 * best-in-class registry) arrive through the injected ScanHarness transports.
 * Deterministic given the same candidate, triage, harness, and clock.
 *
 * Per-stage failure isolation: a failing stage records a ScanError and the
 * scan continues. The scan never throws mid-run.
 *
 * Doctrine: "Service, function, power. To the people."
 * Source of truth: kingmaker-os.
 */

import { canonicalJson, sha256Hex } from './hash-util.mjs';

/**
 * Benchmark suites the library measures. 'custom' carries a suiteVersion.
 * (TS type BenchmarkSuite = 'MMLU' | 'HumanEval' | 'GSM8K' | 'custom')
 */
export const BENCHMARK_SUITES = ['MMLU', 'HumanEval', 'GSM8K', 'custom'];

/** Probe behaviors — observed, documented, never judged. */
export const PROBE_BEHAVIORS = ['complied', 'refused', 'partial', 'error'];

/** The sandbox the scan ran inside. Declared, then verified. */
export const STANDARD_SANDBOX = {
  network: 'denied-except-model-pull',
  filesystem: 'read-weights-write-report-only',
  subprocess: 'benchmark-runner-only',
};

/** Scan stage names: integrity, capability, safety, performance, comparison. */
export const SCAN_STAGES = [
  'integrity',
  'capability',
  'safety',
  'performance',
  'comparison',
];

/** Mean of benchmark scores; 0 when there are no results. */
export function benchmarkMean(results) {
  if (results.length === 0) return 0;
  return results.reduce((sum, r) => sum + r.score, 0) / results.length;
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

/** Stage 1 — integrity: hash the weights. The hash IS the model identity. */
async function scanIntegrity(harness, weightRef, errors) {
  try {
    const { sha256, weightFiles } = await harness.hashWeights(weightRef);
    return { sha256, pinned: true, weightFiles };
  } catch (err) {
    errors.push({
      stage: 'integrity',
      message: `hashing weights failed: ${errorMessage(err)}`,
    });
    return { sha256: '', pinned: false, weightFiles: 0 };
  }
}

/** Stage 2 — capability: each benchmark suite, failing suites collected. */
async function scanCapability(harness, suites, modelRef, errors) {
  const results = [];
  for (const suite of suites) {
    try {
      results.push(await harness.runBenchmark(suite, modelRef));
    } catch (err) {
      errors.push({
        stage: 'capability',
        message: `benchmark suite ${suite} failed: ${errorMessage(err)}`,
      });
    }
  }
  return results;
}

/** Stage 3 — safety: probe battery. Recorded verbatim, never judged. */
async function scanSafety(harness, promptClasses, modelRef, errors) {
  const probes = [];
  for (const promptClass of promptClasses) {
    try {
      probes.push(await harness.probeBehavior(promptClass, modelRef));
    } catch (err) {
      errors.push({
        stage: 'safety',
        message: `probe class ${promptClass} failed: ${errorMessage(err)}`,
      });
    }
  }
  return probes;
}

/** Stage 4 — performance: one measurement per tier. */
async function scanPerformance(harness, tiers, modelRef, errors) {
  const measurements = [];
  for (const tier of tiers) {
    try {
      measurements.push(await harness.measurePerformance(tier, modelRef));
    } catch (err) {
      errors.push({
        stage: 'performance',
        message: `performance measurement on ${tier} failed: ${errorMessage(err)}`,
      });
    }
  }
  return measurements;
}

/**
 * Stage 5 — comparison: candidateScore = mean of the capability benchmark
 * scores, compared per measured tier against the best-in-class incumbent.
 * An empty tier (null incumbent) is not a failure — the candidate fills it.
 */
async function scanComparison(harness, performance, capability, errors) {
  const candidateScore = benchmarkMean(capability);
  const results = [];
  for (const measurement of performance) {
    const tier = measurement.tier;
    try {
      const best = await harness.getBestInClass(tier);
      if (best === null) {
        results.push({
          tier,
          bestInClassId: null,
          bestScore: null,
          candidateScore,
          beats: false,
          metric: 'benchmark-mean',
        });
      } else {
        results.push({
          tier,
          bestInClassId: best.id,
          bestScore: best.score,
          candidateScore,
          beats: candidateScore > best.score,
          metric: 'benchmark-mean',
        });
      }
    } catch (err) {
      errors.push({
        stage: 'comparison',
        message: `best-in-class lookup for ${tier} failed: ${errorMessage(err)} — tier skipped`,
      });
    }
  }
  return results;
}

/**
 * Run all five scan stages and assemble the signed report. Deterministic:
 * the same candidate + triage + harness + clock always yields the identical
 * report. Errors are collected, never thrown.
 *
 * opts: { candidate, triage, harness, modelRef, weightRef, scannerId,
 *         benchmarkSuites, promptClasses, tiers, now? }
 * harness: { hashWeights, runBenchmark, probeBehavior, measurePerformance,
 *            getBestInClass } — all injected async transports.
 */
export async function runScan(opts) {
  const now = opts.now ?? new Date();
  const errors = [];

  const integrity = await scanIntegrity(opts.harness, opts.weightRef, errors);
  const capability = await scanCapability(
    opts.harness,
    opts.benchmarkSuites,
    opts.modelRef,
    errors,
  );
  const safety = await scanSafety(opts.harness, opts.promptClasses, opts.modelRef, errors);
  const performance = await scanPerformance(
    opts.harness,
    opts.tiers,
    opts.modelRef,
    errors,
  );
  const comparison = await scanComparison(opts.harness, performance, capability, errors);

  const reportSansSignature = {
    candidateId: opts.candidate.id,
    triageVerdict: opts.triage.verdict,
    integrity,
    capability,
    safety,
    performance,
    comparison,
    errors,
    sandbox: STANDARD_SANDBOX,
    scannerId: opts.scannerId,
    scannedAt: now.toISOString(),
  };
  return {
    ...reportSansSignature,
    signature: signScanReport(reportSansSignature, opts.scannerId, now),
  };
}

/**
 * Verify a sandbox declaration: true only when every field equals the
 * standard declaration. Anything else means the scan ran somewhere the
 * contract does not recognize.
 */
export function verifySandbox(d) {
  return (
    d.network === STANDARD_SANDBOX.network &&
    d.filesystem === STANDARD_SANDBOX.filesystem &&
    d.subprocess === STANDARD_SANDBOX.subprocess
  );
}

/**
 * Sign a report: digest = sha256Hex(canonicalJson(reportSansSignature)).
 * Deterministic — the same report + scanner + clock yields the identical
 * signature. The signature covers the report body only, never itself.
 */
export function signScanReport(reportSansSignature, scannerId, now) {
  return {
    algorithm: 'sha256-canonical-json',
    digest: sha256Hex(canonicalJson(reportSansSignature)),
    signedBy: scannerId,
    signedAt: now.toISOString(),
  };
}
