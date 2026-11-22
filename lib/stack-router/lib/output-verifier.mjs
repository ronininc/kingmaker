/**
 * lib/output-verifier.mjs
 *
 * The $0 structural verifier: checks a model's output WITHOUT a model call
 * (emptiness, refusal markers, truncation, delimiter balance, parse, simple
 * repetition). Pattern studied from RuFlow's output-verifier (behavior spec
 * §1.5, mapping §8: PORT) and re-implemented clean-room — with the fix the
 * spec calls for: this verdict is the misclassification safety net, and it
 * is executed inside the governed chain, not by an optional hook that a
 * caller may forget to invoke.
 *
 * Returns { pass, escalate, reasons, failedChecks }. `escalate` is true
 * exactly when the output failed structurally — a failed output never
 * "succeeds cheap"; it climbs the tier ladder (handled by governed-router).
 */

const REFUSAL = [
  /\bI\s*(?:can't|cannot|won't|am unable to)\s+(?:help|assist|do|perform|provide|comply)/i,
  /\bI(?:'m| am) sorry,?\s+but\b/i,
  /\bas an AI\b/i,
  /\bI don't have (?:the ability|access|permission) to\b/i,
  /\bunable to (?:fulfill|complete|assist with) (?:this|your) request\b/i,
  /\bagainst my (?:guidelines|programming)\b/i,
  /\bI must (?:decline|refuse)\b/i,
  /\bthis request is (?:outside|beyond) my\b/i,
];

/** Strip strings/comments so delimiter counting sees structure, not prose. */
function stripNoise(code) {
  return String(code)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/#[^\n]*/g, ' ')
    .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, '""');
}

/** Balance check for paired delimiters on noise-stripped text. */
function unbalanced(text) {
  const clean = stripNoise(text);
  const pairs = { '{': '}', '[': ']', '(': ')' };
  const closers = new Set(Object.values(pairs));
  const stack = [];
  for (const ch of clean) {
    if (pairs[ch]) stack.push(pairs[ch]);
    else if (closers.has(ch)) {
      if (stack.pop() !== ch) return true;
    }
  }
  return stack.length !== 0;
}

/** Ends mid-thought rather than at a natural boundary. */
function truncated(output) {
  const t = output.trimEnd();
  if (t.length === 0) return false; // emptiness is its own check
  // Unclosed fences or unbalanced delimiters are truncation evidence.
  const fences = (t.match(/```/g) || []).length;
  if (fences % 2 !== 0) return true;
  if (unbalanced(t)) return true;
  // Ends on a bare word/comma/operator — no closing punctuation in sight.
  if (/[a-zA-Z0-9,:(=[/{-]$/.test(t) && !/[.!?;:}>"')\]]$/.test(t)) return true;
  return false;
}

/** Same non-empty line repeated enough to look like a generation loop. */
function looping(output, minLines = 3) {
  const lines = output.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < minLines) return false;
  const counts = new Map();
  for (const l of lines) counts.set(l, (counts.get(l) ?? 0) + 1);
  return [...counts.values()].some((n) => n >= minLines);
}

/**
 * Verify a model output structurally.
 * opts.expect: 'text' (default) | 'json' | 'code' — stricter parse for the latter two.
 */
export function verifyOutput(output, opts = {}) {
  const { expect = 'text' } = opts;
  const failedChecks = [];
  const reasons = [];
  const text = output == null ? '' : String(output);

  if (text.trim().length === 0) {
    failedChecks.push('empty');
    reasons.push('output is empty or whitespace-only');
  }
  if (REFUSAL.some((re) => re.test(text))) {
    failedChecks.push('refusal');
    reasons.push('output contains a refusal marker');
  }
  if (truncated(text)) {
    failedChecks.push('truncated');
    reasons.push('output looks truncated (unbalanced delimiters or no closing boundary)');
  }
  if (expect === 'json') {
    try {
      JSON.parse(text);
    } catch (e) {
      failedChecks.push('parse');
      reasons.push(`expected JSON but it does not parse: ${e.message}`);
    }
  }
  if (expect === 'code' && unbalanced(text)) {
    failedChecks.push('unbalanced-delimiters');
    reasons.push('code has unbalanced delimiters');
  }
  if (looping(text)) {
    failedChecks.push('repetition');
    reasons.push('output repeats the same line — likely a generation loop');
  }

  const pass = failedChecks.length === 0;
  return { pass, escalate: !pass, reasons, failedChecks };
}
