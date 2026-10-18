// The governed HTTP surface Kingmaker speaks to. Every call is loopback; authority comes only from the
// headers the caller passes (the owner console adds the launch nonce, nothing else does).

import { DESKTOP_NONCE_HEADER } from './profile.mjs';

export function baseUrl(port) {
  return `http://127.0.0.1:${port}`;
}

/** `rawBody`: JSON bytes the caller built (and zero-fills after), sent as-is: never turned into a string here. */
async function call(port, path, { method = 'GET', body, rawBody, headers = {}, timeoutMs = 60_000, fetchImpl = fetch } = {}) {
  const hasBody = rawBody !== undefined || Boolean(body);
  const res = await fetchImpl(`${baseUrl(port)}${path}`, {
    method,
    headers: { ...(hasBody ? { 'content-type': 'application/json' } : {}), ...headers },
    body: rawBody !== undefined ? rawBody : body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, json };
}

/**
 * An owner-only route (vault, CLI-Anything, reverse engineering, capability acquisition, feature watch, key
 * handoff). With no window, the engine admits exactly the owner console there: a loopback request carrying this
 * launch's nonce. Only the owner console process holds it (`kingmaker start` mints it; a headless runtime that
 * minted its own leaves it in a 0600 file for its local owner). `say` and the MCP surface never call this, so
 * they stay propose-only. Without a nonce it refuses locally instead of sending an anonymous request.
 */
export function ownerCall(port, path, { nonce, method = 'GET', body, rawBody, timeoutMs, fetchImpl } = {}) {
  if (typeof nonce !== 'string' || nonce.trim().length < 32) return Promise.reject(new Error('OWNER_NONCE_REQUIRED'));
  return call(port, path, { method, body, rawBody, headers: { [DESKTOP_NONCE_HEADER]: nonce }, ...(timeoutMs ? { timeoutMs } : {}), ...(fetchImpl ? { fetchImpl } : {}) });
}

/**
 * A route engine's read-back of a write it will only do on a go-ahead ("I will make … Say go ahead to make it.",
 * 'say "yes, go ahead"'). The turn data does not flag that legacy read-back (its confirmationRequired is governance's
 * own flag, false for these), so until the core surfaces it, the engine's own line is the signal.
 */
export const READ_BACK_LINE = /\bsay\s+["“]?(?:yes,?\s+)?go ahead\b/i;

/** One governed turn. Returns the fields a voice/console surface needs; `raw` keeps the rest. */
export async function turn(port, { text, conversationId, mode = 'text', image, headers, fetchImpl, timeoutMs = 90_000 }) {
  // `image` (a field photo from the phone) rides the turn as GovernedConversationTurnInput.image for the vision lane;
  // the runtime prefers `path` (the upload already on disk). Only sent when present, so text turns are unchanged.
  const body = { userText: text, mode, tenantId: 'primary', ...(conversationId ? { conversationId, sessionId: conversationId } : {}), ...(image ? { image } : {}) };
  const r = await call(port, '/api/conversation/turn', { method: 'POST', body, headers, fetchImpl, timeoutMs });
  const d = r.json?.data ?? {};
  const spoken = String(d.spokenResponse || d.solomonResponse || r.json?.message || '').trim();
  const readBack = d.dispatchExecuted !== true && READ_BACK_LINE.test(spoken);
  return {
    ok: r.ok && Boolean(r.json?.data),
    status: r.status,
    conversationId: d.conversationId ?? conversationId ?? null,
    spoken,
    confirmationRequired: d.confirmationRequired === true || readBack,
    /** True when the wait is an engine's read-back in this conversation (no broker proposal behind it). */
    readBack,
    proposalId: d.controlSurface?.status === 'AWAITING_CONFIRMATION' ? d.controlSurface.proposalId ?? null : null,
    route: d.workflowRoute ?? d.route ?? null,
    executed: d.dispatchExecuted === true,
    raw: r.json,
  };
}

export const agentStatus = (port, opts) => call(port, '/api/agent/status', { timeoutMs: 45_000, ...opts });
/** The engine's ArtCraft install check (read-only: which of the seven it finds, pinned or refused). No nonce. */
export const artcraftDoctor = (port, opts) => call(port, '/api/artcraft/doctor', { timeoutMs: 15_000, ...opts });
export const health = (port, opts) => call(port, '/api/health', { timeoutMs: 5_000, ...opts });
export const controlStatus = (port, opts) => call(port, '/api/control/status', { timeoutMs: 5_000, ...opts });
export const pendingProposals = (port, opts) => call(port, '/api/control/proposals', { timeoutMs: 10_000, ...opts });
export const confirmProposal = (port, id, { typedChallenge, headers, fetchImpl } = {}) =>
  call(port, `/api/control/proposals/${encodeURIComponent(id)}/confirm`, { method: 'POST', body: typedChallenge ? { typedChallenge } : {}, headers, fetchImpl });
/** Post Kingmaker's health snapshot (voice + permissions) for the self-assessment; the server only caches it
 *  (report: false → 202). Same body the window app posts. */
export const postHealthSnapshot = (port, desktop, { headers, timeoutMs = 10_000, fetchImpl } = {}) =>
  call(port, '/api/health/self-assessment', { method: 'POST', body: { desktop, report: false }, headers, timeoutMs, fetchImpl });
export const cancelProposal = (port, id, opts = {}) =>
  call(port, `/api/control/proposals/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: {}, ...opts });

/**
 * Any server-sent-event stream on the engine's own port. Calls onOpen() once the server accepted it, then
 * onEvent({type, data}) per frame; resolves when the stream ends (a server restart). A refused or missing
 * stream throws an Error carrying `.status` (401/403 = not this caller's to read; 404 = not in this build).
 */
export async function streamEvents(port, path, { headers = {}, onEvent, onOpen = () => {}, signal, fetchImpl = fetch }) {
  const res = await fetchImpl(`${baseUrl(port)}${path}`, { headers: { accept: 'text/event-stream', ...headers }, signal });
  if (!res.ok || !res.body) {
    try { await res.body?.cancel?.(); } catch { /* nothing to drain */ }
    throw Object.assign(new Error(`${path.split('?')[0]} HTTP ${res.status}`), { status: res.status });
  }
  onOpen();
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    let cut;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const parsed = parseSseFrame(frame);
      if (parsed) { const r = onEvent(parsed); if (typeof r?.catch === 'function') r.catch(() => {}); }
    }
  }
}

/**
 * The control-surface event stream (SSE). Calls onEvent({type, data}) per frame; resolves when the
 * stream ends. Event-driven: the console refreshes pending proposals when the server says so.
 */
export function streamControlEvents(port, opts) {
  return streamEvents(port, '/api/control/events?tenantId=primary', opts);
}

/** ANSWER FAST, DELIVER LATER: the background-task registry's snapshot-then-changes stream (tasks.snapshot,
 *  task.changed). The same stream the window app's main process speaks "It's ready" from. */
export function streamBackgroundTasks(port, opts) {
  return streamEvents(port, '/api/tasks/events?tenantId=primary', opts);
}

/** The feature watch's snapshot stream (event: feature-watch), on connect and on every change. ROOT only. */
export function streamFeatureWatch(port, opts) {
  return streamEvents(port, '/api/feature-watch/events?tenantId=primary', opts);
}

/** Claim the spoken line for asks not yet announced: the server marks them announced and returns the one
 *  line to say (or null), so exactly one surface speaks each ask, once. */
export const claimFeatureWatchAnnouncements = (port, askIds, opts = {}) =>
  call(port, '/api/feature-watch/announced?tenantId=primary', { method: 'POST', body: { askIds }, timeoutMs: 10_000, ...opts });

/** Pure: one SSE frame → {type, data} (comments/heartbeats → null). */
export function parseSseFrame(frame) {
  let type = 'message';
  const data = [];
  for (const line of String(frame).split('\n')) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) type = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return null;
  const text = data.join('\n');
  try { return { type, data: JSON.parse(text) }; } catch { return { type, data: text }; }
}
