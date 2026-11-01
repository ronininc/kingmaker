/**
 * lib/ingestion-guard.mjs
 *
 * PORTED from ronininc/kingmaker-os runtime/ingestion-guard.ts
 * Source of truth: kingmaker-os. Do not edit here.
 *
 * All input is tagged UNTRUSTED at the boundary. Sanitized. Scanned for
 * injection patterns. Ingested content CANNOT claim FOUNDER or SYSTEM trust —
 * that cap is enforced in code, not policy.
 */

export const TRUST = {
  UNTRUSTED: 'untrusted',
  FOUNDER: 'founder',
  SYSTEM: 'system',
};

// Five injection pattern classes scanned at the boundary.
const INJECTION_PATTERNS = [
  {
    name: 'trust-escalation',
    re: /\b(i am|i'm)\s+(the\s+)?(founder|system|admin|root)\b/i,
    desc: 'claims founder/system identity',
  },
  {
    name: 'instruction-override',
    re: /\b(ignore|disregard|override|bypass)\s+(previous|prior|all|your|the)\s+(instructions|rules|prompts|directives|guidance)\b/i,
    desc: 'attempts to override instructions',
  },
  {
    name: 'prompt-extraction',
    re: /\b(reveal|show|print|output|dump)\s+(your\s+)?(system prompt|instructions|prompt|configuration|config)\b/i,
    desc: 'attempts to extract system prompt',
  },
  {
    name: 'role-reassignment',
    re: /\byou\s+are\s+now\s+(a\s+)?(?!helpful)/i,
    desc: 'attempts to reassign role',
  },
  {
    name: 'delimiter-escape',
    re: /(\[END|\[BEGIN|```system|###\s*system)/i,
    desc: 'attempts to break out of content delimiters',
  },
];

/**
 * Ingest external content. Returns { trust: 'untrusted', clean, flags }.
 * Flags list every detected pattern. Clean is the sanitized text.
 * Trust is ALWAYS untrusted — callers cannot upgrade it.
 */
export function ingest(content, { source = 'unknown' } = {}) {
  if (typeof content !== 'string') {
    throw new Error('ingestion-guard: content must be a string');
  }
  const flags = [];
  for (const p of INJECTION_PATTERNS) {
    if (p.re.test(content)) {
      flags.push({ pattern: p.name, desc: p.desc });
    }
  }
  // Sanitize: strip null bytes and control chars (keep newline/tab).
  // eslint-disable-next-line no-control-regex
  const clean = content.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  return {
    trust: TRUST.UNTRUSTED,
    source,
    clean,
    flags,
    flagged: flags.length > 0,
  };
}

/**
 * Assert founder trust. Only the tap gate can produce FOUNDER trust —
 * never the ingestion path. This function exists so the boundary is explicit:
 * ingestion returns UNTRUSTED, and nothing in this module upgrades it.
 */
export function assertFounderTrust() {
  throw new Error(
    'ingestion-guard: FOUNDER trust cannot be asserted from ingested content. ' +
      'Founder trust comes only from the tap gate.'
  );
}
