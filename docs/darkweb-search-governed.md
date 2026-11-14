# Build Order: Kingmaker Hardening + Governed Dark/Deep Web Search

## Objective
Two phases, strict order. Phase 1 hardens Kingmaker against outside influence.
Phase 2 adds dark/deep web search — ONLY after Phase 1 passes its acceptance
gates. The dark web is a legitimate OSINT resource (threat intel, breach data,
market monitoring), but the implementation bar is maximal: "as perfect as
humanly possible."

---

## PHASE 1: Harden Kingmaker Against Outside Influence

### Threat model
Kingmaker ingests untrusted content constantly: web pages, API responses,
file contents, agent reports, user messages. Every ingestion point is an
influence vector. Hardening means: untrusted content can inform, never direct.

### Requirements

1. **Prompt injection resistance**
   - All ingested content (web, files, tool outputs, agent reports) is tagged
     as UNTRUSTED at the boundary. Untrusted content never enters the instruction
     channel — it enters the data channel only.
   - Instruction hierarchy enforced in code: system > founder > Kingmaker >
     agent > ingested content. A lower level cannot override a higher one.
   - Known injection patterns (instruction override, authority impersonation,
     context escape, tool-use coercion) are detected and logged. Detection
     does not mean blocking the content — it means flagging the attempt in
     the audit chain and stripping the directive.

2. **Input sanitization**
   - Every external input passes through a sanitization layer before reaching
     any decision logic: encoding normalization, control character stripping,
     oversized input truncation with logged warning.
   - Structured inputs (JSON, XML) are schema-validated. Schema violations
     are rejected, not coerced.

3. **Output validation**
   - Kingmaker's outputs (commands, method calls, file writes) are validated
     against the capability manifest before execution. An output that exceeds
     the method's declared authority is blocked and logged.
   - No output path bypasses the audit chain. Every action writes an audit
     record before execution, not after.

4. **No exfiltration guarantees**
   - Network egress is allowlisted by destination. Any connection attempt to
     a non-allowlisted host is blocked and logged.
   - Secrets (credentials, keys, tokens) are never present in the inference
     context. They are referenced by handle and resolved at execution time
     by the vault layer only.
   - Clipboard, file-share, and pastebin outputs require explicit founder tap.

5. **Sandboxed execution**
   - Untrusted code (fetched scripts, agent-generated code) executes in a
     sandbox with no network, no filesystem write outside its scratch dir,
     and a wall-clock timeout. Sandbox escape attempts are logged as
     security events.

6. **Audit completeness**
   - Every ingestion, decision, and action writes to the append-only audit
     chain. The audit record includes: timestamp, source, content hash,
     authority level, and the decision taken.
   - Audit chain is tamper-evident (hash-chained). Any gap or modification
     is detectable.

### Phase 1 acceptance (ALL must pass before Phase 2 begins)
1. Red-team prompt injection suite: 50+ known injection patterns tested
   against every ingestion path. Zero directive escapes.
2. Egress test: attempt connections to non-allowlisted hosts from every
   execution context. All blocked and logged.
3. Secret leak test: place canary credentials in vault, run full workload,
   verify zero canary appearances in logs, outputs, or network captures.
4. Audit completeness test: run a full session, verify every action has a
   matching audit record with no gaps.
5. Sandbox escape test: run hostile payloads in the sandbox. Zero escapes.

---

## PHASE 2: Governed Dark/Deep Web Search

### What it is
A Kingmaker method `darkweb-search` that queries Tor onion services and
Tor-accessible search engines for OSINT purposes: threat intelligence,
breach monitoring, market research, investigator queries. Read-only.
Text-only. Fully governed.

### Why it matters
The dark/deep web holds breach dumps, threat actor chatter, stolen credential
markets, and investigator resources that don't exist on the clearnet. For
Robbie's threat intel, buyer verification, and red-team recon, it's a
high-value source — when accessed safely.

### Architecture

**Transport: Tor-only, enforced**
- All traffic routes through Tor. No clearnet fallback. No exceptions.
- DNS never leaks: Tor handles all resolution.
- Circuit isolation per search session. New circuit per session, rotated
  on a timer during long sessions.
- If Tor is unreachable, the method fails closed (refuses to search rather
  than falling back to clearnet).

**Read-only (HARD RULE)**
- SEARCH and READ only. No posting, no messaging, no account creation,
  no authentication to any onion service, no purchases, no downloads
  beyond text content.
- Any attempt by ingested content to coax interaction (forms, login prompts,
  "click here to download") is treated as untrusted content per Phase 1
  rules — displayed as data, never acted on.

**Text-only (HARD RULE)**
- HTML text extraction only. No images rendered or saved. No binaries
  downloaded. No executables, archives, or documents fetched.
- If a result requires downloading a file to view, the method reports
  the file's existence and metadata, but does not fetch it.

**CSAM auto-abort (HARD RULE, non-negotiable)**
- If any retrieved content matches CSAM indicators (keyword blocklist,
  known hash database, or classifier flag), the method ABORTS IMMEDIATELY.
- The abort is logged (timestamp, query, abort reason) WITHOUT logging
  the offending content. The content is never stored, displayed, or
  forwarded.
- Robbie is notified of the abort with the query that triggered it.
  No further action is taken automatically.
- This rule overrides everything, including an active tap. There is no
  override path.

**Governance**
- Each search SESSION requires Robbie's tap (not per query — per session,
  to avoid tap fatigue, but the session scope is bounded: max 30 minutes,
  max 50 queries, then re-tap).
- Session parameters (query scope, target domains, time bound) are declared
  upfront in the tap request. Queries outside the declared scope are blocked.
- Full session transcript in the audit chain: every query, every result
  summary (not full content — summaries only, to limit exposure surface),
  every abort.

**Kill switch**
- A single founder command terminates all active dark web sessions
  immediately, drops Tor circuits, and wipes session scratch data.
- The kill switch works even mid-query. No graceful shutdown — immediate.

### Method spec: `darkweb-search`

**Inputs:**
- `queries`: list of search strings (bounded by session scope)
- `sessionScope`: declared upfront (domains, topics, time bound)
- `tapReference`: founder tap authorizing this session
- `maxResults`: cap per query (default 10)

**Outputs:**
- `summaries`: text summaries of results (never raw HTML dumps)
- `sources`: onion URLs consulted (for verification, not for browsing)
- `auditId`: session audit chain reference
- `abortRecord`: if CSAM abort triggered (reason only, no content)

**Gates:**
- Phase 1 hardening acceptance passed (checked at method load time)
- Active founder tap for the session
- Tor reachable (fail closed if not)
- Queries within declared session scope

### Constraints
- $0 new spend (Tor is free; no paid dark web intel feeds).
- Never runs on shared infrastructure. Designated boxes only.
- No persistent storage of dark web content beyond the session audit
  summaries. Session scratch wiped on close or kill.
- The method NEVER operates without Phase 1 hardening in place.
  If hardening regresses (failed re-test), the method disables itself.

### Phase 2 acceptance
1. Tor-only verification: packet capture during a test session shows zero
   clearnet traffic, zero DNS leaks.
2. Read-only verification: attempt to trigger every interaction path
   (forms, logins, downloads). All blocked.
3. CSAM abort test: controlled test with known indicator content.
   Method aborts in <1 second, logs abort without content, notifies founder.
4. Scope enforcement: queries outside declared session scope are blocked.
5. Kill switch test: terminate mid-session, verify circuits dropped and
   scratch wiped within 5 seconds.
6. Audit completeness: full session transcript present with no gaps.

## Related
- `contracts/model-pin-registry.ts` (governance precedent: pinning + gates)
- `contracts/governance-spine.ts` (spine inheritance: dark web method
  operates under the active spine's constraints)
- `runtime/abliterate-model.ts` (method pattern: tap gate + audit + subprocess)
- Robbie's standing rules: per-engagement tap for sensitive methods,
  $0 spend, no exfiltration, audit everything
