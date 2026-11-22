/**
 * lib/governance.mjs (kingmaker-stack)
 *
 * The shared governance primitives every stack fold-in is built from —
 * the same three shapes the house stack already runs on:
 *
 *   refused(reason)     the one refusal shape: { ok: false, refused: true }
 *   createTapGate(fn)   the founder-tap gate (LittleBrother methods-full
 *                       pattern): no verifier configured → every gated
 *                       call refuses. Fail-closed, always.
 *   createEgressGuard() the host-side egress guard (cell-governor
 *                       pattern): destinations are declared, never
 *                       improvised. Default posture is DENY — an empty
 *                       allowlist reaches nothing. Checks happen BEFORE
 *                       any transport runs, and both outcomes are
 *                       audit-logged when a log is attached.
 *   csamHit(text)       the seed blocklist screen (darkweb-search /
 *                       LittleBrother discipline): a match aborts, is
 *                       logged WITHOUT content, and has no override.
 */

export function refused(reason, extra = {}) {
  return { ok: false, refused: true, reason, ...extra };
}

/**
 * createTapGate(verifyTap) — verifyTap is a (possibly async) function
 * (token) => boolean. Absent verifier → the gate refuses everything.
 * Returns an async gate(token): null when the tap verifies (proceed),
 * a refusal object when it does not.
 */
export function createTapGate(verifyTap) {
  const verify = typeof verifyTap === 'function' ? verifyTap : null;
  return async function gate(tapToken) {
    if (!verify) return refused('no tap verifier configured — fail-closed');
    let ok = false;
    try {
      ok = Boolean(await verify(tapToken));
    } catch {
      ok = false;
    }
    return ok ? null : refused('founder tap required — governed action refused');
  };
}

// Minimal seed blocklist, mirrored from darkweb-search / LittleBrother.
// NOT production-complete. A matched input aborts the call — no override.
const CSAM_SEED_PATTERNS = [
  /\bchild\s*porn/i,
  /\bcp\s*(video|pic|image)/i,
  /\blolita\b/i,
  /\bpreteen\b/i,
];

export function csamHit(text) {
  if (typeof text !== 'string') return false;
  for (const re of CSAM_SEED_PATTERNS) {
    if (re.test(text)) return true;
  }
  return false;
}

function hostMatches(host, entry) {
  const h = host.toLowerCase();
  const e = String(entry).toLowerCase();
  if (e.startsWith('*.')) {
    const suffix = e.slice(2);
    return h === suffix || h.endsWith(`.${suffix}`);
  }
  return h === e;
}

/**
 * createEgressGuard({ allow = [], auditLog = null, actor = 'egress-guard' })
 *
 * allow entries are hostnames ('example.com') or suffix wildcards
 * ('*.example.com' — matches the host itself and any subdomain).
 * check(rawUrl) → { ok: true, host, url } | refusal object.
 * Only http:/https: URLs are ever allowed; URLs carrying credentials
 * are refused outright (a credential in a URL leaks into logs).
 */
export function createEgressGuard({ allow = [], auditLog = null, actor = 'egress-guard' } = {}) {
  const allowlist = [...allow];
  const log = (action, detail, meta = {}) => {
    if (auditLog) auditLog.append({ actor, action, detail, meta });
  };

  function check(rawUrl) {
    let url;
    try {
      url = new URL(String(rawUrl));
    } catch {
      const r = refused(`egress: unparseable URL refused`);
      log('egress.refused', r.reason, { url: String(rawUrl).slice(0, 120) });
      return r;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      const r = refused(`egress: scheme '${url.protocol}' refused — http/https only`);
      log('egress.refused', r.reason, { url: url.toString().slice(0, 120) });
      return r;
    }
    if (url.username || url.password) {
      const r = refused('egress: URL carries credentials — refused');
      log('egress.refused', r.reason, { host: url.hostname });
      return r;
    }
    const host = url.hostname;
    if (!allowlist.some((entry) => hostMatches(host, entry))) {
      const r = refused(`egress: host '${host}' is not on the declared allowlist — refused`);
      log('egress.refused', r.reason, { host });
      return r;
    }
    log('egress.allowed', `host=${host}`, { host });
    return { ok: true, host, url };
  }

  return { check, allowlist: Object.freeze([...allowlist]) };
}
