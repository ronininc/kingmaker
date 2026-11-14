// proof/report-schema.mjs — the 10M token proof report: the one shape the runner produces, the
// markdown renderer prints, and the light-runtime UI consumes (evidence cards + ticker tiles).
//
// The mapping is 1:1 by construction, not by convention:
//   report.cards[i]  = one evidence card  ← built from report.stages[i], same order, same numbers
//   report.tiles     = the four ticker tiles, fixed labels, built from report.totals + verdict
// A UI that renders cards/tiles verbatim can never show a number the runner didn't measure.
//
// Honesty labels are part of the schema: every stage carries `measured: 'real' | 'simulated'`
// (real = counted from a live endpoint's own report; simulated = a fake transport on the VM),
// and the report-level `mode` is 'real' only when EVERY stage is real. The verdict may claim
// the 200 tok/s target PROVEN only in real mode (see run-proof.mjs verdictFor).

export const PROOF_REPORT_KIND = 'kingmaker-10m-proof-report';
export const PROOF_REPORT_VERSION = 1;

/** Robbie's target (2026-10-21): sustained aggregate throughput for the proof run. */
export const TARGET_TOK_S = 200;
/** The proof's headline workload size. */
export const DEFAULT_TOTAL_TOKENS = 10_000_000;

/** The proof's lanes. Reads are prefill (cheap, parallel), writes are decode (dear, sequential),
 *  reflex is the decision layer (one forward pass, no generation). */
export const PROOF_LANES = Object.freeze(['read', 'reflex', 'write']);

/** The four ticker tiles, in display order. Fixed by the schema; the UI does not invent tiles. */
export const TILE_LABELS = Object.freeze(['TOTAL TOKENS', 'SUSTAINED T/S', 'PEAK T/S', 'WRITE SHARE %']);

const round1 = (n) => Math.round(n * 10) / 10;

/** Pure: one evidence card from one stage row. The fields the UI's card shows, nothing else:
 *  the stage id as the header, the token + rate line as the body, `source` as the source line. */
export function cardForStage(stage) {
  return {
    stage: stage.id,
    lane: stage.lane,
    tokens: stage.tokens,
    tokS: stage.tokS,
    measured: stage.measured,
    source: stage.source,
  };
}

/** Pure: the four ticker tiles from the totals + verdict. Values are display-ready strings,
 *  so the UI never formats (or mis-formats) a number itself. */
export function tilesForTotals(totals, verdict) {
  const byLabel = {
    'TOTAL TOKENS': totals.tokens.toLocaleString('en-US'),
    'SUSTAINED T/S': totals.sustainedTokS === null ? '—' : String(round1(totals.sustainedTokS)),
    'PEAK T/S': totals.peakTokS === null ? '—' : String(round1(totals.peakTokS)),
    'WRITE SHARE %': totals.writeSharePct === null ? '—' : `${round1(totals.writeSharePct)}%`,
  };
  return TILE_LABELS.map((label) => ({ label, value: byLabel[label], verdict: label === 'SUSTAINED T/S' ? verdict.status : null }));
}

/** Pure: assemble the final report from the run's parts. Cards and tiles are DERIVED here,
 *  once, so every consumer (JSON, markdown, UI) reads the same derived rows. */
export function assembleReport({ target, mode, startedAt, finishedAt, wallMs, stages, outcomes, verdict, macRun, aborted = false }) {
  const totals = totalsForStages(stages, wallMs);
  const report = {
    kind: PROOF_REPORT_KIND,
    version: PROOF_REPORT_VERSION,
    target,
    mode,
    aborted,
    startedAt,
    finishedAt,
    wallMs,
    totals,
    lanes: lanesForStages(stages),
    stages,
    outcomes,
    verdict,
    macRun,
  };
  report.cards = stages.map(cardForStage);
  report.tiles = tilesForTotals(totals, verdict);
  return report;
}

/** Pure: the run totals from the stage rows. Sustained = every token over the whole wall clock
 *  (the aggregate claim); peak = the fastest single stage (a stage is one batch of concurrent
 *  calls, so its rate is an aggregate rate too — never a single stream's decode rate). */
export function totalsForStages(stages, wallMs) {
  const tokens = stages.reduce((s, x) => s + x.tokens, 0);
  const promptTokens = stages.reduce((s, x) => s + x.promptTokens, 0);
  const generatedTokens = stages.reduce((s, x) => s + x.generatedTokens, 0);
  const peakTokS = stages.length ? Math.max(...stages.map((x) => x.tokS ?? 0)) : null;
  return {
    tokens,
    promptTokens,
    generatedTokens,
    sustainedTokS: wallMs > 0 ? (tokens * 1000) / wallMs : null,
    peakTokS: stages.length ? peakTokS : null,
    writeSharePct: tokens > 0 ? (stages.filter((x) => x.lane === 'write').reduce((s, x) => s + x.tokens, 0) * 100) / tokens : null,
    generatedSharePct: tokens > 0 ? (generatedTokens * 100) / tokens : null,
  };
}

/** Pure: per-lane rollups, keyed by PROOF_LANES (a lane with no stages reports zeros). */
export function lanesForStages(stages) {
  const out = {};
  for (const lane of PROOF_LANES) {
    const rows = stages.filter((x) => x.lane === lane);
    const tokens = rows.reduce((s, x) => s + x.tokens, 0);
    const wall = rows.reduce((s, x) => s + x.wallMs, 0);
    out[lane] = {
      tokens,
      promptTokens: rows.reduce((s, x) => s + x.promptTokens, 0),
      generatedTokens: rows.reduce((s, x) => s + x.generatedTokens, 0),
      stages: rows.length,
      wallMs: wall,
      tokS: wall > 0 ? (tokens * 1000) / wall : null,
    };
  }
  return out;
}

/** Structural check used by tests and by any consumer that loads a report from disk.
 *  Returns a list of problems ([] = the report is schema-true, cards/tiles included). */
export function validateReport(report) {
  const problems = [];
  const need = (cond, msg) => { if (!cond) problems.push(msg); };
  need(report && typeof report === 'object', 'report is not an object');
  if (!report || typeof report !== 'object') return problems;
  need(report.kind === PROOF_REPORT_KIND, `kind is not ${PROOF_REPORT_KIND}`);
  need(report.version === PROOF_REPORT_VERSION, 'version mismatch');
  need(report.target && Number.isFinite(report.target.totalTokens) && Number.isFinite(report.target.sustainedTokS), 'target missing totalTokens/sustainedTokS');
  need(['real', 'simulated', 'mixed'].includes(report.mode), 'mode is not real|simulated|mixed');
  need(Array.isArray(report.stages), 'stages is not an array');
  if (Array.isArray(report.stages)) {
    for (const [i, s] of report.stages.entries()) {
      for (const f of ['id', 'lane', 'model', 'tokens', 'promptTokens', 'generatedTokens', 'wallMs', 'tokS', 'measured', 'countSource', 'source']) {
        need(s[f] !== undefined && s[f] !== null, `stages[${i}].${f} missing`);
      }
      need(PROOF_LANES.includes(s.lane), `stages[${i}].lane not a proof lane`);
      need(['real', 'simulated'].includes(s.measured), `stages[${i}].measured not real|simulated`);
      need(s.tokens === s.promptTokens + s.generatedTokens, `stages[${i}].tokens != prompt+generated`);
    }
    // Cards are the stages, 1:1, in order.
    need(Array.isArray(report.cards) && report.cards.length === report.stages.length, 'cards are not 1:1 with stages');
    if (Array.isArray(report.cards)) {
      report.cards.forEach((c, i) => {
        need(c.stage === report.stages[i]?.id && c.tokens === report.stages[i]?.tokens && c.source === report.stages[i]?.source, `cards[${i}] does not mirror stages[${i}]`);
      });
    }
  }
  need(Array.isArray(report.tiles) && report.tiles.length === TILE_LABELS.length, 'tiles are not the four schema tiles');
  if (Array.isArray(report.tiles)) {
    need(report.tiles.every((t, i) => t.label === TILE_LABELS[i]), 'tile labels/order differ from the schema');
  }
  need(report.verdict && ['proven', 'failed', 'unmeasured', 'aborted'].includes(report.verdict.status), 'verdict.status unknown');
  if (report.verdict?.status === 'proven') need(report.mode === 'real', 'a proven verdict in a non-real report');
  need(report.totals && report.totals.tokens === (report.stages ?? []).reduce((s, x) => s + x.tokens, 0), 'totals.tokens != sum of stage tokens');
  return problems;
}
