// lib/turn-chain.mjs — GROUPED INSTRUCTIONS (4.3): one typed instruction carrying several ordered steps
// ("probe GitHub, then check Stripe; then run the CRM report") runs as ordered sub-turns through the same
// governed path a single turn takes — fast lanes first, then the governed brain — in the same conversation,
// so every step is its own governed, audit-chained turn and no step is swallowed by the lane that answered
// the one before it (0.4.2 answered a multi-probe instruction with the canned capability card, twice, and
// none of the probes ran).
//
// Splitting is deliberately conservative: ONLY explicit separators — semicolons, arrows, " then ",
// a comma directly before another imperative, and numbered/bulleted or short imperative list lines.
// A bare "and" or a plain comma never splits ("Bob and Sons" is one ask): fuzzier decompositions belong
// to the engine's multi-step planner, server-side. If the split is not clean (fewer than 2 or more than
// MAX_CHAIN_STEPS steps), the turn runs whole, exactly as before.

export const MAX_CHAIN_STEPS = 8;

const STEP_MARKER = /^(?:step\s+\d+\s*[:.)-]\s*|\d+\s*[.)]\s*|[-•*]\s+)/i;
const IMPERATIVE_LEAD = /^(?:please\s+|also\s+|now\s+)?(?:probe|test|check|run|fetch|get|list|read|show|scan|open|search|find|pull|verify|connect|send|create|make|build|write|look\s+up|try|use|ask|ping|call|start|stop|add|set|turn|play|book|post|print|save|copy|move|delete|remove|update|install)\b/i;
// In-line step boundaries: ";", "->", "→", " then ", or a comma whose next words are another imperative.
const INLINE_BOUNDARY = /\s*;\s*|\s+->\s*|\s*→\s*|\s+then\s+|,\s*(?=(?:and\s+)?(?:please\s+)?(?:probe|test|check|run|fetch|get|list|read|show|scan|open|search|find|pull|verify|connect|send|create|make|build|write|try|use|ask|ping|call|start|add|set)\b)/i;

const words = (s) => s.split(/\s+/).filter(Boolean).length;
const clean = (s) => s.trim().replace(STEP_MARKER, '').replace(/^(?:and|then)\s+/i, '').replace(/[,\s]+$/, '').trim();

/** Pure: the ordered steps of a grouped instruction, or [] when the text is a single turn. */
export function splitInstructionChain(text) {
  const raw = String(text ?? '');
  if (!raw.trim()) return [];
  const inLine = raw.split(INLINE_BOUNDARY).map(clean).filter((s) => words(s) >= 2);
  if (inLine.length >= 2) return inLine.length <= MAX_CHAIN_STEPS ? inLine : [];
  // Newline-separated steps qualify only as a list: marked lines (1. / 2) / - / •), or short lines of
  // which at least two lead with an imperative — a pasted paragraph or document is never a chain.
  const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (lines.length >= 2 && lines.length <= MAX_CHAIN_STEPS) {
    const marked = lines.filter((l) => STEP_MARKER.test(l)).length;
    const steps = lines.map(clean).filter((s) => words(s) >= 2);
    if (steps.length >= 2 && (marked >= 2 || (lines.every((l) => l.length <= 140) && steps.filter((s) => IMPERATIVE_LEAD.test(s)).length >= 2))) return steps;
  }
  return [];
}
