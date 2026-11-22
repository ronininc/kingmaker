/**
 * lib/littlebrother.mjs
 *
 * LittleBrother's spine-facing core. One factory, two builds:
 *
 *   mode 'kingmaker' — the public-source methods, PLUS an additional
 *   governed method set loaded from a sibling module at construction.
 *   That set is tap-gated: every call in it requires a verified founder
 *   tap token, and every refusal is audit-logged.
 *
 *   mode 'solomon' — the public-source methods ONLY. The additional set
 *   is never loaded, and its methods DO NOT EXIST on the returned object.
 *   Not disabled — absent. A method that doesn't exist can't be invoked,
 *   and the Solomon bundle (build-solomon.mjs) removes the loading code
 *   itself, so the absence is physical, not a flag.
 *
 * Every call runs through this wrapper: CSAM input/result screening
 * (auto-abort, logged WITHOUT content, no override path — the discipline
 * mirrored from darkweb-search), then the call, then an entry appended to
 * the local hash-chained audit log. Lookups and refusals are both logged.
 *
 * Local-first: transport is injected by the host; this module ships no
 * network code and no telemetry.
 *
 * Clean-room: implemented from the boundary spec; the GPL upstream was
 * never read and its code is not here.
 */

import { fileURLToPath } from 'node:url';
import { openAuditLog } from './audit-log.mjs';
import * as publicMethods from './methods-public.mjs';

// Minimal seed blocklist. NOT production-complete — the production build
// must extend it, same standing note as darkweb-search.
const CSAM_SEED_PATTERNS = [
  /\bchild\s*porn/i,
  /\bcp\s*(video|pic|image)/i,
  /\blolita\b/i,
  /\bpreteen\b/i,
];

function csamHit(text) {
  if (typeof text !== 'string') return false;
  for (const re of CSAM_SEED_PATTERNS) {
    if (re.test(text)) return true;
  }
  return false;
}

function defaultAuditPath() {
  return fileURLToPath(new URL('../audit/littlebrother-audit.jsonl', import.meta.url));
}

/**
 * createLittleBrother({ mode, transport, tapVerifier, auditPath, auditLog, spine })
 *
 *   mode        'kingmaker' (default) | 'solomon'
 *   transport   injected async fn({ kind, target, params }) for public lookups
 *   tapVerifier injected (async) fn(token) => boolean; required for the
 *               governed set — absent means every governed call refuses
 *   auditPath   JSONL audit log path (default ../audit/littlebrother-audit.jsonl)
 *   auditLog    a pre-opened audit log (from audit-log.mjs) — overrides auditPath
 *   spine       spine label recorded in audit metadata (default 'custom')
 */
export async function createLittleBrother(opts = {}) {
  const mode = opts.mode ?? 'kingmaker';
  if (mode !== 'kingmaker' && mode !== 'solomon') {
    throw new Error(`littlebrother: unknown mode '${mode}' — expected 'kingmaker' or 'solomon'`);
  }
  const spine = opts.spine ?? 'custom';
  const transport = typeof opts.transport === 'function' ? opts.transport : null;
  const audit = opts.auditLog ?? openAuditLog(opts.auditPath ?? defaultAuditPath());

  function log(action, detail, meta = {}) {
    audit.append({ actor: 'littlebrother', action, detail, meta: { mode, spine, ...meta } });
  }

  /**
   * Wrap one method with screening + audit. `invoke(input, callOpts)` runs
   * the underlying method. Governance refusals come back as result objects;
   * only programmer errors throw (and are logged before they propagate).
   */
  function wrap(id, invoke) {
    return async (input, callOpts = {}) => {
      const targetStr = typeof input === 'string' ? input : '';

      // CSAM screen on the INPUT — abort before any transport runs.
      // Logged WITHOUT content. There is no override path.
      if (targetStr && csamHit(targetStr)) {
        log('csam-abort', `method=${id} where=input — content withheld by policy`);
        return { ok: false, aborted: true, reason: 'CSAM auto-abort: no override path exists' };
      }

      let result;
      try {
        result = await invoke(input, callOpts);
      } catch (err) {
        log('lookup-error', `method=${id} error=${err.message}`);
        throw err;
      }

      // CSAM screen on the RESULT payload before it reaches the caller.
      if (result?.ok && csamHit(JSON.stringify(result.data ?? ''))) {
        log('csam-abort', `method=${id} where=result — content withheld by policy`);
        return { ok: false, aborted: true, reason: 'CSAM auto-abort: no override path exists' };
      }

      const action = result?.ok
        ? 'lookup'
        : result?.aborted
          ? 'csam-abort'
          : result?.refused
            ? 'lookup-refused'
            : 'lookup-error';
      log(action, `method=${id} target=${targetStr.slice(0, 120)}`, {
        verified: result?.verified ?? null,
        stub: result?.stub ?? false,
        ...(result?.reason ? { reason: String(result.reason).slice(0, 200) } : {}),
      });
      return result;
    };
  }

  const api = {
    mode,
    spine,
    auditPath: audit.path,
    methods: [],
    verifyAudit: () => audit.verify(),
  };

  // Public-source methods — present in both builds.
  for (const id of publicMethods.METHOD_IDS) {
    api[id] = wrap(id, (input, callOpts) =>
      publicMethods[id](input, { ...callOpts, transport })
    );
    api.methods.push(id);
  }

  let fullLoaded = false;
  /* __LB_FULL_BEGIN__ */
  if (mode === 'kingmaker') {
    const fullModule = await import('./methods-full.mjs');
    const fullApi = fullModule.createFullMethods({ verifyTap: opts.tapVerifier ?? null });
    for (const [id, fn] of Object.entries(fullApi)) {
      api[id] = wrap(id, (input, callOpts) => fn(input, callOpts));
      api.methods.push(id);
    }
    fullLoaded = true;
  }
  /* __LB_FULL_END__ */
  if (mode === 'kingmaker' && !fullLoaded) {
    // Reached only in a build where the loading block above was removed.
    throw new Error('littlebrother: the kingmaker method set is not present in this build');
  }

  Object.freeze(api.methods);
  return Object.freeze(api);
}
