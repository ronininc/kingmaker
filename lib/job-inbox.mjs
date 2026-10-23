// lib/job-inbox.mjs — THE JOB INBOX: a way for an automation agent on this Mac (Codex, Claude Code, a soak script) to
// hand Kingmaker one text job WITHOUT the bar's window, the menu bar or Accessibility. A job is exactly a typed bar turn:
// it goes into the same `typed-turn` line the bar sends (the same bar guard, the same governed brain, the same approval
// gates), the bar shows it, and the answer lands in bar.log as usual.
//
// It can only PROPOSE. A job can never answer a waiting action: "yes", "no", "approve", "go ahead", "cancel"… are refused
// here, and so are bar commands (/…) and console commands (:…), which are the owner's. Anything a job asks for that sends,
// spends, installs or changes a record waits at the bar for the owner's own word, exactly as a typed turn does.
//
// Where: http://127.0.0.1:<port>, a random loopback port written to <state>/job-inbox.json (0600) while Kingmaker runs.
// Who: `Authorization: Bearer <bar link key>` — the same 0600 secret kingmaker://bar?…&key= uses, readable only by this
// Mac's user, and never accepted from a web page (any Origin header, or a Host that isn't loopback, is refused).
//
//   POST /jobs        {"text": "...", "conversation": "soak-1"?}   → 202 {ok, id, state: "queued"}
//   GET  /jobs/<id>   → {ok, id, state: queued|running|done, submittedMs, startedMs, endedMs, answer[], barLog{from,to}}
//   GET  /health      → {ok, queued, running}
//
// `kingmaker job "<text>"` (lib/cli.mjs) is the client; submitJob/waitJob below are importable by scripts.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

export const JOB_TEXT_MAX = 4000;
const KEEP = 200;            // jobs remembered for GET /jobs/<id>
const BODY_MAX = 20_000;
const SETTLE_MS = 2500;      // after the turn ends, how long bar.log gets to catch up before `answer` is final

export const inboxFile = (state) => join(state, 'job-inbox.json');
export const barKeyFile = (state) => join(state, 'bar-link.key');
export const barLogFile = (state) => join(state, 'logs', 'bar.log');

// A decision on a waiting action is the owner's, never a job's. Broader than session.classifyLine on purpose: a line that
// STARTS with an answer word ("yes, send it", "ok do it", "cancel that") is refused too.
const DECISION = /^\s*(y|n|yes|yeah|yep|yup|yes please|sure|ok|okay|go|go ahead|do it|send it|proceed|confirm(ed)?|approve(d)?|allow|accept|no|nope|cancel|deny|reject|stop|don'?t|never ?mind)\b/i;

/** Pure: why a job text is refused ('' when it may go). */
export function jobRefusal(text) {
  const t = typeof text === 'string' ? text.trim() : '';
  if (!t) return 'EMPTY_TEXT';
  if (t.length > JOB_TEXT_MAX) return 'TEXT_TOO_LONG';
  if (DECISION.test(t)) return 'DECISION_NOT_ALLOWED';     // approving or cancelling stays the owner's word, at the bar
  if (/^[/:]/.test(t)) return 'COMMAND_NOT_ALLOWED';       // bar (/…) and console (:…) commands are the owner's
  return '';
}

/** Pure: a conversation label safe to use as the engine's conversation id ('' → none). */
export function jobConversation(c) {
  const s = typeof c === 'string' ? c.trim().replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 60) : '';
  return s ? `job-${s}` : '';
}

/** Pure: the answer lines (Kingmaker/Sources/note) of a bar.log slice, without timestamps. */
export function answerLines(slice) {
  return String(slice || '').split('\n').filter((l) => /^\S+ (Kingmaker|Sources|note): /.test(l)).map((l) => l.replace(/^\S+ /, ''));
}

function readSlice(file, from, to) {
  try { const b = readFileSync(file); return b.subarray(from, to ?? b.length).toString('utf8'); } catch { return ''; }
}
const sizeOf = (file) => { try { return statSync(file).size; } catch { return 0; } };
function sameSecret(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && x.length >= 32 && timingSafeEqual(x, y);
}

/**
 * The inbox inside the running Kingmaker (lib/cli.mjs, only when the bar holds the engine).
 *   submit(text, { conversationId, onStart, onDone })   queue one typed turn; onStart/onDone fire as the turn starts/ends
 *   counts()                                            { queued, running } of the engine's turn queue
 */
export function createJobInbox({ state, submit, counts = () => ({}), log = () => {}, now = () => Date.now(), host = '127.0.0.1' }) {
  const jobs = new Map();
  let server = null;
  const view = (j) => {
    const settled = j.state === 'done' && now() - j.endedMs >= SETTLE_MS;
    const to = j.state === 'done' && settled ? j.barLogTo ?? (j.barLogTo = sizeOf(barLogFile(state))) : null;
    // Submission can happen while the previous turn is still writing its answer.
    // Match this turn's actual bar entry, then stop at the next input. A delayed
    // status read must never collect another queued turn's answer.
    const slice = j.startedMs == null ? '' : readSlice(barLogFile(state), j.barLogFrom, to ?? undefined);
    const lines = slice.split('\n');
    const input = /^\S+ You(?: \(said\))?: (.*)$/;
    const start = lines.findIndex((line) => input.exec(line)?.[1] === j.text.replaceAll('\n', ' '));
    const end = start < 0 ? -1 : lines.findIndex((line, i) => i > start && input.test(line));
    const scoped = start < 0 ? '' : lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
    const offset = (index) => j.barLogFrom + Buffer.byteLength(index === 0 ? '' : lines.slice(0, index).join('\n') + '\n');
    return {
      ok: true, id: j.id, state: j.state === 'done' && !settled ? 'settling' : j.state, conversation: j.conversation || null,
      submittedMs: j.submittedMs, startedMs: j.startedMs ?? null, endedMs: j.endedMs ?? null, textSha256: j.textSha256,
      answer: answerLines(scoped), barLog: { from: start < 0 ? null : offset(start), to: end < 0 ? to : offset(end) },
    };
  };
  const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  const authorized = (req) => {
    let key = '';
    try { key = readFileSync(barKeyFile(state), 'utf8').trim(); } catch { return false; }
    const m = /^Bearer\s+(\S+)$/.exec(String(req.headers.authorization || ''));
    return Boolean(m) && sameSecret(m[1], key);
  };
  const handler = (req, res) => {
    // A web page can reach loopback; it can't send a loopback Host with no Origin, and it never knows the key.
    if (req.headers.origin || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(String(req.headers.host || ''))) return send(res, 403, { ok: false, error: 'LOOPBACK_ONLY' });
    if (!authorized(req)) return send(res, 401, { ok: false, error: 'BAR_KEY_REQUIRED' });
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, ...counts() });
    const one = /^\/jobs\/([A-Za-z0-9_-]{1,40})$/.exec(url.pathname);
    if (req.method === 'GET' && one) { const j = jobs.get(one[1]); return j ? send(res, 200, view(j)) : send(res, 404, { ok: false, error: 'NO_SUCH_JOB' }); }
    if (req.method === 'POST' && url.pathname === '/jobs') {
      let body = '', over = false;
      req.on('data', (c) => { if (over) return; body += c; if (body.length > BODY_MAX) { over = true; send(res, 413, { ok: false, error: 'TOO_LARGE' }); req.destroy(); } });
      req.on('end', () => {
        if (over) return;
        let p = null; try { p = JSON.parse(body); } catch { /* below */ }
        const text = typeof p?.text === 'string' ? p.text.trim() : '';
        const why = jobRefusal(text);
        if (why) { log('job_refused', { reason: why }); return send(res, why === 'DECISION_NOT_ALLOWED' || why === 'COMMAND_NOT_ALLOWED' ? 403 : 400, { ok: false, error: why }); }
        const id = `job_${randomBytes(9).toString('base64url')}`;
        const conversation = jobConversation(p?.conversation);
        const j = { id, text, state: 'queued', conversation, submittedMs: now(), barLogFrom: sizeOf(barLogFile(state)), textSha256: createHash('sha256').update(text).digest('hex') };
        jobs.set(id, j);
        while (jobs.size > KEEP) jobs.delete(jobs.keys().next().value);
        try {
          submit(text, { conversationId: conversation || null,
            onStart: () => { j.state = 'running'; j.startedMs = now(); j.barLogFrom = sizeOf(barLogFile(state)); },
            onDone: () => { j.state = 'done'; j.endedMs = now(); log('job_done', { id, ms: j.endedMs - (j.startedMs ?? j.submittedMs) }); } });
        } catch (e) { jobs.delete(id); return send(res, 503, { ok: false, error: String(e?.message || e).slice(0, 120) }); }
        log('job_queued', { id });
        return send(res, 202, { ok: true, id, state: 'queued' });
      });
      return undefined;
    }
    return send(res, 404, { ok: false, error: 'NOT_FOUND' });
  };
  return {
    async start() {
      if (server) return server.address().port;
      server = createServer(handler);
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve); });
      const port = server.address().port;
      mkdirSync(state, { recursive: true });
      writeFileSync(inboxFile(state), JSON.stringify({ url: `http://127.0.0.1:${port}`, port, pid: process.pid, startedMs: now() }), { mode: 0o600 });
      try { chmodSync(inboxFile(state), 0o600); } catch { /* best effort */ }
      return port;
    },
    async stop() {
      const s = server; server = null;
      try { const cur = JSON.parse(readFileSync(inboxFile(state), 'utf8')); if (cur.pid === process.pid) unlinkSync(inboxFile(state)); } catch { /* gone */ }
      if (s) await new Promise((r) => s.close(() => r()));
    },
    get port() { return server?.address()?.port ?? null; },
  };
}

// ── The client side: `kingmaker job`, soak scripts ──────────────────────────────────────────────────────────────────

/** Where the running Kingmaker's inbox is, and its key; null when Kingmaker (a build with the inbox) isn't running. */
export function findInbox(state) {
  try {
    const info = JSON.parse(readFileSync(inboxFile(state), 'utf8'));
    const key = readFileSync(barKeyFile(state), 'utf8').trim();
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(info.url) || !key) return null;
    if (info.pid) { try { process.kill(info.pid, 0); } catch (e) { if (e.code === 'ESRCH') return null; } }
    return { url: info.url, key };
  } catch { return null; }
}

async function call(inbox, path, { method = 'GET', body, fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const r = await fetchImpl(`${inbox.url}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    headers: { authorization: `Bearer ${inbox.key}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  let json = null; try { json = await r.json(); } catch { /* below */ }
  return { status: r.status, json: json ?? { ok: false, error: `HTTP_${r.status}` } };
}

/** Submit one job. Throws with .code NO_INBOX when no running Kingmaker has an inbox. */
export async function submitJob({ state, text, conversation, fetchImpl } = {}) {
  const why = jobRefusal(text);
  if (why) { const e = new Error(why); e.code = why; throw e; }
  const inbox = findInbox(state);
  if (!inbox) { const e = new Error('NO_INBOX'); e.code = 'NO_INBOX'; throw e; }
  const r = await call(inbox, '/jobs', { method: 'POST', body: { text, ...(conversation ? { conversation } : {}) }, fetchImpl });
  if (!r.json.ok) { const e = new Error(r.json.error || `HTTP_${r.status}`); e.code = r.json.error; throw e; }
  return r.json;
}

export async function getJob({ state, id, fetchImpl } = {}) {
  const inbox = findInbox(state);
  if (!inbox) { const e = new Error('NO_INBOX'); e.code = 'NO_INBOX'; throw e; }
  return (await call(inbox, `/jobs/${encodeURIComponent(id)}`, { fetchImpl })).json;
}

/** Poll until the job's turn has ended and bar.log has settled (state "done"), or timeoutMs; the last view either way. */
export async function waitJob({ state, id, timeoutMs = 180_000, everyMs = 1000, fetchImpl, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const until = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = await getJob({ state, id, fetchImpl });
    if (!last.ok || last.state === 'done' || Date.now() >= until) return { ...last, timedOut: last.ok && last.state !== 'done' };
    await sleep(everyMs);
  }
}

/**
 * The older way, for a running Kingmaker without the inbox (0.2.7–0.3.0): kingmaker://bar?text=…&key=…, handed to macOS
 * on osascript's stdin (never in an argv another process can read) without activating Kingmaker, then bar.log is read
 * until it's quiet. No job id or turn-end signal: the answer is "what bar.log said next".
 */
export async function sendByLink({ state, text, waitMs = 120_000, quietMs = 15_000, open, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const why = jobRefusal(text);
  if (why) { const e = new Error(why); e.code = why; throw e; }
  if (!existsSync(barKeyFile(state))) { const e = new Error('NO_BAR_KEY'); e.code = 'NO_BAR_KEY'; throw e; }
  const key = readFileSync(barKeyFile(state), 'utf8').trim();
  const url = `kingmaker://bar?text=${encodeURIComponent(text)}&key=${encodeURIComponent(key)}`;
  const from = sizeOf(barLogFile(state));
  await (open ? open(url) : new Promise((resolve, reject) => {
    const child = execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-'], (err) => (err ? reject(err) : resolve()));
    child.stdin.end(`ObjC.import('AppKit');const c=$.NSWorkspaceOpenConfiguration.configuration;c.activates=false;$.NSWorkspace.sharedWorkspace.openURLConfigurationCompletionHandler($.NSURL.URLWithString(${JSON.stringify(url)}),c,function(){});delay(1)`);
  }));
  const until = Date.now() + waitMs;
  let answer = [], last = '', quietSince = Date.now();
  while (Date.now() < until) {
    await sleep(1500);
    answer = answerLines(readSlice(barLogFile(state), from));
    const now = answer.join('\n');
    if (now !== last) { last = now; quietSince = Date.now(); }
    if (answer.length && Date.now() - quietSince > quietMs) break;
  }
  return { ok: true, via: 'link', state: answer.length ? 'quiet' : 'no-answer', answer, barLog: { from, to: sizeOf(barLogFile(state)) } };
}
