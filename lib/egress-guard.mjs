/**
 * lib/egress-guard.mjs
 *
 * PORTED from ronininc/kingmaker-os runtime/egress-guard.ts
 * Source of truth: kingmaker-os. Do not edit here.
 *
 * Outbound network is allowlisted. In tor-only mode, all clearnet is blocked.
 * Fail-closed: anything not explicitly allowed is refused.
 */

const ALLOWLIST = new Set([
  'api.github.com',
  'raw.githubusercontent.com',
  'huggingface.co',
  'cdn-lfs.huggingface.co',
  'pypi.org',
  'files.pythonhosted.org',
  'registry.npmjs.org',
]);

export function createEgressPolicy({ torOnly = false } = {}) {
  return { torOnly, allowlist: new Set(ALLOWLIST) };
}

/** Add a host to the allowlist for this policy instance. */
export function allowHost(policy, host) {
  policy.allowlist.add(host.toLowerCase());
}

/**
 * Check whether an outbound request to `url` is permitted.
 * Returns { ok: true } or { ok: false, reason }.
 */
export function checkEgress(policy, url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return { ok: false, reason: `egress-guard: malformed URL refused: ${url}` };
  }

  if (policy.torOnly) {
    const isOnion = host.endsWith('.onion');
    if (!isOnion) {
      return { ok: false, reason: `egress-guard: tor-only mode — clearnet host refused: ${host}` };
    }
    return { ok: true, via: 'tor' };
  }

  // Subdomain match: allow api.github.com and *.api.github.com style.
  for (const allowed of policy.allowlist) {
    if (host === allowed || host.endsWith('.' + allowed)) {
      return { ok: true, via: 'clearnet' };
    }
  }
  return { ok: false, reason: `egress-guard: host not allowlisted: ${host}` };
}
