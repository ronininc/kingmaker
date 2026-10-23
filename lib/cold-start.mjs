// lib/cold-start.mjs — the launch→ready phase model: what "instantaneous" is made of, phase by phase.
//
// Kingmaker's cold start is not one number. It is a chain of phases, each with its own owner and its
// own fix: the interpreter loading the module graph, the launcher's preflight, the engine child's boot
// to its "listening" line, the post-ready staging (hands, rules, session), and then the two first-use
// costs — the first reflex decision and the first generated token — which are MODEL loads unless the
// seats were pre-warmed (lib/model-warm.mjs). This module is the shared vocabulary for that chain:
// the canonical phases, the budget each is held to, a timer the launcher records with, and the table
// the bench (scripts/coldstart-bench.mjs) and COLDSTART.md report in.
//
// Every recorded number carries its kind: REAL (measured here, on this machine, by this code) or
// SIMULATED (a fixture, a mock, or a published figure standing in for hardware this machine is not).
// A simulated number is never allowed to wear a real one's clothes: the table prints the kind beside
// every row, and `allRealWithinBudget` is the only verdict that means "proven".

/** The canonical phases, in launch order. Budgets are for the 8 GB M3 acceptance class: the slowest
 *  Mac Kingmaker ships for is the one the budget is written against. */
export const COLD_START_PHASES = Object.freeze([
  Object.freeze({
    id: 'process',
    label: 'Process start',
    detail: 'Interpreter boot + the entry\'s module graph (lib/kingmaker.mjs → lib/cli.mjs and everything it imports).',
    budgetMs: 500,
  }),
  Object.freeze({
    id: 'preflight',
    label: 'Preflight',
    detail: 'Payload check, path resolution, start blockers (port probe, other-engine check) and the Ollama probe.',
    budgetMs: 1_000,
  }),
  Object.freeze({
    id: 'engine',
    label: 'Engine spawn → listening',
    detail: 'startBackend spawns the engine child and waits for its "Solomon runtime listening on" line (lib/runtime.mjs).',
    budgetMs: 3_000,
  }),
  Object.freeze({
    id: 'post-ready',
    label: 'Post-ready staging',
    detail: 'After the engine answers: hands warmed, the rules (control status) verified fail-closed, the owner session opened. Nothing here may wait on a model load.',
    budgetMs: 2_000,
  }),
  Object.freeze({
    id: 'first-decision',
    label: 'First reflex decision',
    detail: 'One DecisionRouter.decide() round trip (lib/decision-router.mjs). Warm = the reflex seat (the router\'s own pick — tev1, 812 MB, at this registry revision) already loaded by the pre-warm; cold = Ollama loads its weights inside this call.',
    budgetMs: 150,
  }),
  Object.freeze({
    id: 'first-token',
    label: 'First token',
    detail: 'Time from the first governed turn to the first streamed token of its answer. Warm = the brain seat already resident in Ollama (keep_alive held by the pre-warm); cold = the seat\'s weights page in inside this turn.',
    budgetMs: 1_000,
  }),
]);

export const PHASE_BY_ID = Object.freeze(Object.fromEntries(COLD_START_PHASES.map((p) => [p.id, p])));

export const MEASURE_KINDS = Object.freeze(['REAL', 'SIMULATED']);

/**
 * A phase timer. mark(id) closes the phase that was running and opens the next; set(id, ms) records a
 * phase measured elsewhere (a child process, a sub-timer). `kind` is per phase: one launch can be REAL
 * in the phases this machine can truly run and SIMULATED in the ones it cannot (no Ollama, no weights),
 * and the rows keep them separate.
 */
export function createPhaseTimer({ now = () => performance.now() } = {}) {
  const startedAt = now();
  let last = startedAt;
  const recorded = new Map();
  const record = (id, ms, kind, note) => {
    if (!PHASE_BY_ID[id]) throw new Error(`cold-start: unknown phase "${id}"`);
    if (!MEASURE_KINDS.includes(kind)) throw new Error(`cold-start: kind must be one of ${MEASURE_KINDS.join(', ')}`);
    recorded.set(id, { ms: Math.max(0, ms), kind, note: note ?? null });
  };
  return {
    /** Close the current phase under `id` and start timing the next one. */
    mark(id, { kind = 'REAL', note = null } = {}) {
      const t = now();
      record(id, t - last, kind, note);
      last = t;
    },
    /** Record a phase measured outside this timer (its own clock, its own kind). */
    set(id, ms, { kind = 'REAL', note = null } = {}) {
      record(id, ms, kind, note);
    },
    /** The full table: every canonical phase, in order, measured or explicitly unmeasured. */
    rows() {
      return COLD_START_PHASES.map((p) => {
        const r = recorded.get(p.id);
        return {
          id: p.id, label: p.label, detail: p.detail, budgetMs: p.budgetMs,
          ms: r ? Math.round(r.ms * 10) / 10 : null,
          kind: r ? r.kind : null,
          note: r ? r.note : null,
          withinBudget: r ? r.ms <= p.budgetMs : null,
        };
      });
    },
    /** Elapsed since the timer started (the whole launch, as this process lived it). */
    totalMs() { return now() - startedAt; },
  };
}

/** Pure: the one honest summary of a table. Simulated rows never count toward "proven". */
export function phaseVerdict(rows) {
  const measured = rows.filter((r) => r.ms != null);
  const real = measured.filter((r) => r.kind === 'REAL');
  const simulated = measured.filter((r) => r.kind === 'SIMULATED');
  const realOver = real.filter((r) => r.withinBudget === false);
  return {
    measuredCount: measured.length,
    realCount: real.length,
    simulatedCount: simulated.length,
    unmeasured: rows.filter((r) => r.ms == null).map((r) => r.id),
    realOverBudget: realOver.map((r) => r.id),
    /** True only when every phase was measured REAL and inside its budget. Anything less is a claim
     *  about fixtures, and says so. */
    allRealWithinBudget: rows.length > 0 && real.length === rows.length && realOver.length === 0,
    totalMeasuredMs: Math.round(measured.reduce((sum, r) => sum + r.ms, 0) * 10) / 10,
  };
}

/** Pure: the table as markdown — the shape the bench prints and COLDSTART.md carries. */
export function formatPhaseTable(rows) {
  const cell = (r) => (r.ms == null ? '— unmeasured —' : `${r.ms} ms (${r.kind})`);
  const verdict = (r) => (r.ms == null ? '' : r.withinBudget ? '✓ within' : '✗ OVER');
  const lines = [
    '| Phase | Measured | Budget | |',
    '|---|---|---|---|',
    ...rows.map((r) => `| ${r.label} | ${cell(r)} | ${r.budgetMs} ms | ${verdict(r)} |`),
  ];
  return lines.join('\n');
}
