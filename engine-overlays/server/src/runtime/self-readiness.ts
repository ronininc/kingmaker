// SELF-READINESS — "Solomon, are you mature enough to be cloned into Kingmaker? What's still missing?"
//
// A question about Solomon's OWN readiness has no web answer. Sent to research, it grounded on a Min Nan
// Wiktionary entry for "statesmanlike" (sbench 2026-09-26) and, once that was fixed, timed out. The answer is
// the operator's own maturity gate — scripts/kingmaker-maturity-gate.mjs, the numeric definition of "mature"
// in docs/KINGMAKER_MATURITY_BAR.md — read here, not re-implemented, so the spoken answer and
// `npm run kingmaker:maturity-gate` can never disagree.
//
// The gate reads the operator's graded benchmark log and declared proof files, which exist only on the
// operator's own machine. Where the gate cannot be loaded (a packaged install without scripts/), this says so
// plainly rather than guessing.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = /\b(solomon|you|your|yourself|you're|youre)\b/i;
// Words that only ever mean Solomon's own readiness when Solomon is addressed.
const READINESS = /\b(kingmaker|clon(?:e|ed|ing)\s+(?:you|yourself|solomon)|matur(?:e|ity)|readiness)\b/i;
// Words that also describe the operator's own work ("can you benchmark my site") — only YOUR benchmark counts.
const STANDING = /\byour\s+(?:own\s+)?(?:pass\s*rates?|benchmarks?|sbench|scores?|grades?)\b|\bhow\s+(?:good|well)\s+are\s+you\s+(?:doing|performing|scoring)\b/i;

/** TRUE for a question about Solomon's own maturity / Kingmaker readiness / benchmark standing. */
export function isSelfReadinessQuestion(transcript: string): boolean {
  const t = String(transcript ?? '').trim();
  // Creative briefs may quote gate/readiness terminology as their subject.
  // Do not replace the requested production job with the operator's audit.
  const mediaProduction = /^(?:(?:please|can you|could you|would you|i need you to|i want you to)\s+)*(?:make|create|render|produce|edit|animate|write|build)\b[^.?!\n]{0,100}\b(?:reel|video|film|animation|advertisement|commercial|storyboard|voiceover|promo)\b/i;
  if (mediaProduction.test(t)) return false;
  // "Kingmaker" alone is not a readiness question — "send an alert to Kingmaker" is a real control action.
  const kingmakerReadiness = /\bkingmaker\b/i.test(t) && /\b(ready|readiness|clon\w*|matur\w*|missing|how\s+close|when\s+can|exist\w*|gate)\b/i.test(t);
  return kingmakerReadiness || (SELF.test(t) && READINESS.test(t)) || STANDING.test(t);
}

interface EngineRow { engine: string; graded?: number; passed?: number; passRate?: number; ok: boolean; reasons: string[] }
interface GateResult {
  verdict: 'READY_TO_CLONE' | 'NOT_READY';
  bar: { windowDays: number; minGradedRuns: number; minPassRate: number };
  engines: EngineRow[];
  proofMatrix: { ok: boolean; reasons: string[] };
  declaredProofs: Array<{ what: string; ok: boolean; reasons: string[] }>;
}
export type GateRunner = () => GateResult | Promise<GateResult>;

function gateScriptPath(): string | null {
  // server/src/runtime → repo root
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const path = join(root, 'scripts', 'kingmaker-maturity-gate.mjs');
  return existsSync(path) ? path : null;
}

async function defaultGate(): Promise<GateResult> {
  const path = gateScriptPath();
  if (!path) throw new Error('the maturity gate script is not part of this install');
  const mod = await import(pathToFileURL(path).href) as { runGate: () => GateResult };
  return mod.runGate();
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

/** The plain spoken answer, built only from the gate's own verdict and numbers. */
export function describeReadiness(gate: GateResult): string {
  const { bar } = gate;
  const failing = gate.engines.filter((e) => !e.ok);
  const engineLine = (e: EngineRow) => (typeof e.graded === 'number' && e.graded > 0
    ? `${e.engine} ${e.passed}/${e.graded} (${pct(e.passRate ?? 0)})`
    : `${e.engine} (no graded runs)`);
  if (gate.verdict === 'READY_TO_CLONE') {
    return `Yes — my maturity gate says READY_TO_CLONE: every engine clears ${bar.minGradedRuns} graded runs at ${pct(bar.minPassRate)} over ${bar.windowDays} days, the proof matrix is clean, and the Ronin OS lock and both capstone proofs are recorded.`;
  }
  const parts: string[] = [`Not yet — my maturity gate says NOT_READY.`];
  if (failing.length) {
    parts.push(`${failing.length} of ${gate.engines.length} engines are below the bar of ${bar.minGradedRuns} graded runs at ${pct(bar.minPassRate)} over ${bar.windowDays} days: ${failing.map(engineLine).join(', ')}.`);
  }
  if (!gate.proofMatrix.ok) parts.push(`The proof matrix is not clean: ${gate.proofMatrix.reasons.join('; ')}.`);
  const missing = gate.declaredProofs.filter((p) => !p.ok);
  if (missing.length) parts.push(`Not yet proven: ${missing.map((p) => p.what).join('; ')}.`);
  const passing = gate.engines.filter((e) => e.ok);
  if (passing.length) parts.push(`Already clear: ${passing.map(engineLine).join(', ')}.`);
  parts.push(`Source: npm run kingmaker:maturity-gate (docs/KINGMAKER_MATURITY_BAR.md).`);
  return parts.join(' ');
}

/** Answer a self-readiness question from the maturity gate, or say plainly why it cannot be read. */
export async function buildSelfReadinessAnswer(runGate: GateRunner = defaultGate): Promise<string> {
  try {
    return describeReadiness(await runGate());
  } catch (error) {
    return `I can't read my maturity gate here (${error instanceof Error ? error.message : String(error)}), so I won't guess whether I'm ready. On the operator's machine, npm run kingmaker:maturity-gate gives the verdict.`;
  }
}
