// B6 — The loop (SPEC §5): detection → diagnosis → generation → gate →
// deployment → feedback. One cycle = one detected problem, carried through
// all seven steps or discarded. Generation is automatic; going live is
// gated — a generated shield is an artifact, and Armor verifies artifacts.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_POLICY } from './scan.mjs';
import { emitGateReceipt, emitCycle } from './shield-ledger.mjs';
import { loadGenerated, saveGenerated } from './shield-eval.mjs';
import { registerLayer, rollbackLayer, spotKey } from './shield-registry.mjs';
import { runGate, applyCandidate } from './shield-gate.mjs';
import { promotionCandidate, profileCandidate, thresholdCandidate, rootCandidate,
         instancesFromLedger, clusterInstances } from './shield-generator.mjs';

export const ATTEMPTS_THRESHOLD = 5;      // folded attempts count that signals
export const RECURRENCE_TARGETS = 3;      // distinct targets that signal

export const newCycleId = () => crypto.randomUUID();

// --- Step 1 — Detection ---------------------------------------------------
// Signals come from the §3 streams only. Battery self-tests are fixtures,
// never attacks (§5 step 1); provenance rule: ledger testimony counts
// only when the ledger chain verifies (B3 marks it otherwise).
export function detectSignals({ index, attemptsEntries = [], ledgerEntries = [], priorCycles = [] }) {
  const signals = [];
  // Attempts aggregates crossing the recurrence threshold.
  for (const e of attemptsEntries) {
    if (e.count >= ATTEMPTS_THRESHOLD) {
      signals.push({ type: 'attempts-recurrence', class: e.class, reason_class: e.reason_class,
        count: e.count, canary: e.canaryId, source: e.source,
        spot: { lane: 'activation', stage: 'verdict', surface: 'attempts-thresholds' } });
    }
  }
  // Foreign beacon events (fixtures excluded by the aggregator).
  for (const ev of index.beacon.foreign) {
    signals.push({ type: 'beacon', class: ev.reason_class, reason_class: ev.reason_class, canary: ev.canary,
      spot: { lane: 'activation', stage: 'verdict', surface: 'attempts-thresholds' } });
  }
  // Recurrence clusters in retained upload-lane testimony: same rule,
  // same normalized excerpt shape, >= N distinct targets, and the files
  // were NOT stopped (what got through is what the loop exists for).
  const byRule = new Map();
  for (const e of ledgerEntries) {
    const rec = e.record;
    if (!rec || rec.schema !== 'scripture-armor.file-review/1' || rec.stopped) continue;
    for (const f of rec.findings || []) {
      if (!f.excerpt || f.severity === 'info') continue;
      if (!byRule.has(f.rule)) byRule.set(f.rule, []);
      byRule.get(f.rule).push({ rule: f.rule, excerpt: f.excerpt, target: rec.contentSha256, seq: e.seq });
    }
  }
  const deployedRules = new Set(priorCycles.filter((c) => c.deployed).flatMap((c) => c.generated_rule_ids || []));
  for (const [rule, instances] of byRule) {
    for (const cl of clusterInstances(instances)) {
      if (cl.targets < RECURRENCE_TARGETS) continue;
      const afterDeploy = deployedRules.has(rule) || priorCycles.some((c) => c.source_rule === rule && c.deployed);
      signals.push({
        type: afterDeploy ? 'recurrence-after-deployment' : 'recurrence',
        class: rule, rule, cluster: cl.key, targets: cl.targets, instances: cl.items,
        spot: { lane: 'upload', stage: 'rea', surface: 'rea-rules' },
      });
    }
  }
  return signals;
}

// Silence witnessing (§5 step 1): a stream that should carry testimony
// but is empty while its sibling streams are live is itself a signal —
// detection of silence is gap-detection over the B1/B2 streams.
export function detectSilence({ ledgerCount, attemptsCount }) {
  if (attemptsCount > 0 && ledgerCount === 0) {
    return { type: 'silence', class: 'testimony-gap',
      detail: 'attempts feed carries refusals but the retention ledger is empty — collection is down' };
  }
  return null;
}

// --- Step 2 — Diagnosis ---------------------------------------------------
// Attack class is named in vocabularies that already exist; the spot is
// the B5 coordinate. Signal-to-spot mapping is deterministic per type.
export function diagnose(signal) {
  switch (signal.type) {
    case 'recurrence':
      return { attack_class: signal.rule, spot: signal.spot,
        response: 'promote-recurring-signature', first_cycle_severity: 'sandbox' };
    case 'recurrence-after-deployment':
      return { attack_class: signal.rule, spot: signal.spot,
        response: 'promote-recurring-signature', first_cycle_severity: 'reject',
        note: 'second gated cycle: promotion to reject (SPEC §5 step 3 rule)' };
    case 'attempts-recurrence':
      return { attack_class: `${signal.class}/${signal.reason_class}`, spot: signal.spot,
        response: 'threshold-tighten' };
    case 'beacon':
      return { attack_class: signal.reason_class, spot: signal.spot, response: 'threshold-tighten' };
    case 'device-surface':
      return { attack_class: 'unscanned-surface', spot: signal.spot, response: 'extend-scan-root' };
    case 'findings-set':
      return { attack_class: signal.class, spot: signal.spot, response: 'synthesize-profile' };
    default:
      return { attack_class: signal.class || 'unknown', spot: signal.spot, response: 'none' };
  }
}

// --- Steps 3–7 — one full cycle ------------------------------------------
// ctx: { identityDir, stateDir, index, attempts, cache, pack,
//        benignExcerptsFor(rule) -> [] , policy }
export async function runCycle(ctx, signal) {
  const cycle_id = newCycleId();
  const diagnosis = diagnose(signal);
  const gen = loadGenerated(ctx.stateDir);
  const ownerPolicy = ctx.policy ?? DEFAULT_POLICY;
  let candidate = null;

  if (diagnosis.response === 'promote-recurring-signature') {
    candidate = promotionCandidate({
      cycle_id, rule: signal.rule, instances: signal.instances,
      benignExcerpts: ctx.benignExcerptsFor ? ctx.benignExcerptsFor(signal.rule, signal.cluster) : [],
      severity: diagnosis.first_cycle_severity, spot: diagnosis.spot,
      diagnosis: { signal: signal.type, ...diagnosis },
    });
  } else if (diagnosis.response === 'threshold-tighten') {
    candidate = thresholdCandidate({
      cycle_id, spot: diagnosis.spot, policy: ownerPolicy,
      path: 'airlock.max_violations',
      diagnosis: { signal: signal.type, ...diagnosis },
      provenance: { attempts_class: signal.class, reason_class: signal.reason_class, count: signal.count },
    });
  } else if (diagnosis.response === 'extend-scan-root') {
    candidate = rootCandidate({ cycle_id, spot: diagnosis.spot, root: signal.root,
      diagnosis: { signal: signal.type, ...diagnosis }, provenance: signal.provenance });
  } else if (diagnosis.response === 'synthesize-profile') {
    candidate = profileCandidate({ cycle_id, reaFindings: signal.reaFindings, spot: diagnosis.spot,
      diagnosis: { signal: signal.type, ...diagnosis }, provenance: signal.provenance });
    for (const l of candidate.layers) l.spot_key = spotKey(diagnosis.spot);
  }

  const cycle = { cycle_id, at: new Date().toISOString(), signal_type: signal.type,
    source_rule: signal.rule ?? null, diagnosis, deployed: false, generated_rule_ids: [] };

  if (!candidate) {
    cycle.outcome = 'no-candidate';
    cycle.detail = 'generation produced no candidate (extraction found no productive, precise invariant core)';
    emitCycle(ctx.identityDir, cycle);
    return cycle;
  }
  candidate.diagnosis = { signal: signal.type, ...diagnosis };

  // Step 5 — the gate. Receipt is ledger testimony either way.
  const receipt = await runGate({ candidate, activeGen: gen, ownerPolicy, index: ctx.index, cache: ctx.cache, pack: ctx.pack });
  const receiptEntry = emitGateReceipt(ctx.identityDir, receipt, cycle_id);
  cycle.gate = { verdict: receipt.verdict, receipt_seq: receiptEntry.seq, checks: receipt.checks };

  if (receipt.verdict !== 'pass') {
    cycle.outcome = 'gate-failed-discarded';
    emitCycle(ctx.identityDir, cycle);
    return cycle;
  }

  // Step 6 — deployment at the attacked spot: data writes only, plus the
  // manifest registration carrying the prior-state snapshot for rollback.
  const priorState = JSON.parse(JSON.stringify(gen));
  const next = applyCandidate(gen, candidate);
  saveGenerated(ctx.stateDir, next);
  for (const layer of candidate.layers) {
    const spot = layer.spot || diagnosis.spot;
    registerLayer(ctx.stateDir, spot, {
      layer_id: layer.rule?.id || `${layer.shape}:${cycle_id.slice(0, 8)}`,
      shape: layer.shape, cycle_id, rules_version: ctx.pack?.rules_version ?? 'scan-rules/1',
      gate_receipt_seq: receiptEntry.seq, prior_state: priorState,
    });
    if (layer.rule) cycle.generated_rule_ids.push(layer.rule.id);
  }
  cycle.deployed = true;
  cycle.outcome = 'deployed';

  // Step 7 — feedback: the full cycle record joins the corpus.
  emitCycle(ctx.identityDir, cycle);
  return cycle;
}

// Rollback a deployed layer: restore the manifest's verified prior state
// into the generated stores. Refuses tampered snapshots (gate.mjs's
// registry check); the rollback itself is recorded in the ledger.
export function rollback(ctx, spot, layer_id) {
  const res = rollbackLayer(ctx.stateDir, spot, layer_id);
  if (!res.ok) return res;
  saveGenerated(ctx.stateDir, {
    genRules: res.prior_state.genRules || [], policyDeltas: res.prior_state.policyDeltas || [],
    scanRoots: res.prior_state.scanRoots || [], profiles: res.prior_state.profiles || [],
  });
  emitCycle(ctx.identityDir, { cycle_id: newCycleId(), at: new Date().toISOString(),
    signal_type: 'rollback', outcome: 'rolled-back', layer_id, spot: spotKey(spot), deployed: false, generated_rule_ids: [] });
  return { ok: true };
}
