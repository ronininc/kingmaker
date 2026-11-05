// Evaluation core — what a "configuration" is in the post-release line, and
// how one artifact is evaluated under one configuration.
//
// A configuration = { pack (B4 rule pack for the scan stage),
//   genRules (generated REA rule records, SPEC §4 shape),
//   policy (owner policy + generated deltas merged — SPEC §4 rule),
//   scanRoots (device roots + generated additions) }.
//
// The review path mirrors the product's fixed stage order [INV §7a]:
// classify → source-scan (pack scanner) → rea (shipped rules via the product
// rea.mjs + generated rules via the evaluator below) → verdict composition.
// The OS sandbox wrapper (Seatbelt) is darwin-only in the shipped product
// [sandbox-review.mjs refuses off-darwin]; in this VM the analysis stages
// run directly — the same code the shipped review worker runs.
import fs from 'node:fs';
import path from 'node:path';
import { scanText, verdictFor, RULES as SHIPPED_REA } from './shield-rea.mjs';
import { scanWithPack, BASELINE_PACK } from './shield-rulepack.mjs';

export { SHIPPED_REA };

const rx = (s) => (s instanceof RegExp ? s : new RegExp(s.source ?? s, s.flags ?? ''));

// Generated REA rule evaluator — applies SPEC §4 rule records (patterns,
// requires, access, quiet as data) line-wise, following the shipped ruleOn
// semantics: a pattern hit is a finding when access anchors it (or no
// access is declared), quiet patterns suppress, requires unmet → note.
export function evalGeneratedRules(text, file, genRules) {
  const findings = [], notes = new Set();
  if (!genRules?.length) return { findings, notes: [] };
  const lines = String(text).split(/\r?\n/);
  lines.forEach((line, i) => {
    const code = line.replace(/\s(\/\/|#)\s.*$/, '');
    for (const r of genRules) {
      if (!r.patterns.some((p) => rx(p).test(line))) continue;
      if (r.quiet?.some((q) => rx(q).test(code))) continue;
      if (r.access && !rx(r.access).test(code)) continue;
      if (r.requires && !r.requires.some((q) => rx(q).test(code))) { notes.add(`mentions_${r.kind}`); continue; }
      findings.push({
        id: `${r.id}:${file}:${i + 1}`, rule: r.id, kind: r.kind, why: r.why ?? r.detail ?? '',
        fix: r.fix ?? null, severity: r.severity, file, line: i + 1,
        code: line.trim().slice(0, 200), generated: true,
      });
    }
  });
  return { findings, notes: [...notes] };
}

// Compose the stop outcome from stage results. "Stopped" = the artifact
// does not proceed as itself: canonical verdict critical, REA verdict
// rejected, or a generated rule at severity 'reject' fired. Sandboxed =
// proceeds only under a profile (REA sandboxed or a generated 'sandbox'
// rule fired).
export function composeOutcome(scan, reaFindings, genFindings) {
  const genReject = genFindings.some((f) => f.severity === 'reject');
  const genSandbox = genFindings.some((f) => f.severity === 'sandbox');
  const reaVerdict = verdictFor([...reaFindings, ...genFindings.map((f) => ({ ...f, soft: false }))]);
  const stopped = scan.verdict === 'critical' || reaVerdict === 'rejected' || genReject;
  const sandboxed = !stopped && (reaVerdict === 'sandboxed' || genSandbox);
  return {
    verdict: scan.verdict, score: scan.risk.score, tier: scan.risk.tier,
    reaVerdict, stopped, sandboxed,
    stopStage: stopped ? (scan.verdict === 'critical' ? 'source-scan' : 'rea') : null,
  };
}

// Evaluate one source text under one configuration.
export function evaluateText(text, name, targetSha, config) {
  const pack = config.pack ?? BASELINE_PACK;
  const scan = scanWithPack(text, name, targetSha, pack);
  const shipped = scanText(text, name);
  const gen = evalGeneratedRules(text, name, config.genRules ?? []);
  const outcome = composeOutcome(scan, shipped.findings, gen.findings);
  return { scan, reaFindings: shipped.findings, genFindings: gen.findings, outcome };
}

// --- Configuration stores (SPEC §4: generated deltas live in a separate
// generated-policy store, merged after owner policy, never editing it) ---
export function generatedStoreDir(stateDir) { return path.join(stateDir, 'generated'); }

export function loadGenerated(stateDir) {
  const dir = generatedStoreDir(stateDir);
  const read = (f, dflt) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return dflt; } };
  return {
    genRules: read('rea-rules.json', []),
    policyDeltas: read('policy-deltas.json', []),
    scanRoots: read('scan-roots.json', []),
    profiles: read('profiles.json', []),
  };
}
export function saveGenerated(stateDir, gen) {
  const dir = generatedStoreDir(stateDir);
  fs.mkdirSync(dir, { recursive: true });
  const write = (f, v) => fs.writeFileSync(path.join(dir, f), JSON.stringify(v, null, 2));
  write('rea-rules.json', gen.genRules); write('policy-deltas.json', gen.policyDeltas);
  write('scan-roots.json', gen.scanRoots); write('profiles.json', gen.profiles);
}

// Merge generated policy deltas over an owner policy object (deep, by path).
// Monotonicity is the gate's job (§5 step 5), not the merge's — the merge
// just applies what the store holds.
export function mergePolicy(ownerPolicy, deltas) {
  const out = JSON.parse(JSON.stringify(ownerPolicy));
  for (const d of deltas) {
    const parts = d.path.split('.');
    let node = out;
    for (const p of parts.slice(0, -1)) node = node[p] ??= {};
    node[parts.at(-1)] = d.to;
  }
  return out;
}

export function configFromGenerated(gen, ownerPolicy, pack) {
  return {
    pack: pack ?? BASELINE_PACK,
    genRules: gen.genRules.filter((r) => r.active !== false),
    policy: mergePolicy(ownerPolicy, gen.policyDeltas),
    policyDeltas: gen.policyDeltas,
    scanRoots: gen.scanRoots,
    profiles: gen.profiles,
  };
}
