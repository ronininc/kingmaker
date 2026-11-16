// lib/child-env.mjs — the minimum environment for an external tool (2026-11-16 security boundary).
// A child gets ONLY: a short allowlist of plain variables copied from this process (no API keys, tokens, vault keys,
// nonces, session ids), plus the values the caller sets explicitly for that tool. Variables that inject code into
// the child's runtime (NODE_OPTIONS, DYLD_*, LD_*, PYTHONSTARTUP, …) are refused even when set explicitly.
export const BASE_ENV_KEYS = Object.freeze(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TZ', 'TMPDIR', 'TERM']);
const INJECTION = /^(NODE_OPTIONS|NODE_PATH|NODE_REPL_EXTERNAL_MODULE|DYLD_\w+|LD_\w+|PYTHONSTARTUP|PYTHONPATH|PYTHONHOME|PERL5OPT|PERL5LIB|RUBYOPT|RUBYLIB|BASH_ENV|ENV|PROMPT_COMMAND|GIT_SSH_COMMAND|ELECTRON_EXTRA_LAUNCH_ARGS)$/;

/**
 * minimalEnv({ pass, set, from }) → a fresh env object.
 *  pass: extra variable NAMES (non-secret, e.g. OLLAMA_HOST) to copy from `from` when present.
 *  set:  explicit values for this tool (win over copied ones). undefined/null values are dropped.
 */
export function minimalEnv({ pass = [], set = {}, from = process.env } = {}) {
  const out = {};
  for (const k of [...BASE_ENV_KEYS, ...pass]) if (typeof from?.[k] === 'string' && from[k] !== '') out[k] = from[k];
  for (const k of Object.keys(from ?? {})) if (/^LC_[A-Z]+$/.test(k) && typeof from[k] === 'string') out[k] = from[k];
  for (const [k, v] of Object.entries(set ?? {})) {
    if (v === undefined || v === null) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(k)) throw new Error(`child-env: invalid variable name "${String(k).slice(0, 40)}"`);
    if (INJECTION.test(k)) throw new Error(`child-env: ${k} injects code into the child and is never passed`);
    out[k] = String(v);
  }
  for (const k of Object.keys(out)) if (INJECTION.test(k)) delete out[k];
  return out;
}
