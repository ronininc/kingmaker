// Solomon heartbeat — Kingmaker's side of the CRM route
// POST /api/kingmaker/solomon/heartbeat (ronininc-crm, merged PR #361).
//
// The CRM records last_seen and treats Solomon as offline when beats stop (its window is 5 minutes).
// It does not probe the Mac. This process does, on the same supervisor that already keeps Solomon
// running (lib/runtime.mjs superviseBackend — the packaged launcher is desktop/headless-server.mjs;
// this checkout has no separate launch.mjs / vaultd daemon).
//
// A beat is sent only after Solomon itself answers on http://127.0.0.1:3301. The Kingmaker process
// being up, the supervised child still having a pid, or a previous beat is not evidence. A dead
// Solomon produces no request, so the CRM's window expires and it marks Solomon offline.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** CRM route. Host is on the worker's allowlist (www.ronininc.org). No Origin header: a browser Origin is rejected. */
export const CRM_HEARTBEAT_URL = 'https://www.ronininc.org/api/kingmaker/solomon/heartbeat';
/** Solomon's own health route, on the loopback the CRM already names when Solomon is down. */
export const SOLOMON_LIVENESS_URL = 'http://127.0.0.1:3301/api/health';
export const SOLOMON_LOOPBACK = 'http://127.0.0.1:3301';
export const HEARTBEAT_INTERVAL_MS = 60_000;
export const PROBE_TIMEOUT_MS = 4_000;
export const POST_TIMEOUT_MS = 8_000;

/** Prefixes the CRM accepts on this route (worker/solomon-heartbeat.ts). */
export const DESK_TOKEN_PREFIX = 'ronin_desk_';
export const SOLOMON_TOKEN_PREFIX = 'ronin_solomon_';
export const KING_TOKEN_PREFIX = 'ronin_king_';

const KINDS = Object.freeze(['desk', 'solomon', 'king']);

/** desk (kingmaker desk token) → issued Solomon token → ronin_king_ token. Anything else is not a heartbeat token. */
export function classifyHeartbeatToken(token) {
  const value = String(token ?? '').trim();
  if (value.startsWith(DESK_TOKEN_PREFIX)) return 'desk';
  if (value.startsWith(SOLOMON_TOKEN_PREFIX)) return 'solomon';
  if (value.startsWith(KING_TOKEN_PREFIX)) return 'king';
  return null;
}

/**
 * First usable token in CRM preference order. `candidates` are { kind, token }. Pure.
 * A `ronin_desk_` value counts only when the source marked it the kingmaker desk (`kind: 'desk'`).
 * Any other desk's token is the same prefix and must not be sent here.
 */
export function pickHeartbeatToken(candidates) {
  const usable = [];
  for (const row of candidates || []) {
    const token = String(row?.token ?? '').trim();
    const kind = classifyHeartbeatToken(token);
    if (!kind) continue;
    if (kind === 'desk') { if (row.kind === 'desk') usable.push({ kind, token }); continue; }
    if (!row.kind || row.kind === kind) usable.push({ kind, token });
  }
  for (const kind of KINDS) {
    const hit = usable.find((row) => row.kind === kind);
    if (hit) return hit;
  }
  return null;
}

/** Files under Kingmaker's state dir. Absent files are skipped. */
export function heartbeatTokenFiles(state) {
  return {
    credentials: join(state, 'crm-credentials.json'),
    desk: join(state, 'crm', 'kingmaker-desk.token'),
    solomon: join(state, 'crm', 'solomon.token'),
    king: join(state, 'crm', 'ronin-king.token'),
  };
}

function readText(file, readFile) {
  if (!file) return null;
  try {
    const raw = readFile ? readFile(file) : readFileSync(file, 'utf8');
    const text = String(raw ?? '').trim();
    return text || null;
  } catch {
    return null;
  }
}

function addCredentialRows(candidates, parsed) {
  const rows = Array.isArray(parsed) ? parsed : parsed?.credentials;
  if (!Array.isArray(rows)) return;
  for (const row of rows) {
    const token = row?.token;
    if (row?.desk === 'kingmaker' || row?.grant === 'desk:kingmaker') candidates.push({ kind: 'desk', token });
    else if (classifyHeartbeatToken(token) === 'solomon' || classifyHeartbeatToken(token) === 'king') candidates.push({ token });
  }
}

/**
 * The token this cycle may send, or null. Order: kingmaker desk, issued Solomon, ronin_king_.
 * Named env, then a pairing credentials JSON, then one-line files. Never logs the value.
 */
export function resolveHeartbeatToken({ env = {}, credentials = null, files = null, state = null, readFile = null } = {}) {
  const candidates = [
    { kind: 'desk', token: env.KINGMAKER_DESK_TOKEN },
    { kind: 'solomon', token: env.SOLOMON_TOKEN },
    { kind: 'solomon', token: env.SOLOMON_ISSUED_TOKEN },
    { kind: 'king', token: env.RONIN_KING_TOKEN },
  ];
  addCredentialRows(candidates, credentials);
  const paths = files ?? (state ? heartbeatTokenFiles(state) : null);
  if (paths) {
    const credPath = env.KINGMAKER_CRM_CREDENTIALS || paths.credentials;
    const text = readText(credPath, readFile);
    if (text) {
      try { addCredentialRows(candidates, JSON.parse(text)); } catch { /* not credentials */ }
    }
    candidates.push(
      { kind: 'desk', token: readText(paths.desk, readFile) },
      { kind: 'solomon', token: readText(paths.solomon, readFile) },
      { kind: 'king', token: readText(paths.king, readFile) },
    );
  }
  return pickHeartbeatToken(candidates);
}

function withTimeout(ms, signal) {
  const timeout = AbortSignal.timeout(ms);
  if (!signal) return timeout;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeout]);
  return signal;
}

/** The probe is Solomon on loopback :3301, nothing else. A remote URL cannot stand in for it. */
export function assertSolomonLivenessUrl(url = SOLOMON_LIVENESS_URL) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('Solomon liveness URL is not a URL'); }
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.port !== '3301') {
    throw new Error('Solomon liveness is only http://127.0.0.1:3301');
  }
  if (parsed.pathname !== '/api/health') throw new Error('Solomon liveness is GET /api/health on :3301');
  return parsed.toString();
}

/**
 * One cycle. Returns { beat: false, reason } without calling the CRM unless Solomon answered.
 * `processUp` and any other "Kingmaker is running" hint are ignored — they are not arguments.
 */
export async function beatOnce({
  fetchImpl = fetch,
  token = null,
  env = {},
  credentials = null,
  files = null,
  state = null,
  readFile = null,
  livenessUrl = SOLOMON_LIVENESS_URL,
  crmUrl = CRM_HEARTBEAT_URL,
  probeTimeoutMs = PROBE_TIMEOUT_MS,
  postTimeoutMs = POST_TIMEOUT_MS,
  signal = null,
} = {}) {
  let probe;
  try { probe = assertSolomonLivenessUrl(livenessUrl); }
  catch (error) { return { beat: false, reason: 'refused-probe', error: String(error?.message || error) }; }

  let alive = false;
  let status = null;
  try {
    const res = await fetchImpl(probe, { method: 'GET', signal: withTimeout(probeTimeoutMs, signal) });
    status = res?.status ?? null;
    alive = res?.ok === true;
    try { await res?.body?.cancel?.(); } catch { /* leave the probe response unread */ }
  } catch {
    alive = false;
  }
  if (!alive) return { beat: false, reason: 'solomon-down', status };

  const explicit = token ? classifyHeartbeatToken(token) : null;
  const picked = explicit ? { kind: explicit, token: String(token).trim() } : resolveHeartbeatToken({ env, credentials, files, state, readFile });
  if (!picked) return { beat: false, reason: 'no-token' };

  let posted;
  try {
    posted = await fetchImpl(crmUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${picked.token}`,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ solomon: SOLOMON_LOOPBACK }),
      signal: withTimeout(postTimeoutMs, signal),
    });
  } catch {
    return { beat: false, reason: 'crm-unreachable', kind: picked.kind };
  }
    try { await posted?.body?.cancel?.(); } catch { /* leave the CRM response unread */ }
    return { beat: true, ok: posted?.ok === true, status: posted?.status ?? null, kind: picked.kind };
}

/**
 * Probe, then (only if Solomon answered) POST, immediately and every 60 s.
 * Stop with the supervisor. A cycle that overlaps the previous one is skipped, not queued.
 */
export function startSolomonHeartbeat({
  env = process.env,
  state = null,
  readFile = null,
  fetchImpl = fetch,
  log = () => {},
  schedule = (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer; },
  cancel = clearTimeout,
  intervalMs = HEARTBEAT_INTERVAL_MS,
  livenessUrl = SOLOMON_LIVENESS_URL,
  crmUrl = CRM_HEARTBEAT_URL,
} = {}) {
  let stopped = false;
  let timer = null;
  let inflight = null;
  const ac = new AbortController();
  const tick = () => {
    if (stopped) return null;
    inflight = beatOnce({ fetchImpl, env, state, readFile, livenessUrl, crmUrl, signal: ac.signal })
      .then((result) => {
        const detail = { beat: result.beat, reason: result.reason ?? null, kind: result.kind ?? null, status: result.status ?? null };
        try { log('solomon_heartbeat', detail); } catch { /* reporting never sends a beat */ }
        return result;
      })
      .catch(() => ({ beat: false, reason: 'error' }))
      .finally(() => { inflight = null; });
    return inflight;
  };
  const arm = () => {
    if (stopped) return;
    timer = schedule(() => { timer = null; if (!stopped) void tick()?.finally(arm); }, intervalMs);
  };
  void tick()?.finally(arm);
  return {
    stop() {
      stopped = true;
      ac.abort();
      if (timer) { cancel(timer); timer = null; }
    },
  };
}
