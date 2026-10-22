// Ronin / Solomon — Ingestion Guard Runtime v1
// Every external input passes through here before reaching decision logic.
// Tags trust level, sanitizes, scans for injection patterns. Untrusted
// content goes to the DATA channel only — it can inform, never direct.

import { createHash } from 'node:crypto';
import {
  trustRank,
  type InjectionDetection,
  type InjectionPattern,
  type SanitizedContent,
  type TaggedContent,
  type TrustLevel,
} from '../contracts/ingestion-boundary';

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Patterns that indicate prompt injection attempts. */
const INJECTION_PATTERNS: Array<{ pattern: InjectionPattern; regex: RegExp }> = [
  {
    pattern: 'INSTRUCTION_OVERRIDE',
    regex: /\b(ignore|disregard|forget|override)\s+(all\s+)?(previous|prior|above)\s+(instructions?|directives?|rules?|prompts?)/gi,
  },
  {
    pattern: 'INSTRUCTION_OVERRIDE',
    regex: /\b(new|updated)\s+(instructions?|directives?)\s*:/gi,
  },
  {
    pattern: 'AUTHORITY_IMPERSONATION',
    regex: /\b(as|i am|i'm)\s+(the\s+)?(founder|robbie|system|administrator|admin)\b/gi,
  },
  {
    pattern: 'AUTHORITY_IMPERSONATION',
    regex: /\[system\]|\[SYSTEM\]|<system>|<\|system\|>/g,
  },
  {
    pattern: 'CONTEXT_ESCAPE',
    regex: /```\s*(system|instruction|override)/gi,
  },
  {
    pattern: 'TOOL_COERCION',
    regex: /\b(you\s+must|you\s+will|execute\s+immediately|run\s+this\s+now|call\s+\w+\s+now)\b/gi,
  },
  {
    pattern: 'PAYLOAD_SMUGGLING',
    // Zero-width characters often used to hide instructions
    // eslint-disable-next-line no-control-regex
    regex: /[\u200b-\u200f\u2060\ufeff]{3,}/g,
  },
];

export function scanForInjection(content: string): InjectionDetection {
  const patterns: InjectionPattern[] = [];
  const offsets: InjectionDetection['offsets'] = [];

  for (const { pattern, regex } of INJECTION_PATTERNS) {
    // Reset regex state for global patterns
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      if (!patterns.includes(pattern)) patterns.push(pattern);
      offsets.push({ pattern, start: match.index, end: match.index + match[0].length });
      // Prevent infinite loop on zero-width matches
      if (match[0].length === 0) regex.lastIndex++;
    }
  }

  return { detected: patterns.length > 0, patterns, offsets };
}

export function sanitizeContent(content: string): { text: string; notes: string[] } {
  const notes: string[] = [];
  let text = content;

  // Normalize encoding: strip BOM
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
    notes.push('stripped BOM');
  }

  // Remove control characters except newline, tab, carriage return
  // eslint-disable-next-line no-control-regex
  const before = text.length;
  text = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  if (text.length !== before) notes.push(`removed ${before - text.length} control characters`);

  // Remove zero-width characters (common smuggling vector)
  // eslint-disable-next-line no-control-regex
  const beforeZw = text.length;
  text = text.replace(/[\u200b-\u200f\u2060\ufeff]/g, '');
  if (text.length !== beforeZw) notes.push('removed zero-width characters');

  // Truncate oversized inputs (1MB limit for a single ingestion)
  const MAX_LEN = 1024 * 1024;
  if (text.length > MAX_LEN) {
    text = text.slice(0, MAX_LEN);
    notes.push(`truncated from ${content.length} to ${MAX_LEN} chars`);
  }

  return { text, notes };
}

export interface IngestInput {
  content: string;
  source: string;
  /** Who claims this content is from. Defaults to UNTRUSTED. */
  claimedTrustLevel?: TrustLevel;
}

/**
 * Ingest external content through the boundary. Returns tagged + sanitized
 * content for the DATA channel, plus injection scan results for the audit chain.
 *
 * CRITICAL: claimedTrustLevel is capped. Nothing ingested through this
 * function can claim SYSTEM or FOUNDER trust — those levels are assigned
 * only by Kingmaker's own code paths, never by ingested content.
 */
export function ingestContent(input: IngestInput): {
  tagged: TaggedContent;
  sanitized: SanitizedContent;
} {
  const ingestedAt = new Date().toISOString();
  const originalHash = sha256Hex(input.content);

  // Trust cap: ingested content can never claim SYSTEM or FOUNDER.
  // The highest it can claim is AGENT (and even that requires the source
  // to be a known agent channel — enforced by the caller, not here).
  let trustLevel: TrustLevel = 'UNTRUSTED';
  if (input.claimedTrustLevel) {
    const claimedRank = trustRank(input.claimedTrustLevel);
    // Cap at AGENT (rank 2). SYSTEM(5) and FOUNDER(4) are unreachable.
    trustLevel = claimedRank <= 2 ? input.claimedTrustLevel : 'UNTRUSTED';
  }

  const { text, notes } = sanitizeContent(input.content);
  const injection = scanForInjection(text);

  return {
    tagged: {
      content: input.content,
      trustLevel,
      source: input.source,
      ingestedAt,
      contentHash: originalHash,
    },
    sanitized: {
      text,
      sanitizationNotes: notes,
      injection,
      originalHash,
    },
  };
}

/**
 * Enforce instruction hierarchy: content at a lower trust level cannot
 * override directives from a higher level. Returns true if the content
 * is ALLOWED to influence a decision at the given authority level.
 */
export function mayInfluence(
  contentTrust: TrustLevel,
  decisionAuthority: TrustLevel,
): boolean {
  // Content can only influence decisions at its own level or below.
  // UNTRUSTED content can never influence FOUNDER or SYSTEM decisions.
  return trustRank(contentTrust) >= trustRank(decisionAuthority);
}
