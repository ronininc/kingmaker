// Ronin / Solomon — Dark Web Session Schema v1
// Governed dark/deep web search sessions. Tor-only, read-only, text-only.
// Every session requires a founder tap with bounded scope. CSAM auto-abort
// is a hard rule with no override path.

export type DarkWebSessionStatus =
  | 'PENDING_TAP' // created, awaiting founder tap
  | 'ACTIVE' // tap granted, session running
  | 'COMPLETED' // session finished normally
  | 'ABORTED' // aborted (CSAM indicators, scope violation, or kill switch)
  | 'KILLED' // terminated by kill switch
  | 'QUARANTINED'; // dive over, post-dive self-scan found changes — devices STAY SEALED until the founder acknowledges the findings on a fresh tap (added 2026-10-21, sandbox tightening back-port)

/**
 * A bounded sandbox binding, issued by the governor/host layer (the SPACE
 * cell governor for the read, the host agent for the device seal). A dark
 * web session cannot exist without one — no binding, no session.
 * Added 2026-10-21 with the sandbox tightening back-port.
 */
export interface DarkWebSandboxBinding {
  id: string;
  /** Performs the fetch INSIDE the bounded cell (Tor-only egress, no host
   *  filesystem) and returns the body as text or an async stream of text
   *  chunks. Breaking iteration MUST tear the underlying request down. */
  transport: (url: string) => Promise<string | AsyncIterable<string>>;
  /** Disable mic + camera at the device level; resolves to an attestation
   *  (true = disabled). */
  seal: () => Promise<{ mic: boolean; camera: boolean }>;
  /** Restore mic + camera. Called only on a clean self-scan or on the
   *  founder's acknowledgment of findings — never on an error path. */
  unseal: () => Promise<unknown>;
  /** Capture the pre-dive sandbox state; resolves to an opaque token. */
  snapshot: () => Promise<unknown>;
  /** Diff the sandbox against the pre-dive token. */
  diffScan: (before: unknown) => Promise<{ added: string[]; changed: string[]; removed: string[] }>;
}

/** What the post-dive self-scan found (paths/labels only, never content). */
export interface DarkWebScanFindings {
  added: string[];
  changed: string[];
  removed: string[];
  /** Set when the scan itself failed — a failed scan is treated as findings. */
  error?: string;
}

export interface DarkWebSessionScope {
  /** Declared upfront in the tap request. Queries outside this are blocked. */
  topics: string[];
  /** Max queries per session */
  maxQueries: number;
  /** Max results per query */
  maxResultsPerQuery: number;
  /** Session time bound in minutes */
  maxMinutes: number;
}

export interface DarkWebSessionV1 {
  sessionId: string;
  status: DarkWebSessionStatus;
  scope: DarkWebSessionScope;
  /** Founder tap reference authorizing this session */
  tapReference: string;
  /** ISO timestamp of session start (when tap granted) */
  startedAt: string | null;
  /** ISO timestamp of session end */
  endedAt: string | null;
  /** Queries issued this session */
  queriesIssued: number;
  /** Tor circuit ID (for audit, not for reuse across sessions) */
  torCircuitId: string | null;
  /** Abort reason (only when status is ABORTED) */
  abortReason: string | null;
}

export interface DarkWebSearchResult {
  /** Onion URL of the source */
  sourceUrl: string;
  /** Text summary (never raw HTML) */
  summaryPlain: string;
  /** When it was retrieved */
  retrievedAt: string;
}

/** CSAM indicator categories. Any match triggers immediate abort. */
export type CsamIndicator =
  | 'KEYWORD_BLOCKLIST' // matched known CSAM keyword patterns
  | 'HASH_DATABASE' // content hash matched known CSAM database
  | 'CLASSIFIER_FLAG'; // ML classifier flagged the content

export interface CsamAbortRecord {
  sessionId: string;
  abortedAt: string;
  /** Which query triggered the abort */
  triggeringQuery: string;
  /** What kind of indicator (NOT the content itself) */
  indicator: CsamIndicator;
  // NOTE: the offending content is NEVER stored, logged, or forwarded.
  // Only the fact of the abort and its trigger are recorded.
}
