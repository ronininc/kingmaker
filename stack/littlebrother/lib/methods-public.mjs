/**
 * lib/methods-public.mjs
 *
 * LittleBrother's public-source methods. These ship in BOTH builds —
 * Kingmaker and Solomon. Every method is read-only: it observes public
 * sources and reports back, and never acts on a target, never touches
 * anything behind authentication, never handles credentials.
 *
 * Transport is INJECTED: an async function `transport({ kind, target,
 * params })` supplied by the host. This module imports no network code —
 * there is no fetch, no http import, nothing to call out with. If no
 * transport is injected, network methods fail closed.
 *
 * Every successful call returns an evidence record:
 *   { ok: true, source, outlet, date, data, verified }
 * Unverifiable results are marked verified:false, never presented as fact.
 *
 * Clean-room: implemented from the boundary spec's method descriptions;
 * the GPL upstream was never read and its code is not here.
 */

export const METHOD_IDS = ['usernameLookup', 'ipLookup', 'domainLookup', 'webRecon', 'emailFormatCheck'];

export const DEFAULT_PLATFORMS = [
  'github',
  'gitlab',
  'x',
  'instagram',
  'tiktok',
  'reddit',
  'youtube',
];

// Minimal seed for local email-pattern checks. Minimal — production extends.
const DISPOSABLE_SEEDS = [
  'mailinator.com',
  'guerrillamail.com',
  '10minutemail.com',
  'tempmail.com',
];

function evidence(source, outlet, data, verified) {
  return {
    ok: true,
    source,
    outlet,
    date: new Date().toISOString(),
    data,
    verified: Boolean(verified),
  };
}

function refused(reason) {
  return { ok: false, refused: true, reason };
}

function requireTransport(transport) {
  if (typeof transport !== 'function') {
    return refused('no transport configured — fail-closed, no public lookup attempted');
  }
  return null;
}

/**
 * Public username lookup across platforms. Public profiles only — the
 * transport contract requires public endpoints; nothing here can run
 * behind a login, and the module has no auth to give it.
 */
export async function usernameLookup(username, { transport, platforms = DEFAULT_PLATFORMS } = {}) {
  if (!username || typeof username !== 'string' || username.trim() === '') {
    throw new Error('usernameLookup: a non-empty username string is required');
  }
  const fail = requireTransport(transport);
  if (fail) return fail;
  const clean = username.trim().slice(0, 120);
  let raw;
  try {
    raw = await transport({ kind: 'username', target: clean, params: { platforms } });
  } catch (err) {
    return { ok: false, reason: `transport failed (fail-closed): ${err.message}` };
  }
  const profiles = Array.isArray(raw?.profiles) ? raw.profiles : [];
  const data = {
    username: clean,
    platformsChecked: platforms,
    profiles: profiles.map((p) => ({
      platform: p.platform,
      url: p.url,
      exists: Boolean(p.exists),
      displayName: typeof p.displayName === 'string' ? p.displayName : null,
    })),
    hitCount: profiles.filter((p) => p.exists).length,
  };
  return evidence('littlebrother/usernameLookup', raw?.outlet ?? 'transport', data, profiles.length > 0);
}

/**
 * IP lookup: geolocation, ASN/org, reputation — public registry data only.
 */
export async function ipLookup(ip, { transport } = {}) {
  if (!ip || typeof ip !== 'string' || ip.trim() === '') {
    throw new Error('ipLookup: a non-empty IP string is required');
  }
  const fail = requireTransport(transport);
  if (fail) return fail;
  const clean = ip.trim().slice(0, 64);
  let raw;
  try {
    raw = await transport({ kind: 'ip', target: clean, params: {} });
  } catch (err) {
    return { ok: false, reason: `transport failed (fail-closed): ${err.message}` };
  }
  const data = {
    ip: clean,
    country: raw?.country ?? null,
    region: raw?.region ?? null,
    city: raw?.city ?? null,
    asn: raw?.asn ?? null,
    organization: raw?.organization ?? raw?.org ?? null,
    reputation: raw?.reputation ?? null,
  };
  const verified = Boolean(data.country || data.asn || data.organization);
  return evidence('littlebrother/ipLookup', raw?.outlet ?? 'transport', data, verified);
}

/**
 * Domain / WHOIS public data. Public registry records only.
 */
export async function domainLookup(domain, { transport } = {}) {
  if (!domain || typeof domain !== 'string' || domain.trim() === '') {
    throw new Error('domainLookup: a non-empty domain string is required');
  }
  const fail = requireTransport(transport);
  if (fail) return fail;
  const clean = domain.trim().toLowerCase().slice(0, 253);
  let raw;
  try {
    raw = await transport({ kind: 'domain', target: clean, params: {} });
  } catch (err) {
    return { ok: false, reason: `transport failed (fail-closed): ${err.message}` };
  }
  const data = {
    domain: clean,
    registrar: raw?.registrar ?? null,
    created: raw?.created ?? null,
    expires: raw?.expires ?? null,
    nameservers: Array.isArray(raw?.nameservers) ? raw.nameservers : [],
    status: raw?.status ?? null,
  };
  const verified = Boolean(data.registrar || data.created || data.nameservers.length > 0);
  return evidence('littlebrother/domainLookup', raw?.outlet ?? 'transport', data, verified);
}

const MAX_RECON_CHARS = 20000;

/**
 * Public web recon: what the target publishes about itself. Text only —
 * binary or non-text payloads are dropped, never stored.
 */
export async function webRecon(target, { transport } = {}) {
  if (!target || typeof target !== 'string' || target.trim() === '') {
    throw new Error('webRecon: a non-empty target string is required');
  }
  const fail = requireTransport(transport);
  if (fail) return fail;
  const clean = target.trim().slice(0, 2048);
  let raw;
  try {
    raw = await transport({ kind: 'web', target: clean, params: {} });
  } catch (err) {
    return { ok: false, reason: `transport failed (fail-closed): ${err.message}` };
  }
  const text = typeof raw === 'string' ? raw : typeof raw?.text === 'string' ? raw.text : '';
  const title = typeof raw?.title === 'string' ? raw.title : null;
  if (!text) {
    return evidence('littlebrother/webRecon', 'transport', { target: clean, title, text: '', truncated: false }, false);
  }
  const truncated = text.length > MAX_RECON_CHARS;
  const data = {
    target: clean,
    title,
    text: truncated ? text.slice(0, MAX_RECON_CHARS) : text,
    truncated,
    chars: text.length,
  };
  return evidence('littlebrother/webRecon', raw?.outlet ?? 'transport', data, true);
}

/**
 * Email FORMAT verification against public patterns. Local only — this
 * method never touches the network, never checks deliverability, never
 * touches credentials, and never initiates a password reset. That is the
 * whole point of it: shape, not substance.
 */
export async function emailFormatCheck(email) {
  if (!email || typeof email !== 'string' || email.trim() === '') {
    throw new Error('emailFormatCheck: a non-empty email string is required');
  }
  const clean = email.trim().toLowerCase().slice(0, 320);
  const syntaxValid = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(clean);
  const domain = syntaxValid ? clean.split('@')[1] : null;
  const disposable = domain ? DISPOSABLE_SEEDS.includes(domain) : null;
  const data = {
    email: clean,
    syntaxValid,
    domain,
    disposable,
    note: 'format only — no deliverability, credential, or password-reset check of any kind',
  };
  return evidence('littlebrother/emailFormatCheck', 'local-patterns', data, syntaxValid);
}
