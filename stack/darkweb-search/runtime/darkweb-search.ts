// Ronin / Solomon — Dark Web Search Runtime v1.1
//
// ⚠️  UNTESTED AGAINST A LIVE TOR NETWORK — USE WITH CAUTION  ⚠️
// The TypeScript compiles and the unit tests pass, but no actual .onion
// requests have been made through this code path. Do not run this against
// the live dark web until a controlled dry run succeeds with founder
// supervision.
//
// GOVERNANCE (HARD RULES):
// 1. Tor-only. No clearnet fallback. Fail closed.
// 2. Read-only. No posting, messaging, accounts, purchases, or downloads.
// 3. Text-only. No images, binaries, or executables.
// 4. CSAM auto-abort. No override. Not the tap, not the session, nothing.
// 5. Per-session founder tap with bounded scope. Queries outside scope blocked.
// 6. Phase 1 hardening must be active. If hardening regresses, this method
//    refuses to load.
//
// TIGHTENINGS BACK-PORTED 2026-10-21 from the v0.4.1 canonical copy
// (lib/darkweb-search.mjs), on the founder's direct orders, so the source
// of truth and the shipped copy stay in step:
//   (1) INSTANT TRIPWIRE — results are scanned as they STREAM, chunk by
//       chunk with a rolling carry window, before anything is assembled
//       or stored. The first matching chunk kills the transfer mid-flight
//       and the session with it. Queries are screened before any traffic.
//   (2) BOUNDED SANDBOX — a session cannot exist without a sandbox
//       binding (DarkWebSandboxBinding) issued by the governor/host
//       layer. ALL reads happen through the binding's transport, inside
//       the cell. This module never fetches on its own.
//   (3) DEVICE SEAL LIFECYCLE — begin: seal devices, THEN snapshot, then
//       the first query may run. End: the sandbox self-scan diffs against
//       the pre-dive snapshot. Clean → unseal. Findings (or a failed
//       scan) → devices STAY SEALED, the session is QUARANTINED, and
//       unseal requires the founder's acknowledgment of the findings on
//       a fresh tap (acknowledgeDarkwebFindings). A killed session still
//       owes its scan.

import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import {
  appendAuditRecord,
  type AuditChainV1,
} from './audit-chain';
import { checkEgressTorOnly } from './egress-guard';
import { ingestContent } from './ingestion-guard';
import type {
  CsamAbortRecord,
  DarkWebSandboxBinding,
  DarkWebScanFindings,
  DarkWebSearchResult,
  DarkWebSessionScope,
  DarkWebSessionV1,
} from '../contracts/darkweb-session';

export const DARKWEB_METHOD_ID = 'darkweb-search';

/** Tor SOCKS proxy. Standard ports: 9050 (tor daemon), 9150 (Tor Browser). */
const TOR_SOCKS_HOST = '127.0.0.1';
const TOR_SOCKS_PORT = 9050;

/** Minimal seed blocklist — production MUST add a comprehensive maintained
 *  blocklist plus hash database integration before live use. Matched
 *  against retrieved text AND queries (case-insensitive). */
const CSAM_KEYWORD_PATTERNS: RegExp[] = [
  /\bchild\s*porn/i,
  /\bcp\s*(video|pic|image)/i,
  /\blolita\b/i,
  /\bpreteen\b/i,
];

/** Rolling-window carry: long enough that a pattern split across a chunk
 *  boundary still matches whole. */
const CARRY_CHARS = 128;

/** Text-only enforcement: an unbroken base64 run this long is an encoded
 *  binary wearing a text costume, not prose (≈384 bytes of payload).
 *  Shorter runs — hashes, onion addresses, tokens — are ordinary text. */
const BINARY_BLOB = /[A-Za-z0-9+/]{512,}={0,2}/;

/** A read is bounded in size, not just time. */
const DEFAULT_MAX_STREAM_BYTES = 5 * 1024 * 1024;

export type DarkWebSessionState =
  | 'refused' // a gate stopped the session before it began
  | 'closed-clean' // dive ended, self-scan clean, devices unsealed
  | 'quarantined'; // self-scan findings (or failure) — devices STAY SEALED

export interface DarkWebSearchRequest {
  /** Search queries (bounded by session scope) */
  queries: string[];
  /** Pre-declared session scope */
  scope: DarkWebSessionScope;
  /** Founder tap reference for this session */
  tapReference: string;
  /** Whether Phase 1 hardening is verified active */
  hardeningVerified: boolean;
  /** Authority of the requester */
  requesterAuthority: 'NONE' | 'USER' | 'OPERATOR' | 'MANAGER' | 'ADMIN' | 'FOUNDER';
  /** The bounded sandbox binding (governor/host-issued). REQUIRED:
   *  no binding, no session — reads happen inside the sandbox, devices
   *  are sealed for the whole dive, and the self-scan is owed at the end. */
  sandbox: DarkWebSandboxBinding;
  /** Per-read byte bound (defaults to DEFAULT_MAX_STREAM_BYTES) */
  maxStreamBytes?: number;
}

export interface DarkWebSearchResponse {
  ok: boolean;
  sessionId: string;
  results: DarkWebSearchResult[];
  abortRecord: CsamAbortRecord | null;
  auditChain: AuditChainV1;
  reasonPlain: string;
  /** How the dive settled (see DarkWebSessionState). */
  sessionState: DarkWebSessionState;
  /** Self-scan findings when sessionState is 'quarantined' (labels only). */
  findings: DarkWebScanFindings | null;
}

/** A live (or quarantined) session's host-side handle. */
interface LiveSession {
  sessionId: string;
  sandbox: DarkWebSandboxBinding;
  snapshot: unknown;
  sealed: boolean;
  killed: boolean;
  state: 'active' | 'quarantined' | 'closed-clean' | 'closed-flagged';
  findings: DarkWebScanFindings | null;
}

const liveSessions = new Map<string, LiveSession>();

const BINDING_FUNCTIONS = ['transport', 'seal', 'unseal', 'snapshot', 'diffScan'] as const;

/** Throws unless the binding is complete — anything missing any part of
 *  the binding is not a binding and starts nothing. */
export function assertSandboxBinding(sandbox: unknown): asserts sandbox is DarkWebSandboxBinding {
  const s = sandbox as DarkWebSandboxBinding | null | undefined;
  if (
    !s || typeof s !== 'object'
    || typeof s.id !== 'string' || s.id.length === 0
    || BINDING_FUNCTIONS.some((f) => typeof s[f] !== 'function')
  ) {
    throw new Error('no bounded sandbox binding — session refused (reads happen in the sandbox, devices sealed, self-scan owed)');
  }
}

function generateSessionId(): string {
  return `dw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Check text against CSAM indicators. Returns the indicator type if
 * matched, null otherwise. The content itself is never logged.
 */
export function checkCsamIndicators(text: string): CsamAbortRecord['indicator'] | null {
  const lower = text.toLowerCase();
  for (const pattern of CSAM_KEYWORD_PATTERNS) {
    if (pattern.test(lower)) return 'KEYWORD_BLOCKLIST';
  }
  // HASH_DATABASE and CLASSIFIER_FLAG checks plug in here (production
  // must add both before live use).
  return null;
}

/**
 * Extract text from HTML. Strips tags, scripts, styles. Returns text only —
 * no images, no embedded content references.
 */
export function extractTextOnly(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 10000); // cap at 10KB per page
}

/**
 * The reference Tor transport, for a HOST to build a sandbox binding
 * from: streams a URL through the Tor SOCKS proxy via curl
 * (--socks5-hostname, so DNS resolves through Tor — no leak), yielding
 * decoded text chunks as they arrive. Ending iteration early (the
 * tripwire, a kill, a bound) kills the curl process mid-transfer.
 * This module never calls it itself: the binding is the host's act.
 */
export function createTorCurlTransport(): (url: string) => AsyncIterable<string> {
  return (url: string) => {
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      throw new Error(`Invalid URL: ${url}`);
    }
    const port = new URL(url).port ? parseInt(new URL(url).port) : 443;
    const egress = checkEgressTorOnly(host, port);
    if (!egress.allowed) throw new Error(`Egress blocked: ${egress.reasonPlain}`);

    const child = spawn('curl', [
      '--socks5-hostname', `${TOR_SOCKS_HOST}:${TOR_SOCKS_PORT}`,
      '--max-time', '30',
      '--silent',
      '--show-error',
      '--location',
      '--max-redirs', '3',
      '--header', 'Accept: text/html',
      url,
    ]);
    const decoder = new StringDecoder('utf8');
    const queue: string[] = [];
    let done = false;
    let failure: Error | null = null;
    let notify: (() => void) | null = null;
    const wake = () => { const n = notify; notify = null; n?.(); };
    child.stdout.on('data', (d: Buffer) => { queue.push(decoder.write(d)); wake(); });
    child.stderr.on('data', () => { /* curl diagnostics are not content */ });
    child.on('error', (err) => { failure = new Error(`Tor fetch failed: ${err.message}. Is the Tor daemon running on ${TOR_SOCKS_HOST}:${TOR_SOCKS_PORT}?`); done = true; wake(); });
    child.on('close', (code) => {
      if (code !== 0 && code !== null) failure = failure ?? new Error(`curl exited ${code}`);
      done = true; wake();
    });
    return {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            while (queue.length === 0 && !done) {
              await new Promise<void>((r) => { notify = r; });
            }
            if (queue.length > 0) return { value: queue.shift() as string, done: false };
            if (failure) throw failure;
            return { value: '', done: true };
          },
          async return() {
            child.kill(); // the teardown: ending iteration kills the transfer
            return { value: '', done: true as const };
          },
        };
      },
    };
  };
}

/**
 * Summarize extracted text for the audit chain and results.
 * Summaries only — full content is not stored beyond the session.
 */
function summarizeText(text: string, maxLen = 500): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > maxLen ? clean.slice(0, maxLen) + '…' : clean;
}

function refusal(
  sessionId: string,
  auditChain: AuditChainV1,
  reasonPlain: string,
): DarkWebSearchResponse {
  return { ok: false, sessionId, results: [], abortRecord: null, auditChain, reasonPlain, sessionState: 'refused', findings: null };
}

/**
 * Settle a dive: run the self-scan and resolve the seal.
 *   clean scan  → unseal, closed-clean.
 *   findings    → STAY SEALED, quarantined; unseal only via
 *                 acknowledgeDarkwebFindings on a fresh founder tap.
 *   scan error  → treated as findings. Nothing unseals on an error.
 */
async function settleSession(
  live: LiveSession,
  chain: AuditChainV1,
): Promise<{ chain: AuditChainV1; state: DarkWebSessionState; findings: DarkWebScanFindings | null }> {
  if (!live.sealed) {
    live.state = 'closed-clean';
    liveSessions.delete(live.sessionId);
    return { chain, state: 'closed-clean', findings: null };
  }
  let diff: { added: string[]; changed: string[]; removed: string[] } | null = null;
  let scanError: Error | null = null;
  try {
    diff = await live.sandbox.diffScan(live.snapshot);
  } catch (err) {
    scanError = err as Error;
  }
  const findings: DarkWebScanFindings = {
    added: diff?.added ?? [],
    changed: diff?.changed ?? [],
    removed: diff?.removed ?? [],
    ...(scanError ? { error: scanError.message } : {}),
  };
  if (!scanError && findings.added.length === 0 && findings.changed.length === 0) {
    try {
      await live.sandbox.unseal();
    } catch (err) {
      findings.error = `unseal failed: ${(err as Error).message}`;
      live.state = 'quarantined';
      live.findings = findings;
      const r = appendAuditRecord(chain, {
        eventType: 'DARKWEB_SELFSCAN_FINDINGS',
        source: DARKWEB_METHOD_ID,
        authority: 'FOUNDER',
        payload: { sessionId: live.sessionId, findings, unsealFailed: true },
        summaryPlain: `Session ${live.sessionId}: clean self-scan but UNSEAL FAILED — devices remain sealed, session quarantined`,
      });
      return { chain: r.chain, state: 'quarantined', findings };
    }
    live.sealed = false;
    live.state = 'closed-clean';
    liveSessions.delete(live.sessionId);
    const r = appendAuditRecord(chain, {
      eventType: 'DARKWEB_SELFSCAN_CLEAN',
      source: DARKWEB_METHOD_ID,
      authority: 'FOUNDER',
      payload: { sessionId: live.sessionId, removed: findings.removed.length },
      summaryPlain: `Session ${live.sessionId}: self-scan clean — devices unsealed`,
    });
    return { chain: r.chain, state: 'closed-clean', findings: null };
  }
  live.state = 'quarantined';
  live.findings = findings;
  const r = appendAuditRecord(chain, {
    eventType: 'DARKWEB_SELFSCAN_FINDINGS',
    source: DARKWEB_METHOD_ID,
    authority: 'FOUNDER',
    payload: { sessionId: live.sessionId, findings },
    summaryPlain:
      `Session ${live.sessionId}: self-scan FINDINGS (added ${findings.added.length}, changed ${findings.changed.length}` +
      `${scanError ? `, scan error: ${scanError.message}` : ''}) — devices REMAIN SEALED pending founder acknowledgment`,
  });
  return { chain: r.chain, state: 'quarantined', findings };
}

export async function darkwebSearch(
  request: DarkWebSearchRequest,
  auditChain: AuditChainV1,
): Promise<DarkWebSearchResponse> {
  const sessionId = generateSessionId();

  // GATE 0 (tightening 2): a bounded sandbox binding is required. No
  // binding, no session, no exceptions.
  try {
    assertSandboxBinding(request.sandbox);
  } catch (err) {
    return refusal(sessionId, auditChain,
      `Dark web search refused: ${(err as Error).message}. The governor/host layer issues the binding; this method never reads on its own.`);
  }

  // GATE 1: Phase 1 hardening must be verified active.
  if (!request.hardeningVerified) {
    return refusal(sessionId, auditChain,
      'Phase 1 hardening is not verified. The dark web search method ' +
      'refuses to load without hardening in place. This is fail-closed by design.');
  }

  // GATE 2: Founder tap required for the session.
  if (request.requesterAuthority !== 'FOUNDER' || !request.tapReference) {
    const r = appendAuditRecord(auditChain, {
      eventType: 'TAP_DENIED',
      source: DARKWEB_METHOD_ID,
      authority: request.requesterAuthority,
      payload: { sessionId },
      summaryPlain: `Dark web session ${sessionId} denied: missing founder tap`,
    });
    return { ...refusal(sessionId, r.chain, 'Dark web search requires a founder tap for the session. No tap, no search.') };
  }

  // GATE 3: Scope bounds.
  if (request.queries.length === 0 || request.queries.length > request.scope.maxQueries) {
    return refusal(sessionId, auditChain,
      `Query count ${request.queries.length} outside session scope ` +
      `(max ${request.scope.maxQueries}). Declare scope in the tap request.`);
  }

  // Open session in audit chain
  let chain = auditChain;
  {
    const r = appendAuditRecord(chain, {
      eventType: 'DARKWEB_SESSION_START',
      source: DARKWEB_METHOD_ID,
      authority: 'FOUNDER',
      payload: { sessionId, scope: request.scope, tapReference: request.tapReference, sandbox: request.sandbox.id },
      summaryPlain: `Dark web session ${sessionId} opened in sandbox ${request.sandbox.id}: ${request.queries.length} queries, scope: ${request.scope.topics.join(', ')}`,
    });
    chain = r.chain;
  }

  const live: LiveSession = {
    sessionId, sandbox: request.sandbox, snapshot: null,
    sealed: false, killed: false, state: 'active', findings: null,
  };
  liveSessions.set(sessionId, live);

  // BEGIN (tightening 3): seal FIRST, snapshot SECOND, queries LAST.
  // Fail-closed at each step; a failed snapshot after a good seal unseals
  // and refuses — no dive without a baseline to diff against.
  try {
    const seal = await live.sandbox.seal();
    if (!seal || seal.mic !== true || seal.camera !== true) {
      liveSessions.delete(sessionId);
      return refusal(sessionId, chain, 'Device seal not attested (mic AND camera must report disabled) — dive refused.');
    }
    live.sealed = true;
    const r = appendAuditRecord(chain, {
      eventType: 'DARKWEB_DEVICES_SEALED',
      source: DARKWEB_METHOD_ID,
      authority: 'FOUNDER',
      payload: { sessionId, sandbox: request.sandbox.id },
      summaryPlain: `Session ${sessionId}: mic + camera sealed at the device level`,
    });
    chain = r.chain;
  } catch (err) {
    liveSessions.delete(sessionId);
    return refusal(sessionId, chain, `Device seal failed (fail-closed, dive refused): ${(err as Error).message}`);
  }
  try {
    live.snapshot = await live.sandbox.snapshot();
  } catch (err) {
    try { await live.sandbox.unseal(); live.sealed = false; } catch { /* stay sealed; the refusal stands */ }
    liveSessions.delete(sessionId);
    return refusal(sessionId, chain, `Pre-dive snapshot failed (fail-closed, dive refused): ${(err as Error).message}`);
  }

  const maxStreamBytes = request.maxStreamBytes ?? DEFAULT_MAX_STREAM_BYTES;
  const results: DarkWebSearchResult[] = [];
  const sessionStart = Date.now();
  const sessionTimeoutMs = request.scope.maxMinutes * 60 * 1000;
  let abortRecord: CsamAbortRecord | null = null;

  for (const query of request.queries) {
    if (Date.now() - sessionStart > sessionTimeoutMs || live.killed) {
      const r = appendAuditRecord(chain, {
        eventType: 'DARKWEB_SESSION_END',
        source: DARKWEB_METHOD_ID,
        authority: 'FOUNDER',
        payload: { sessionId, reason: live.killed ? 'killed' : 'time_bound_exceeded' },
        summaryPlain: `Session ${sessionId} ended: ${live.killed ? 'kill switch' : 'time bound exceeded'}`,
      });
      chain = r.chain;
      break;
    }

    // CSAM CHECK on the QUERY first (tightening 1) — a tripping query
    // never reaches the network at all.
    if (checkCsamIndicators(query)) {
      abortRecord = { sessionId, abortedAt: new Date().toISOString(), triggeringQuery: query, indicator: 'KEYWORD_BLOCKLIST' };
      const r = appendAuditRecord(chain, {
        eventType: 'DARKWEB_ABORT',
        source: DARKWEB_METHOD_ID,
        authority: 'FOUNDER',
        payload: { sessionId, triggeringQuery: query, indicator: 'KEYWORD_BLOCKLIST', where: 'query' },
        summaryPlain: `CSAM ABORT: session ${sessionId} terminated on its own query (indicator: KEYWORD_BLOCKLIST). Content not retained.`,
      });
      chain = r.chain;
      break;
    }

    // For this v1, queries go to Ahmia (Tor search engine) via its onion address.
    const searchUrl = `http://juhanurmihxlp77nkq76byazcldy2hlmovfu2epvl5ankdibsot4csyd.onion/search/?q=${encodeURIComponent(query)}`;

    // THE READ — through the sandbox binding's transport only, streamed,
    // scanned chunk by chunk (tightening 1) with a rolling carry window.
    let assembled = '';
    let carry = '';
    let streamFailure: string | null = null;
    try {
      const raw = await live.sandbox.transport(searchUrl);
      const chunks: AsyncIterable<string> | Iterable<string> =
        typeof raw === 'string' ? [raw] : raw;
      for await (const chunk of chunks) {
        if (live.killed) { streamFailure = 'session killed mid-stream'; break; }
        if (typeof chunk !== 'string') { streamFailure = 'non-text chunk refused — stream torn down (the dark web read is text only)'; break; }
        if (BINARY_BLOB.test(carry + chunk)) { streamFailure = 'encoded binary payload refused — stream torn down (the dark web read is text only)'; break; }
        if (assembled.length + chunk.length > maxStreamBytes) { streamFailure = `stream exceeded the sandbox read bound (${maxStreamBytes} bytes) — torn down`; break; }
        // Scan first, assemble second. The window is carry + chunk so a
        // boundary-split pattern still matches whole. A match returns out
        // of the loop, which tears the transport's stream down NOW —
        // mid-transfer, not after it.
        const window = carry + chunk;
        const hit = checkCsamIndicators(window);
        if (hit) {
          abortRecord = { sessionId, abortedAt: new Date().toISOString(), triggeringQuery: query, indicator: hit };
          const r = appendAuditRecord(chain, {
            eventType: 'DARKWEB_ABORT',
            source: DARKWEB_METHOD_ID,
            authority: 'FOUNDER',
            payload: { sessionId, triggeringQuery: query, indicator: hit, where: 'result-stream' },
            summaryPlain: `CSAM ABORT: session ${sessionId} terminated mid-stream on query "${query.slice(0, 50)}" (indicator: ${hit}). Content not retained.`,
          });
          chain = r.chain;
          break;
        }
        assembled += chunk;
        carry = window.slice(-CARRY_CHARS);
      }
    } catch (err) {
      streamFailure = `sandbox transport failed (fail-closed, no clearnet fallback): ${(err as Error).message}`;
    }

    if (abortRecord) break;
    if (streamFailure) {
      const r = appendAuditRecord(chain, {
        eventType: 'DARKWEB_QUERY',
        source: DARKWEB_METHOD_ID,
        authority: 'FOUNDER',
        payload: { sessionId, query, error: streamFailure },
        summaryPlain: `Query failed: "${query.slice(0, 50)}" — ${streamFailure.slice(0, 120)}`,
      });
      chain = r.chain;
      continue;
    }

    const text = extractTextOnly(assembled);

    // Ingest through the boundary: tag as UNTRUSTED, sanitize, scan.
    const ingested = ingestContent({
      content: text,
      source: searchUrl,
      claimedTrustLevel: 'UNTRUSTED',
    });

    if (ingested.sanitized.injection.detected) {
      const r = appendAuditRecord(chain, {
        eventType: 'INJECTION_DETECTED',
        source: DARKWEB_METHOD_ID,
        authority: 'FOUNDER',
        payload: { sessionId, patterns: ingested.sanitized.injection.patterns },
        summaryPlain: `Injection patterns in dark web result: ${ingested.sanitized.injection.patterns.join(', ')}`,
      });
      chain = r.chain;
    }

    const resultEntries = ingested.sanitized.text
      .split('\n')
      .filter((line) => line.trim().length > 20)
      .slice(0, request.scope.maxResultsPerQuery);

    for (const entry of resultEntries) {
      results.push({
        sourceUrl: searchUrl,
        summaryPlain: summarizeText(entry),
        retrievedAt: new Date().toISOString(),
      });
    }

    const r = appendAuditRecord(chain, {
      eventType: 'DARKWEB_QUERY',
      source: DARKWEB_METHOD_ID,
      authority: 'FOUNDER',
      payload: { sessionId, query, resultCount: resultEntries.length },
      summaryPlain: `Query "${query.slice(0, 50)}": ${resultEntries.length} results`,
    });
    chain = r.chain;
  }

  // END (tightening 3): the self-scan is owed on EVERY exit path —
  // completion, abort, and kill alike. Kill stops the reading; it does
  // not skip the scan.
  const settled = await settleSession(live, chain);
  chain = settled.chain;
  {
    const r = appendAuditRecord(chain, {
      eventType: 'DARKWEB_SESSION_END',
      source: DARKWEB_METHOD_ID,
      authority: 'FOUNDER',
      payload: { sessionId, totalResults: results.length, sessionState: settled.state, aborted: abortRecord !== null },
      summaryPlain: abortRecord
        ? `Session ${sessionId} aborted (CSAM). Self-scan: ${settled.state}.`
        : `Session ${sessionId} completed: ${results.length} results. Self-scan: ${settled.state}.`,
    });
    chain = r.chain;
  }

  if (abortRecord) {
    return {
      ok: false, sessionId, results, abortRecord, auditChain: chain,
      reasonPlain:
        `Session aborted: CSAM indicators detected on query "${abortRecord.triggeringQuery.slice(0, 50)}". ` +
        `Content was not stored, displayed, or forwarded. This abort cannot be overridden. ` +
        (settled.state === 'quarantined' ? 'The post-dive self-scan found changes: devices REMAIN SEALED pending founder acknowledgment.' : 'Devices unsealed after a clean self-scan.'),
      sessionState: settled.state, findings: settled.findings,
    };
  }
  return {
    ok: settled.state !== 'quarantined',
    sessionId, results, abortRecord: null, auditChain: chain,
    reasonPlain: settled.state === 'quarantined'
      ? `Session ${sessionId} completed with ${results.length} results, but the post-dive self-scan found changes — devices REMAIN SEALED and the session is quarantined until the founder acknowledges the findings.`
      : `Session ${sessionId} completed: ${results.length} results across ${request.queries.length} queries. Self-scan clean; devices unsealed.`,
    sessionState: settled.state, findings: settled.findings,
  };
}

/**
 * The ONLY way out of quarantine: the founder sees the findings and taps.
 * Unseals the devices and closes the session FLAGGED in the audit chain.
 */
export async function acknowledgeDarkwebFindings(
  input: { sessionId: string; tapReference: string; requesterAuthority: DarkWebSearchRequest['requesterAuthority'] },
  auditChain: AuditChainV1,
): Promise<{ ok: boolean; auditChain: AuditChainV1; reasonPlain: string }> {
  const live = liveSessions.get(input.sessionId);
  if (!live || live.state !== 'quarantined') {
    return { ok: false, auditChain, reasonPlain: `Session ${input.sessionId} is not quarantined — nothing to acknowledge.` };
  }
  if (input.requesterAuthority !== 'FOUNDER' || !input.tapReference) {
    return { ok: false, auditChain, reasonPlain: 'Findings acknowledgment requires the founder tap — the seal holds.' };
  }
  try {
    await live.sandbox.unseal();
  } catch (err) {
    return { ok: false, auditChain, reasonPlain: `Unseal failed: ${(err as Error).message} — the seal holds.` };
  }
  live.sealed = false;
  live.state = 'closed-flagged';
  liveSessions.delete(input.sessionId);
  const r = appendAuditRecord(auditChain, {
    eventType: 'DARKWEB_FINDINGS_ACKNOWLEDGED',
    source: DARKWEB_METHOD_ID,
    authority: 'FOUNDER',
    payload: { sessionId: input.sessionId, tapReference: input.tapReference, findings: live.findings },
    summaryPlain: `Session ${input.sessionId}: findings acknowledged on founder tap — devices unsealed, session closed FLAGGED`,
  });
  return { ok: true, auditChain: r.chain, reasonPlain: `Session ${input.sessionId} closed flagged; devices unsealed on the founder's acknowledgment.` };
}

/**
 * Kill switch: immediately terminate a session. Marks the live session
 * killed — an in-flight stream tears down at the next chunk. Devices
 * stay sealed and the self-scan is still owed: the search settles the
 * session through settleSession on its way out.
 */
export function killDarkWebSession(
  session: { sessionId: string },
  auditChain: AuditChainV1,
  reason: string,
): { auditChain: AuditChainV1 } {
  const live = liveSessions.get(session.sessionId);
  if (live) live.killed = true;
  const r = appendAuditRecord(auditChain, {
    eventType: 'KILL_SWITCH',
    source: DARKWEB_METHOD_ID,
    authority: 'FOUNDER',
    payload: { sessionId: session.sessionId, reason },
    summaryPlain: `KILL SWITCH: session ${session.sessionId} terminated. Reason: ${reason}`,
  });
  return { auditChain: r.chain };
}

/** Session record helper (unchanged shape from the v1 contract). */
export type { DarkWebSessionV1 };
