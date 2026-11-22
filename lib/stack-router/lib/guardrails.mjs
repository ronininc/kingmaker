/**
 * lib/guardrails.mjs (router-phase2)
 *
 * The Phase-2 guardrail set — patterns studied from RuFlow's MCP surface
 * (behavior spec §5.3, mapping §8) and re-implemented clean-room, taking
 * only what the spec judges genuinely effective:
 *
 *   PORTED — the strong path validator (§5.3 "Real"): canonicalize via
 *     realpath, allowed-prefix allowlist, symlink handling, blocked
 *     names/extensions (.env, keys, .git, id_rsa).
 *   PORTED — the field validators' env-var denylist (§5.3 "Real"):
 *     loader-hijack variables (LD_PRELOAD, DYLD_*, NODE_OPTIONS, …) can
 *     never be granted to a task, even when its scope names them.
 *   PORTED — the mod screen's surface prep (§5.2/§5.3 "best of the
 *     three"): invisible/bidi characters are stripped before any pattern
 *     matching, so zero-width evasion doesn't sail past the screen.
 *   ADAPTED — the AIDefence injection patterns (§5.3: "decoration as a
 *     gate"). Upstream runs 50+ regexes as an opt-in tool the model may
 *     call. A regex gate is decoration — trivially paraphrased around.
 *     Here the screen is an EVIDENCE signal, never an authorization: a
 *     flagged task is routed to the governed brain for the full chain,
 *     never silently executed on a fast lane, and never hard-blocked on
 *     a regex's say-so either (false positives on ordinary words are
 *     upstream's known failure — the governed brain, not the pattern,
 *     makes the call).
 *
 * Every guard decision — allow, refuse, flag, clear — appends to the
 * hash-chained audit log when one is supplied. Rule for all three
 * guards: audit entries carry names and paths, NEVER secret values.
 */

import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve, sep, basename } from 'node:path';

/* ------------------------------------------------------------------ *
 * (a) Prompt-injection screen — advisory Evidence, routed, not gated
 * ------------------------------------------------------------------ */

/** Invisible / bidi / zero-width characters stripped before matching. */
/** Strip invisible / bidi / zero-width characters (codepoint filter —
 *  no literal escapes to mangle). Matches the mod screen's prep step.
 *  Exported for doctor's self-test. */
export function stripInvisible(s) {
  return [...String(s)].filter((ch) => {
    const c = ch.codePointAt(0);
    return !((c >= 0x200B && c <= 0x200F) || (c >= 0x202A && c <= 0x202E) ||
             (c >= 0x2060 && c <= 0x2064) || c === 0xFEFF);
  }).join('');
}

const INJECTION_FAMILIES = {
  'instruction-override': [
    /ignore\s+(all\s+|the\s+|your\s+)?(previous|prior|above|earlier)\s+(instructions|prompts|rules)/i,
    /disregard\s+(all\s+|the\s+|your\s+)?(instructions|rules|guidelines|previous)/i,
    /forget\s+(all\s+|your\s+|the\s+)?(instructions|rules|training)/i,
    /override\s+(your\s+|the\s+)?(instructions|system\s+prompt|rules|programming)/i,
    /do\s+not\s+follow\s+(your|the)\s+(instructions|rules|guidelines)/i,
    /^\s*(new|updated|revised)\s+instructions\s*:/im,
  ],
  'role-hijack': [
    /you\s+are\s+now\s+(a\s+|an\s+|the\s+)?(?!going\b)/i,
    /act\s+as\s+(if\s+you\s+are|a\s+|an\s+)/i,
    /pretend\s+(you\s+are|to\s+be)\b/i,
    /from\s+now\s+on,?\s+you\s+(are|will\s+act)/i,
    /your\s+(new|real|true)\s+(role|persona|identity|instructions)\s+(is|are)\b/i,
    /enter\s+(developer|debug|god|jailbreak)\s+mode/i,
  ],
  'exfiltration': [
    /(reveal|print|show|output|repeat|tell\s+me|give\s+me)\s+(your|the)\s+(system\s+)?(prompt|instructions|rules)/i,
    /what\s+(is|are)\s+your\s+(system\s+)?(prompt|instructions|initial\s+instructions)/i,
    /(exfiltrate|leak|dump|send)\b[^.\n]{0,40}\b(prompt|instructions|api[\s-]?keys?|secrets?|tokens?|credentials?|environment\s+variables?)/i,
    /(output|print|reveal|show)\b[^.\n]{0,30}\b(api[\s-]?key|secret\s+key|access\s+token|password)s?\b/i,
  ],
};

/**
 * Screen task text before it enters the governed router. Returns
 *   { flagged, hits: [{ family, pattern }], recommendation, stripped }
 * where recommendation is 'governed-brain' when flagged (the full chain
 * decides — the screen never executes and never vetoes) and 'clear'
 * otherwise. `pattern` is the index of the matched pattern within its
 * family, not the regex itself.
 */
export function screenTaskText(text, { auditLog = null } = {}) {
  const raw = String(text ?? '');
  const stripped = stripInvisible(raw);
  const hits = [];
  for (const [family, patterns] of Object.entries(INJECTION_FAMILIES)) {
    patterns.forEach((re, idx) => {
      if (re.test(stripped)) hits.push({ family, pattern: idx });
    });
  }
  const flagged = hits.length > 0;
  if (auditLog) {
    auditLog.append({
      actor: 'guardrails',
      action: flagged ? 'guardrail.injection-flag' : 'guardrail.injection-clear',
      detail: flagged
        ? `task text flagged (${[...new Set(hits.map((h) => h.family))].join(', ')}) — routed to the governed brain`
        : 'task text clear',
      meta: { flagged, families: [...new Set(hits.map((h) => h.family))], hitCount: hits.length },
    });
  }
  return { flagged, hits, recommendation: flagged ? 'governed-brain' : 'clear', stripped };
}

/* ------------------------------------------------------- *
 * (b) Path-traversal guard — canonicalize + allowlist
 * ------------------------------------------------------- */

export const DEFAULT_BLOCKED_NAMES = ['.env', '.git', 'id_rsa', 'id_ed25519', 'id_dsa', 'id_ecdsa'];
export const DEFAULT_BLOCKED_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx', '.keystore'];

/** Canonical form of a path that may not fully exist yet: realpath the
 *  longest existing ancestor (resolving every symlink on the way), then
 *  re-attach the non-existent remainder lexically. */
function canonicalize(p) {
  let current = p;
  const rest = [];
  for (;;) {
    if (existsSync(current)) {
      const real = realpathSync(current);
      return rest.length ? resolve(real, ...rest) : real;
    }
    const parent = resolve(current, '..');
    if (parent === current) return p; // reached the root without finding anything
    rest.unshift(basename(current));
    current = parent;
  }
}

/**
 * Create a path guard over an allowed root set. checkPath(input):
 *   - relative inputs resolve against roots[0];
 *   - the canonical path (symlinks resolved) must sit inside a root;
 *   - any segment naming a blocked file (.env, .git, id_rsa, …) or ending
 *     in a blocked extension (.pem, .key, …) is refused — even inside a
 *     root. A task never legitimately reads key material by path.
 * Returns { allowed, canonical, reason? }. Every decision is audited.
 */
export function createPathGuard({ roots, auditLog = null, blockedNames = DEFAULT_BLOCKED_NAMES, blockedExtensions = DEFAULT_BLOCKED_EXTENSIONS } = {}) {
  if (!Array.isArray(roots) || roots.length === 0) {
    throw new Error('guardrails: createPathGuard needs at least one allowed root');
  }
  const canonRoots = roots.map((r) => canonicalize(resolve(r)));
  const nameBlocked = (segment) =>
    blockedNames.some((b) => segment === b || segment.startsWith(b + '.')) ||
    blockedExtensions.some((e) => segment.toLowerCase().endsWith(e));

  function checkPath(input) {
    let result;
    if (typeof input !== 'string' || input.trim() === '') {
      result = { allowed: false, reason: 'empty-path', canonical: null };
    } else {
      const abs = isAbsolute(input) ? resolve(input) : resolve(canonRoots[0], input);
      const canonical = canonicalize(abs);
      const segments = canonical.split(sep).filter(Boolean);
      const badSegment = segments.find((s) => nameBlocked(s));
      const inside = canonRoots.some((r) => canonical === r || canonical.startsWith(r + sep));
      if (badSegment) {
        result = { allowed: false, reason: `blocked-name: ${badSegment}`, canonical };
      } else if (!inside) {
        result = { allowed: false, reason: 'outside-roots', canonical };
      } else {
        result = { allowed: true, canonical };
      }
    }
    if (auditLog) {
      auditLog.append({
        actor: 'guardrails',
        action: result.allowed ? 'guardrail.path-allow' : 'guardrail.path-refuse',
        detail: result.allowed ? `path allowed: ${result.canonical}` : `path refused (${result.reason}): ${String(input)}`,
        meta: { input: String(input), canonical: result.canonical, reason: result.reason ?? null },
      });
    }
    return result;
  }

  return { checkPath, roots: [...canonRoots] };
}

/* ------------------------------------------------- *
 * (c) Secret-scoped sandbox environment builder
 * ------------------------------------------------- */

/**
 * Variables that can never be granted, even when a scope names them —
 * the loader-hijack / interpreter-injection family from the upstream
 * terminal denylist (§5.3). Granting one of these hands the task the
 * host process, which is the opposite of a sandbox.
 */
export const NEVER_GRANTED_ENV = [
  'LD_PRELOAD', 'LD_AUDIT', 'LD_LIBRARY_PATH', 'LD_DEBUG',
  'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH',
  'DYLD_FALLBACK_LIBRARY_PATH', 'DYLD_FALLBACK_FRAMEWORK_PATH',
  'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE',
  'BASH_ENV', 'ENV', 'PROMPT_COMMAND', 'ZDOTDIR',
];

/**
 * Build a task's environment from an explicit scope: the task gets ONLY
 * the variables its scope names, and only when they exist in `base`.
 * Everything else is stripped — including secrets the scope didn't ask
 * for, and including never-granted variables the scope DID ask for.
 * Returns { env, granted, denied, missing } — names only, never values.
 * The decision is audited with names only.
 */
export function buildSandboxEnv({ scope = [], base = process.env, auditLog = null } = {}) {
  const never = new Set(NEVER_GRANTED_ENV);
  const env = {};
  const granted = [];
  const denied = [];
  const missing = [];
  for (const name of scope) {
    if (never.has(name)) {
      denied.push(name);
    } else if (Object.prototype.hasOwnProperty.call(base, name)) {
      env[name] = base[name];
      granted.push(name);
    } else {
      missing.push(name);
    }
  }
  if (auditLog) {
    auditLog.append({
      actor: 'guardrails',
      action: 'guardrail.sandbox-env',
      detail: `sandbox env built: granted [${granted.join(', ') || 'none'}]${denied.length ? `; denied [${denied.join(', ')}]` : ''}${missing.length ? `; missing [${missing.join(', ')}]` : ''}`,
      meta: { granted, denied, missing },
    });
  }
  return { env, granted, denied, missing };
}
