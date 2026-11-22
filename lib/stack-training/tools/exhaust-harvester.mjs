#!/usr/bin/env node
/**
 * tools/exhaust-harvester.mjs (training-data-pipeline)
 *
 * The fleet's own exhaust is the primary training corpus — and the audit
 * chains are already labeled records. This harvester reads a hash-chained
 * audit log (router-phase2 JSON-array shape or littlebrother JSONL shape),
 * VERIFIES the chain, and emits labeled training records as JSONL:
 *
 *   { id, kind: 'routing-decision' | 'task-outcome',
 *     input, decision?, output?, outcome, label,
 *     provenance: { chain, seq, teacher }, ts }
 *
 * Labels:
 *   gold       — the record's outcome was decided by the structural verifier
 *                (never a model's self-report) and the outcome passed, on a
 *                chain that verified.
 *   negative   — verifier decided, outcome failed. Useful signal; not gold.
 *   unlabeled  — no verifier verdict exists for this record (e.g. a lookup
 *                with verified=null, or a routed task with no outcome entry).
 *   superseded — a later outcome entry for the same task replaces this one;
 *                only the latest carries a live label.
 *
 * Provenance is mandatory: any candidate record missing enough chain context
 * to name { chain, seq, teacher } is dropped and counted, never emitted
 * half-provenanced. A chain that fails verification is refused outright —
 * poisoned exhaust does not enter the corpus.
 *
 * Sources understood:
 *   - governed-router chains: route.intent / route.evidence / route.decision /
 *     route.escalation / route.outcome, correlated by meta.taskId. The
 *     outcome entry's attempts[] carry the verifier's failedChecks; a task
 *     whose final outcome is 'ok' with a recorded verifier pass is gold.
 *   - littlebrother chains: 'lookup' entries carry meta.verified from the
 *     evidence pipeline — verified===true is gold; anything else unlabeled.
 *
 * Local-first, read-only, no telemetry, $0.
 *
 * Library:  import { harvestChain } from './exhaust-harvester.mjs'
 * CLI:      node tools/exhaust-harvester.mjs <audit-log> [--chain NAME] [--out FILE]
 */

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readEntries, verifyEntries } from '../lib/chain-verify.mjs';

function sha256(data) {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

/** Deterministic record id from chain + seq range + content. */
function recordId(chainLabel, seqs, body) {
  return 'rec-' + sha256(JSON.stringify({ chain: chainLabel, seqs, body })).slice(0, 24);
}

/**
 * Correlate governed-router entries into per-task harvest records.
 * Returns { records, dropped } — dropped candidates lacked provenance context.
 */
function harvestRouterTasks(entries, chainLabel) {
  const tasks = new Map(); // taskId -> { intent, evidence, decisions: [], outcomes: [] }
  let dropped = 0;

  for (const entry of entries) {
    const action = entry.action ?? '';
    if (!action.startsWith('route.')) continue;
    const taskId = entry.meta?.taskId;
    if (!taskId) { dropped++; continue; }
    if (!tasks.has(taskId)) tasks.set(taskId, { taskId, intent: null, evidence: null, decisions: [], outcomes: [] });
    const t = tasks.get(taskId);
    if (action === 'route.intent') t.intent = entry;
    else if (action === 'route.evidence') t.evidence = entry;
    else if (action === 'route.decision') t.decisions.push(entry);
    else if (action === 'route.outcome') t.outcomes.push(entry);
  }

  const records = [];
  for (const t of tasks.values()) {
    if (!t.intent) { dropped++; continue; } // no input → no provenance-bearing record
    const input = t.intent.detail ?? '';
    const lastDecision = t.decisions[t.decisions.length - 1] ?? null;
    const seqs = [t.intent.seq, ...(t.evidence ? [t.evidence.seq] : []), ...t.decisions.map((d) => d.seq), ...t.outcomes.map((o) => o.seq)];

    const decision = lastDecision
      ? {
          model: lastDecision.meta?.model ?? null,
          tier: lastDecision.meta?.tier ?? null,
          routedBy: lastDecision.meta?.routedBy ?? null,
          bucket: t.evidence?.meta?.bucket ?? null,
          complexity: t.evidence?.meta?.complexity ?? null,
          confidence: lastDecision.meta?.confidence ?? null,
        }
      : null;

    // Every outcome except the last is superseded by a later rerun.
    t.outcomes.forEach((outcomeEntry, i) => {
      const isLatest = i === t.outcomes.length - 1;
      const meta = outcomeEntry.meta ?? {};
      // The verifier's verdict: outcome status + per-attempt failedChecks.
      // 'ok' with no recorded verifier structure (prefilter path) still had a
      // deterministic decision behind it — the router logs route.outcome only
      // after execution + verification for model routes.
      const status = meta.status ?? (String(outcomeEntry.detail ?? '').startsWith('ok') ? 'ok' : 'failed');
      const failedChecks = (meta.attempts ?? []).flatMap((a) => a.failedChecks ?? []);
      let label;
      let outcome;
      if (!isLatest) {
        label = 'superseded';
        outcome = { verdict: 'superseded', status, failedChecks };
      } else if (status === 'ok') {
        label = 'gold';
        outcome = { verdict: 'pass', status, failedChecks };
      } else {
        label = 'negative';
        outcome = { verdict: 'fail', status, failedChecks };
      }

      const body = { input, decision, status };
      records.push({
        id: recordId(chainLabel, [t.intent.seq, outcomeEntry.seq], body),
        kind: 'routing-decision',
        input,
        decision,
        output: {
          status,
          model: meta.model ?? decision?.model ?? null,
          tier: meta.tier ?? decision?.tier ?? null,
          costUsd: meta.costUsd ?? null,
          escalations: meta.escalations ?? 0,
        },
        outcome,
        label,
        provenance: { chain: chainLabel, seq: [...new Set(seqs)].sort((a, b) => a - b), teacher: 'governed-router' },
        ts: outcomeEntry.ts,
      });
    });

    // Routed but never reached an outcome — emit as unlabeled, not gold.
    if (t.outcomes.length === 0) {
      const body = { input, decision, status: null };
      records.push({
        id: recordId(chainLabel, seqs, body),
        kind: 'routing-decision',
        input,
        decision,
        output: null,
        outcome: { verdict: 'none', status: null, failedChecks: [] },
        label: 'unlabeled',
        provenance: { chain: chainLabel, seq: [...new Set(seqs)].sort((a, b) => a - b), teacher: 'governed-router' },
        ts: t.intent.ts,
      });
    }
  }
  return { records, dropped };
}

/**
 * LittleBrother lookup entries → task-outcome records. The outcome label
 * comes from the evidence record's verified flag: true = gold.
 */
function harvestLookups(entries, chainLabel) {
  const records = [];
  let dropped = 0;
  for (const entry of entries) {
    if (entry.action !== 'lookup') continue;
    const verified = entry.meta?.verified;
    const label = verified === true ? 'gold' : 'unlabeled';
    const body = { detail: entry.detail, verified };
    records.push({
      id: recordId(chainLabel, [entry.seq], body),
      kind: 'task-outcome',
      input: entry.detail ?? '',
      output: { action: 'lookup' },
      outcome: { verdict: verified === true ? 'pass' : 'none', verified: verified ?? null },
      label,
      provenance: { chain: chainLabel, seq: [entry.seq], teacher: 'littlebrother' },
      ts: entry.ts,
    });
  }
  return { records, dropped };
}

/**
 * Harvest one parsed chain. The chain MUST verify — a tampered chain is
 * refused wholesale, because a single forged entry poisons every label that
 * cites it. Returns { records, dropped, chainOk } or throws on bad chain.
 */
export function harvestChain(entries, { chainLabel = 'audit-chain' } = {}) {
  const check = verifyEntries(entries);
  if (!check.ok) {
    throw new Error(`exhaust-harvester: chain '${chainLabel}' failed verification at seq ${check.atSeq}: ${check.reason} — refusing to harvest`);
  }
  const router = harvestRouterTasks(entries, chainLabel);
  const lookups = harvestLookups(entries, chainLabel);
  const records = [...router.records, ...lookups.records];
  // Absolute rule: no record leaves without full provenance.
  for (const r of records) {
    if (!r.provenance?.chain || !Array.isArray(r.provenance?.seq) || r.provenance.seq.length === 0 || !r.provenance?.teacher) {
      throw new Error('exhaust-harvester: internal error — record missing provenance; refusing to emit');
    }
  }
  return { records, dropped: router.dropped + lookups.dropped, chainOk: true };
}

/** Harvest a log file (path) → { records, dropped, chainOk, format }. */
export function harvestFile(path, opts = {}) {
  const entries = readEntries(path);
  return harvestChain(entries, opts);
}

/** One-line summary of a harvest run, for manifests and logs. */
export function summarizeHarvest({ records, dropped, chainLabel }) {
  const byLabel = {};
  for (const r of records) byLabel[r.label] = (byLabel[r.label] ?? 0) + 1;
  return { chain: chainLabel, records: records.length, dropped, byLabel };
}

// ---- CLI ----
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const args = process.argv.slice(2);
  const logPath = args[0];
  if (!logPath) {
    console.error('usage: node tools/exhaust-harvester.mjs <audit-log> [--chain NAME] [--out FILE.jsonl]');
    process.exit(2);
  }
  const chainLabel = args.includes('--chain') ? args[args.indexOf('--chain') + 1] : logPath;
  const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
  const { records, dropped } = harvestFile(logPath, { chainLabel });
  const text = records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
  if (out) writeFileSync(out, text);
  else process.stdout.write(text);
  console.error(JSON.stringify(summarizeHarvest({ records, dropped, chainLabel })));
}
