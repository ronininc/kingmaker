/**
 * lib/codemod-prefilter.mjs
 *
 * The Tier-0/1 pre-filter: mechanical edits a regex can be sure of are
 * applied by a deterministic codemod and skip the model entirely ($0).
 * Pattern studied from RuFlow's enhanced model router (behavior spec §1.2,
 * mapping §8: PORT) and re-implemented clean-room — six intent types:
 * var→const, add types, add error handling, async/await, add logging,
 * remove console.
 *
 * The bar is confidence, in both directions: the task text must name the
 * mechanical edit AND the transform must actually apply to the supplied
 * code. Either one missing → { handled: false } and the task falls through
 * to the bandit router. A codemod that half-applies is worse than a model
 * call — it bills nothing and quietly ships a wrong edit.
 */

/** Strip string literals and comments so brace/paren counting sees structure, not prose. */
function stripNoise(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, '""');
}

/** Index of the delimiter matching the opener at `openIdx`, or -1. Counts on noise-stripped code. */
function matchDelim(code, openIdx, open, close) {
  const clean = stripNoise(code);
  let depth = 0;
  for (let i = openIdx; i < clean.length; i++) {
    if (clean[i] === open) depth++;
    else if (clean[i] === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const TRANSFORMS = {
  'var-to-const': {
    intent: /\bvar-to-const\b|\b(var|let)\b[^.\n]{0,40}\bconst\b|\bconst\b[^.\n]{0,40}\b(var|let)\b|\breplace\b[^.\n]*\bvar\b[^.\n]*\bconst\b/i,
    description: 'rewrite var declarations as const',
    apply(code) {
      // `var` followed by an identifier is a declaration; `obj.var` and `{ var: 1 }` are not.
      const out = code.replace(/(^|[^\w$.])var(?=\s+[A-Za-z_$])/gm, '$1const');
      return out === code ? null : out;
    },
  },

  'remove-console': {
    intent: /\bremove\b[^.\n]*\bconsole\b|\bstrip\b[^.\n]*\bconsole\b|\bdelete\b[^.\n]*\bconsole\./i,
    description: 'delete lines that are solely a console.* statement',
    apply(code) {
      const lines = code.split('\n');
      const kept = lines.filter((l) => !/^\s*console\.(log|debug|info|warn|error|trace)\(.*\);?\s*$/.test(l));
      return kept.length === lines.length ? null : kept.join('\n');
    },
  },

  'add-logging': {
    intent: /\badd\b[^.\n]*\b(logging|logs?|console\.log)\b|\binstrument\b[^.\n]*\bfunctions?\b/i,
    description: 'insert a console.log entry line at the top of each named function body',
    apply(code) {
      let changed = false;
      const out = code.replace(
        /(function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{)/g,
        (m, head, name) => {
          changed = true;
          return `${head}\n  console.log('${name}');`;
        }
      );
      return changed ? out : null;
    },
  },

  'add-types': {
    intent: /\badd\b[^.\n]*\b(static\s+)?types\b|\bannotate\b[^.\n]*\b(parameters?|params?|types)\b|\btypescript types\b/i,
    description: 'annotate untyped function parameters with : unknown (TypeScript)',
    apply(code) {
      let changed = false;
      const out = code.replace(
        /function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g,
        (m, name, params) => {
          const parts = params.split(',').map((p) => p.trim()).filter(Boolean);
          if (parts.length === 0 || parts.some((p) => p.includes(':'))) return m;
          changed = true;
          return `function ${name}(${parts.map((p) => `${p}: unknown`).join(', ')})`;
        }
      );
      return changed ? out : null;
    },
  },

  'add-error-handling': {
    intent: /\badd\b[^.\n]*\b(error handling|try[ /-]?catch)\b|\bwrap\b[^.\n]*\btry\b/i,
    description: 'wrap the snippet in try/catch that logs and rethrows',
    apply(code) {
      if (/\btry\s*\{/.test(code)) return null; // already guarded — a second wrap is noise
      const body = code.replace(/\n+$/, '').split('\n').map((l) => (l ? `  ${l}` : l)).join('\n');
      return `try {\n${body}\n} catch (error) {\n  console.error(error);\n  throw error;\n}`;
    },
  },

  'async-await': {
    intent: /\basync\s*\/?\s*await\b|\bconvert\b[^.\n]*\b(promises?|\.then)\b[^.\n]*\basync\b|\bpromises?\s+to\s+async\b/i,
    description: 'rewrite a single .then chain as await with try/catch for .catch',
    apply(code) {
      // One narrow shape, rewritten only when every piece is found:
      //   BASE.then(PARAM => { BODY }).catch(PARAM2 => { BODY2 });
      // as a single expression statement (the .catch is optional).
      const thenIdx = code.indexOf('.then(');
      if (thenIdx === -1 || code.indexOf('.then(', thenIdx + 1) !== -1) return null;
      // The statement may span lines (chain links on their own lines, each starting
      // with '.'): find the line holding .then and walk up past continuation lines.
      const allLines = code.split('\n');
      let thenLine = 0;
      let acc = 0;
      for (let i = 0; i < allLines.length; i++) {
        if (acc + allLines[i].length >= thenIdx) { thenLine = i; break; }
        acc += allLines[i].length + 1;
      }
      let stmtLine = thenLine;
      while (stmtLine > 0 && allLines[stmtLine].trimStart().startsWith('.')) stmtLine--;
      let stmtStart = 0;
      for (let i = 0; i < stmtLine; i++) stmtStart += allLines[i].length + 1;
      const indent = /^\s*/.exec(code.slice(stmtStart))[0];
      const base = code.slice(stmtStart, thenIdx).trim();
      if (!base || /[;{}]/.test(base)) return null;

      const arrowParenEnd = matchDelim(code, thenIdx + 5, '(', ')');
      if (arrowParenEnd === -1) return null;
      const arrowHead = code.slice(thenIdx + 6, arrowParenEnd).trim(); // "data => { ... " begins inside
      const arrowMatch = /^\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>\s*\{/.exec(arrowHead) ??
        /^\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>/.exec(arrowHead);
      if (!arrowMatch) return null;
      const param = arrowMatch[1];
      const braceIdx = code.indexOf('{', thenIdx + 6 + arrowHead.indexOf('{'));
      const bodyIsBlock = arrowHead.includes('{');
      let thenBody, afterThen;
      if (bodyIsBlock) {
        const braceEnd = matchDelim(code, braceIdx, '{', '}');
        if (braceEnd === -1) return null;
        thenBody = code.slice(braceIdx + 1, braceEnd).replace(/^\n+|\s+$/g, '');
        afterThen = arrowParenEnd + 1;
      } else {
        // Expression-bodied arrow: (x) => expr — the body is what follows the =>, inside the parens.
        thenBody = `return (${code.slice(thenIdx + 6 + arrowMatch[0].length, arrowParenEnd).trim()});`;
        afterThen = arrowParenEnd + 1;
      }

      let catchBody = null;
      const rest = code.slice(afterThen);
      const catchMatch = /^\s*\.catch\(/.exec(rest);
      if (catchMatch) {
        const catchParen = afterThen + catchMatch[0].length - 1;
        const catchEnd = matchDelim(code, catchParen, '(', ')');
        if (catchEnd === -1) return null;
        const catchHead = code.slice(catchParen + 1, catchEnd);
        const cb = /^\s*\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>\s*\{/.exec(catchHead);
        if (!cb) return null;
        const cbBrace = code.indexOf('{', catchParen + 1);
        const cbEnd = matchDelim(code, cbBrace, '{', '}');
        if (cbEnd === -1) return null;
        catchBody = { param: cb[1], body: code.slice(cbBrace + 1, cbEnd).replace(/^\n+|\s+$/g, '') };
        afterThen = catchEnd + 1;
      }
      const tail = code.slice(afterThen).trim();
      if (tail !== '' && tail !== ';') return null; // more statements after the chain — not our shape

      const ind = (s) => s.split('\n').map((l) => (l.trim() ? `${indent}  ${l.replace(/^\s+/, '')}` : l)).join('\n');
      if (catchBody) {
        return `${indent}try {\n${indent}  const ${param} = await ${base};\n${ind(thenBody)}\n${indent}} catch (${catchBody.param}) {\n${ind(catchBody.body)}\n${indent}}`;
      }
      return `${indent}const ${param} = await ${base};\n${ind(thenBody)}`;
    },
  },
};

export const CODEMOD_KINDS = Object.keys(TRANSFORMS);

/**
 * Pure: which codemod the task text names, or null. Intent only — the
 * transform still has to apply to the code before anything is handled.
 */
export function detectCodemod(text) {
  const t = String(text || '');
  for (const [kind, spec] of Object.entries(TRANSFORMS)) {
    if (spec.intent.test(t)) return { kind, description: spec.description };
  }
  return null;
}

/**
 * The pre-filter. task = 'text' | { text, code }.
 * Returns { handled: true, kind, description, output, costUsd: 0 } or
 * { handled: false, reason } — 'no-intent' | 'no-code' | 'not-applicable'.
 * Never throws.
 */
export function prefilter(task) {
  const text = typeof task === 'string' ? task : task?.text ?? '';
  const code = typeof task === 'string' ? undefined : task?.code;
  const hit = detectCodemod(text);
  if (!hit) return { handled: false, reason: 'no-intent' };
  if (typeof code !== 'string' || code.length === 0) return { handled: false, reason: 'no-code' };
  let output = null;
  try {
    output = TRANSFORMS[hit.kind].apply(code);
  } catch {
    output = null; // a codemod that errors is a codemod that doesn't apply
  }
  if (output === null) return { handled: false, reason: 'not-applicable', kind: hit.kind };
  return { handled: true, kind: hit.kind, description: hit.description, output, costUsd: 0 };
}
