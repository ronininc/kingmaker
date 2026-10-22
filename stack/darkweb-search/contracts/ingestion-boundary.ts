// Ronin / Solomon — Ingestion Boundary Schema v1
// Every piece of content entering Kingmaker is tagged with a trust level at
// the boundary. Untrusted content enters the DATA channel only — it can
// inform decisions, never direct them. The instruction hierarchy is enforced
// in code, not by convention.

/** Where content came from. Lower = less trusted. */
export type TrustLevel =
  | 'SYSTEM' // Kingmaker's own code and constants
  | 'FOUNDER' // Robbie's direct input (chat, tap, config he wrote)
  | 'KINGMAKER' // Kingmaker's own prior outputs (audit-verified)
  | 'AGENT' // Other agents' reports (Claude, Codex, etc.)
  | 'UNTRUSTED'; // Everything else: web, files, tool outputs, user uploads

/** Numeric rank for hierarchy comparison. Higher = more authority. */
export function trustRank(level: TrustLevel): number {
  switch (level) {
    case 'SYSTEM': return 5;
    case 'FOUNDER': return 4;
    case 'KINGMAKER': return 3;
    case 'AGENT': return 2;
    case 'UNTRUSTED': return 1;
  }
}

export interface TaggedContent {
  /** The content itself */
  content: string;
  /** Trust level assigned at the ingestion boundary */
  trustLevel: TrustLevel;
  /** Where it came from (URL, file path, tool name, etc.) */
  source: string;
  /** ISO timestamp of ingestion */
  ingestedAt: string;
  /** SHA256 of the raw content (for audit) */
  contentHash: string;
}

/** Known prompt injection patterns. Detection flags; it does not auto-block
 *  the content (the content may still be useful as data). The FLAG goes in
 *  the audit chain; the content stays in the data channel. */
export type InjectionPattern =
  | 'INSTRUCTION_OVERRIDE' // "ignore previous instructions", "disregard above"
  | 'AUTHORITY_IMPERSONATION' // "as the founder...", "Robbie says...", fake system tags
  | 'CONTEXT_ESCAPE' // attempts to break out of data delimiters
  | 'TOOL_COERCION' // "you must call...", "execute immediately", fake tool outputs
  | 'PAYLOAD_SMUGGLING'; // encoded/obfuscated instructions (base64, zero-width, etc.)

export interface InjectionDetection {
  detected: boolean;
  patterns: InjectionPattern[];
  /** Character offsets of each detected pattern (for audit, not for display) */
  offsets: Array<{ pattern: InjectionPattern; start: number; end: number }>;
}

export interface SanitizedContent {
  /** The sanitized text, safe for the data channel */
  text: string;
  /** What was removed or normalized */
  sanitizationNotes: string[];
  /** Injection scan result */
  injection: InjectionDetection;
  /** Original content hash (pre-sanitization, for audit) */
  originalHash: string;
}
