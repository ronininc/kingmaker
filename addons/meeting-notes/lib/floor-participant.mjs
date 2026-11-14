// lib/floor-participant.mjs — "Mia, backed by Kingmaker": the Mac-side meeting participant.
//
// The Ronin/Orosolu CRM runs an "office floor" (worker/office/*): rooms people walk into, calls between them, and an
// owner's switch for note-taking. The CRM's OWN notetaker (Seeker) files notes from browser captions. THIS is the
// Mac-side AI member the owner's Solomon/Kingmaker runs: it joins a room call as an AI member under the owner's chosen
// name, transcribes on the Mac, and PROPOSES workflow tasks. Nothing it proposes runs until the owner presses Approve
// start at the orb; the vendored Solomon floor-loop then runs the approved batch (solomon/server/.../solomon-floor-loop.ts).
//
// The contract is the CRM code (the doc path in some briefs does not exist): worker/office/meetings.ts (the five MCP
// tools + proposeMeeting), worker/office/hub-do.ts (the WebSocket protocol + Seeker), worker/office/floor.ts (the
// ticket→WS handoff), worker/lib/_proof/meeting.test.mjs (the server-side proof). Flow:
//   1. MCP office_ticket {name} on /mcp/solomon → { ticket, ice_servers, settings{enabled,voice,min_people}, spots, ws_path }.
//   2. WS GET <crm-origin><ws_path>?ticket=<ticket> (no cookie) → onto the floor as ai:solomon at the hall orb (title
//      "AI · notes", so the floor SHOWS Mia is taking notes). One socket per room; walk in with {t:'move',x,y,dir,room}.
//   3. Capture what's said as utterances {at,speaker,guest,text}. Audio + the full transcript stay on this Mac.
//   4. At meeting end (the room empties below min_people) or "Mia, wrap it up": MCP meeting_propose with the synopsis,
//      the transcript, and the proposed tasks. Then leave the room.
//
// Privacy (the contract's limit): audio and the full transcript never leave the Mac; only the notes/tasks go to the CRM.
//
// Utterance sources are pluggable. The STT source (on-Mac whisper via lib/voice.mjs, owner-vocabulary --prompt) is fed
// through feedAudio() — wire it to a WebRTC track when a Node WebRTC stack is present. The chat source (room {t:'chat'}
// lines) needs no audio and is the end-to-end tested path. Everything here takes its I/O injected, so the orchestrator
// runs under test against the real CRM worker in Miniflare with no microphone and no network.

// Kingmaker ships the GENERIC ability to dock to a CRM floor and take notes — never a particular CRM or assistant.
// There is no default CRM here (the floor must be configured) and the default name is neutral; the owner sets their own
// assistant name (e.g. "Mia") and CRM through configuration. "Notes" is the fallback when nothing is set.
export const DEFAULT_NAME = 'Notes';
export const SETTINGS_TTL_MS = 60_000;
/** Fallback orb spots (owner room x10,y4 etc.) when office_ticket does not name one for a room. Matches meetings.ts ORB_SPOTS. */
export const FALLBACK_SPOTS = Object.freeze({
  hall: { x: 15, y: 11 }, owner: { x: 10, y: 4 }, meeting: { x: 27, y: 4 }, studio: { x: 36, y: 4 },
  lounge: { x: 50, y: 4 }, lobby: { x: 12, y: 18 }, sales: { x: 33, y: 18 }, build: { x: 52, y: 18 },
});

const AT = () => Date.now();
const noop = () => {};
// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
export const clean = (v, n = 2000) => String(v ?? '').replace(CTRL, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

// ── config ───────────────────────────────────────────────────────────────────
/** Where the CRM floor is and what name the assistant shows — ALL from configuration, no built-in CRM. Returns
 *  { name, mcpUrl, token }; mcpUrl is null until the person configures one, so nothing docks to a CRM by default.
 *  The env var names keep their RONIN_* spelling for compatibility with existing installs, but carry any CRM's values. */
export function resolveParticipantConfig({ env = process.env } = {}) {
  const name = clean(env.KINGMAKER_FLOOR_NAME, 40) || DEFAULT_NAME;
  const mcpUrl = clean(env.RONIN_CRM_MCP_URL, 300) || null;
  const token = env.RONIN_CRM_MCP_TOKEN || env.RONIN_CRM_TOKEN || env.SOLOMON_CRM_TOKEN || null;
  return { name, mcpUrl, token };
}

/** The web origin the floor WebSocket is built from: the MCP server's own origin, never a host the reply names. */
export function crmOrigin(mcpUrl) { return new URL(mcpUrl).origin; }

// ── the CRM's Solomon MCP (/mcp/solomon) ───────────────────────────────────────
/** A client for the CRM's stateless Solomon MCP: one JSON-RPC tools/call per POST, Bearer token, SSE or JSON reply.
 *  Matches worker/solomon-mcp.ts and the shape meeting.test.mjs drives. callTool rejects on a tool error or a shut door. */
export function crmMcpClient({ url, token, fetchImpl = fetch, timeoutMs = 60_000 }) {
  if (!url) throw new Error('crmMcpClient needs the /mcp/solomon URL.');
  if (!token) throw new Error('crmMcpClient needs an owner-minted MCP token.');
  let id = 0;
  async function callTool(name, args = {}) {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401 || res.status === 403) throw new Error(`CRM MCP refused the token (${res.status}).`);
    const text = await res.text();
    if (res.status !== 200) throw new Error(`CRM MCP ${name} HTTP ${res.status}: ${text.slice(0, 200)}`);
    const line = text.split('\n').find((l) => l.startsWith('data:'));
    let j; try { j = JSON.parse(line ? line.slice(5).trim() : text); } catch { throw new Error(`CRM MCP ${name}: unreadable reply.`); }
    if (j.error) throw new Error(`CRM MCP ${name}: ${j.error.message || 'error'}`);
    const payload = j.result?.content?.[0]?.text ?? '';
    if (j.result?.isError) throw new Error(`CRM MCP ${name}: ${payload || 'tool error'}`);
    try { return JSON.parse(payload); } catch { return { raw: payload }; }
  }
  return { callTool };
}

// ── the floor WebSocket ─────────────────────────────────────────────────────
/** The default transport: Node's global WebSocket client (undici). The AI socket carries no cookie — the ticket is in
 *  the query — so no custom headers are needed. Returns the uniform transport FloorConnection consumes. */
export async function webSocketTransport(url, { WebSocketImpl = globalThis.WebSocket } = {}) {
  if (!WebSocketImpl) throw new Error('No WebSocket implementation available (Node 21+ has a global one).');
  const ws = new WebSocketImpl(url);
  const listeners = { message: [], close: [] };
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', (e) => reject(e?.error || new Error('WebSocket error')), { once: true });
  });
  ws.addEventListener('message', (ev) => { const s = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'); for (const cb of listeners.message) cb(s); });
  ws.addEventListener('close', () => { for (const cb of listeners.close) cb(); });
  return {
    status: 101,
    send: (s) => { try { ws.send(s); } catch { /* closed */ } },
    close: () => { try { ws.close(1000, 'bye'); } catch { /* closed */ } },
    onMessage: (cb) => listeners.message.push(cb),
    onClose: (cb) => listeners.close.push(cb),
  };
}

/** A parsed floor socket over a transport: dispatches {t:…} events, sends objects, and reads the opening {t:'init'}. */
export class FloorConnection {
  constructor(transport) {
    this.transport = transport;
    this.status = transport.status;
    this.handlers = new Map(); // t → Set<fn>
    this.init = null;
    this.closed = false;
    transport.onMessage?.((s) => this.#onMessage(s));
    transport.onClose?.(() => { this.closed = true; this.#emit('_close', {}); });
  }
  #onMessage(s) { let m; try { m = JSON.parse(s); } catch { return; } if (m && typeof m === 'object' && !this.init && m.t === 'init') this.init = m; if (m?.t) this.#emit(m.t, m); }
  #emit(t, m) { for (const fn of this.handlers.get(t) ?? []) { try { fn(m); } catch { /* handler */ } } }
  on(t, fn) { if (!this.handlers.has(t)) this.handlers.set(t, new Set()); this.handlers.get(t).add(fn); return () => this.handlers.get(t)?.delete(fn); }
  send(obj) { this.transport.send(JSON.stringify(obj)); }
  close() { this.closed = true; this.transport.close(); }
  /** Resolve with the first message matching `match` (already seen in init, or arriving within ms); null on timeout. */
  nextInit(ms = 5000) {
    if (this.init) return Promise.resolve(this.init);
    return new Promise((resolve) => { const off = this.on('init', (m) => { off(); resolve(m); }); setTimeout(() => { off(); resolve(this.init); }, ms); });
  }
}

/** Open a floor socket for a ticket and wait for its {t:'init'}. openTransport(url) yields a transport. */
export async function openFloorSocket({ wsBase, ticket, openTransport = webSocketTransport, initTimeoutMs = 5000 }) {
  const url = `${wsBase}?ticket=${encodeURIComponent(ticket)}`;
  const transport = await openTransport(url);
  const conn = new FloorConnection(transport);
  if (conn.status && conn.status !== 101) return conn; // refused: caller inspects status
  await conn.nextInit(initTimeoutMs);
  return conn;
}

// ── the roster (who is in which room) ──────────────────────────────────────────
/** Everyone on the floor, by tab id, from the hub's init/joined/left/moved/media events. */
export class Roster {
  constructor(init) { this.peers = new Map(); if (init) this.applyInit(init); }
  applyInit(init) { for (const p of init.peers ?? []) this.#put(p); if (init.you) this.#put(init.you); }
  #put(p) { if (p?.id) this.peers.set(p.id, { ...this.peers.get(p.id), ...p }); }
  onEvent(m) {
    if (!m?.t) return;
    if (m.t === 'joined' && m.peer) this.#put(m.peer);
    else if (m.t === 'left' && m.id) this.peers.delete(m.id);
    else if (m.t === 'moved' && m.id) { const p = this.peers.get(m.id); if (p) { p.x = m.x; p.y = m.y; p.dir = m.dir; p.room = m.room; } }
    else if (m.t === 'media' && m.id) { const p = this.peers.get(m.id); if (p) { p.mic = m.mic; p.cam = m.cam; p.share = m.share; } }
  }
  /** The real people in a room: one entry per distinct userId, AI orbs (Seeker, our own sockets) excluded. */
  peopleInRoom(room) {
    const byUser = new Map();
    for (const p of this.peers.values()) if (!p.ai && !p.gone && p.room === room && p.userId) if (!byUser.has(p.userId)) byUser.set(p.userId, { userId: p.userId, name: p.name || 'Someone', guest: !!p.guest });
    return [...byUser.values()];
  }
  /** Every real person's TAB in a room (one per browser tab, AI orbs excluded) — the mesh WebRTC peers Mia connects to. */
  tabsInRoom(room) {
    const out = [];
    for (const p of this.peers.values()) if (!p.ai && !p.gone && p.room === room && p.id) out.push({ id: p.id, name: p.name || 'Someone', guest: !!p.guest });
    return out;
  }
  nameFor(tabId) { return this.peers.get(tabId)?.name || 'Someone'; }
}

// ── when to take notes ─────────────────────────────────────────────────────────
export function shouldTakeNotes({ peopleCount, settings }) {
  return !!settings?.enabled && peopleCount >= Math.max(1, Number(settings?.min_people) || 2);
}

// ── "Mia, wrap it up" ────────────────────────────────────────────────────────
export const WRAP_RE = /\b(wrap(?:\s+it|\s+this|\s+us)?\s+up|that'?s a wrap|finish(?:\s+it)?\s+up|close(?:\s+it|\s+this)?\s+out|we'?re (?:all )?done here|wrap the meeting)\b/i;
/** A line that both addresses `name` and asks to wrap up. Keeps Mia from wrapping on someone else's "let's wrap up". */
export function isWrapCommand(text, name = DEFAULT_NAME) {
  const s = String(text ?? '');
  if (!WRAP_RE.test(s)) return false;
  const n = String(name || DEFAULT_NAME).trim();
  return new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(s);
}
/** A line addressed to Mia (for full-voice answers): "Mia, …" / "hey Mia" / "… Mia?". */
export function isAddressedTo(text, name = DEFAULT_NAME) {
  const n = String(name || DEFAULT_NAME).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\b)(hey\\s+|ok\\s+|okay\\s+)?${n}\\b`, 'i').test(String(text ?? ''));
}

// ── building the notes (pure) ──────────────────────────────────────────────────
const FILLER = /^(ok(ay)?|so|um|uh|well|right|yeah|alright|like|i think|i guess|maybe we should|basically)[,:\s]+/i;
const DECISION_RE = /\b(we(?:'ll| will| are going to|'re going to)? (?:go with|decided|agreed|settle on|ship|pick)|let'?s go with|decision:|we agreed|final answer is|we'?re going with)\b/i;
// An action item: someone is on the hook to do something.
const ACTION_RES = [
  /\b(action item|to-?do)\b[:\-\s]+(.+)/i,
  /\b(i'?ll|i will|we'?ll|we will|we need to|we should|we have to|let'?s)\s+(.+)/i,
  /\b(can|could|would|will)\s+you\s+(.+)/i,
  /\b(please|make sure(?:\s+to)?|be sure to|don'?t forget to|remember to|follow up(?:\s+on)?)\s+(.+)/i,
];
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** A plain due timestamp (ms) from a few everyday phrases, or null. now is injectable for tests. Local time, 5pm. */
export function parseDue(text, now = Date.now()) {
  const s = String(text ?? '').toLowerCase();
  const at5 = (d) => { d.setHours(17, 0, 0, 0); return d.getTime(); };
  const base = new Date(now);
  if (/\b(eod|end of day|today|this afternoon|by end of day)\b/.test(s)) return at5(new Date(now));
  if (/\btomorrow\b/.test(s)) { const d = new Date(now); d.setDate(d.getDate() + 1); return at5(d); }
  if (/\bnext week\b/.test(s)) { const d = new Date(now); d.setDate(d.getDate() + 7); return at5(d); }
  const inDays = /\bin (\d{1,2}) days?\b/.exec(s); if (inDays) { const d = new Date(now); d.setDate(d.getDate() + Number(inDays[1])); return at5(d); }
  const wd = WEEKDAYS.findIndex((w) => new RegExp(`\\b(by |on |this |next )?${w}\\b`).test(s));
  if (wd >= 0) { const d = new Date(now); let add = (wd - d.getDay() + 7) % 7; if (add === 0) add = 7; d.setDate(d.getDate() + add); return at5(d); }
  return null;
}

/** An assignee named in the line ("<Name>, can you…", "ask <Name> to…", "<Name> will…"), or null. */
function ownerIn(text, speakers) {
  const s = String(text ?? '');
  if (/\b(i'?ll|i will|i'?m going to|let me)\b/i.test(s)) return null; // the speaker themselves; caller fills in
  const ask = /\b(?:ask|have|get)\s+([A-Z][a-z]+)\b/.exec(s);
  if (ask && speakers.includes(ask[1])) return ask[1];
  const addr = /^\s*([A-Z][a-z]+)[,:]\s/.exec(s);
  if (addr && speakers.includes(addr[1])) return addr[1];
  const will = /\b([A-Z][a-z]+)\s+(?:will|should|is going to|can|could)\b/.exec(s);
  if (will && speakers.includes(will[1])) return will[1];
  return null;
}

function titleOf(raw) {
  let t = clean(raw, 160).replace(FILLER, '');
  t = t.replace(/[.?!]+$/, '').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * Turn utterances into a proposal. PURE and deterministic (no model, so it runs offline on an 8 GB Mac): an optional
 * model-backed summarizer can replace this later. Returns { synopsis, decisions, actionItems, tasks, transcript,
 * participants } shaped for meeting_propose. Each task's evidence is the transcript line index it came from.
 */
export function buildNotes(utterances, { name = DEFAULT_NAME, participants = [], now = Date.now() } = {}) {
  const transcript = (Array.isArray(utterances) ? utterances : [])
    .map((u) => ({ at: Number(u?.at) || 0, speaker: clean(u?.speaker, 80) || 'Someone', guest: !!u?.guest, text: clean(u?.text, 2000) }))
    .filter((u) => u.text).sort((a, b) => a.at - b.at);
  const speakers = [...new Set(transcript.map((u) => u.speaker))];
  const me = String(name || DEFAULT_NAME);
  const decisions = [];
  const tasks = [];
  const seen = new Set();
  transcript.forEach((u, i) => {
    if (u.speaker === me) return; // Mia's own lines are not tasks or decisions
    if (DECISION_RE.test(u.text)) decisions.push({ text: u.text, evidence: [i] });
    for (const re of ACTION_RES) {
      const m = re.exec(u.text);
      if (!m) continue;
      const body = m[m.length - 1];
      const title = titleOf(body);
      const key = title.toLowerCase();
      if (title.length < 3 || seen.has(key)) break;
      seen.add(key);
      const assignee = ownerIn(u.text, speakers) ?? (/\b(i'?ll|i will|i'?m going to|let me)\b/i.test(u.text) ? u.speaker : null);
      const due = parseDue(u.text, now);
      tasks.push({ title, detail: u.text, evidence: [i], ...(assignee ? { owner: assignee } : {}), ...(due ? { due } : {}) });
      break;
    }
  });
  const people = participants.length ? participants.map((p) => (typeof p === 'string' ? p : p.name)).filter(Boolean) : speakers.filter((s) => s !== me);
  const head = `${people.join(', ') || 'The room'} — ${tasks.length} action item${tasks.length === 1 ? '' : 's'}${decisions.length ? `, ${decisions.length} decision${decisions.length === 1 ? '' : 's'}` : ''}.`;
  const body = tasks.length
    ? tasks.map((k) => `• ${k.title}${k.owner ? ` (${k.owner})` : ''}`).join('\n')
    : transcript.slice(0, 3).map((u) => `${u.speaker}: ${u.text}`).join('\n');
  const synopsis = clean(`${head}\n${body}`, 4000).replace(/ \n/g, '\n');
  return { synopsis, decisions, actionItems: tasks, tasks, transcript, participants: people };
}

// ── the orchestrator ───────────────────────────────────────────────────────────
/**
 * Mia on the floor. Watches the floor from a home socket in the hall; when a room has >= min_people and note-taking is
 * on, it takes a ticket, opens a room socket, walks Mia's orb to the room's spot (so the floor shows she's taking
 * notes), and records what is said. When the room empties below min_people, or someone says "Mia, wrap it up", it files
 * the notes and proposed tasks with meeting_propose and leaves. In 'full' voice it may answer a line addressed to Mia
 * (as a chat line — the AI can chat; it never dials audio). In 'listen' (the default) it is silent.
 */
export class MeetingParticipant {
  constructor({ mcp, name = DEFAULT_NAME, wsBase, openTransport = webSocketTransport, now = AT, log = noop, transcriber = null, reply = null, speaker = null, audio = true, audioBridgeFactory = null, vocab = '', vocabProvider = null } = {}) {
    if (!mcp) throw new Error('MeetingParticipant needs a crmMcpClient.');
    if (!wsBase) throw new Error('MeetingParticipant needs the floor WebSocket base URL.');
    this.mcp = mcp; this.name = name || DEFAULT_NAME; this.wsBase = wsBase;
    this.openTransport = openTransport; this.now = now; this.log = log;
    this.transcriber = transcriber; this.reply = reply; this.speaker = speaker;
    // Live room audio is on when note-taking has STT to run it through; without a transcriber there's nothing to do with
    // decoded audio, so the bridge is skipped and Mia follows the room chat instead. Injectable for tests.
    this.audio = audio; this.audioBridgeFactory = audioBridgeFactory;
    // The whisper vocabulary: a base (owner) string, extended per meeting with the room's people and, when a provider is
    // given, the CRM's own names (merchants/contacts) so homophones resolve to the names the owner actually uses.
    this.vocab = vocab; this.vocabProvider = vocabProvider;
    this.settings = { enabled: true, voice: 'listen', min_people: 2 };
    this.spots = { ...FALLBACK_SPOTS };
    this.settingsAt = 0;
    this.roster = new Roster();
    this.home = null;
    this.meetings = new Map(); // room → { conn, startedAt, utterances, participants:Set }
    this.calledRooms = new Set(); // rooms entered by an explicit "Call Mia" (one person is enough; see #onCalled)
    this.stopped = false;
  }

  /** A fresh ticket (one per socket). Refreshes the cached settings/spots. Returns the ticket or null when switched off. */
  async #ticket() {
    const tk = await this.mcp.callTool('office_ticket', { name: this.name });
    if (tk?.settings) { this.settings = tk.settings; this.settingsAt = this.now(); }
    if (tk?.spots) this.spots = { ...FALLBACK_SPOTS, ...tk.spots };
    if (!tk?.enabled || !tk?.ticket) return null;
    return tk;
  }

  async start() {
    const tk = await this.#ticket();
    if (!tk) { this.log('floor_disabled', {}); return false; }
    this.home = await this.#open(tk.ticket);
    if (!this.home || this.home.status !== 101) { this.log('home_refused', { status: this.home?.status }); return false; }
    this.roster = new Roster(this.home.init);
    for (const t of ['joined', 'left', 'moved', 'media']) this.home.on(t, (m) => { this.roster.onEvent(m); this.#evaluate(); });
    // "Call Mia": a single person can call her and get the same notes as a meeting. The hub forwards these to the AI member.
    this.home.on('mia-called', (m) => this.#onCalled(m));
    this.home.on('mia-hungup', (m) => this.#onHangup(m));
    this.#evaluate();
    this.log('floor_watching', { name: this.name, voice: this.settings.voice, min_people: this.settings.min_people });
    return true;
  }

  async #open(ticket) {
    try { return await openFloorSocket({ wsBase: this.wsBase, ticket, openTransport: this.openTransport }); }
    catch (e) { this.log('socket_error', { error: String(e?.message || e) }); return null; }
  }

  /** Look at every room with people and decide whether Mia should be in it. */
  #evaluate() {
    if (this.stopped) return;
    const rooms = new Set([...this.roster.peers.values()].filter((p) => !p.ai && !p.gone && p.room && p.room !== 'hall').map((p) => p.room));
    for (const room of rooms) {
      const n = this.roster.peopleInRoom(room).length;
      if (!this.meetings.has(room) && shouldTakeNotes({ peopleCount: n, settings: this.settings })) void this.joinRoom(room);
    }
    for (const room of [...this.meetings.keys()]) {
      // A called (one-on-one) room only ends when it is truly empty; a meeting ends when it drops below min_people.
      const floor = this.calledRooms.has(room) ? 1 : Math.max(1, Number(this.settings.min_people) || 2);
      if (this.roster.peopleInRoom(room).length < floor) void this.wrapUp(room, 'empty');
    }
    for (const m of this.meetings.values()) if (m?.bridge) this.#syncAudio(m); // connect to / drop audio peers as the room changes
  }

  /** "Call Mia" from one person: join that room now even with a single caller (an explicit call bypasses min_people),
   *  then take notes and propose exactly like a meeting. */
  #onCalled(m) {
    const room = typeof m?.room === 'string' && /^[a-z0-9_-]{1,48}$/.test(m.room) ? m.room : null;
    if (!room || this.stopped) return;
    this.calledRooms.add(room);
    this.log('mia_called', { room, by: clean(m?.name, 80) || null });
    void this.joinRoom(room);
  }

  /** The caller hung up: file the call's notes like any meeting and leave. */
  #onHangup(m) {
    const room = typeof m?.room === 'string' ? m.room : null;
    if (!room) return;
    void this.wrapUp(room, 'hangup');
  }

  /** Join one room: a ticket, a socket, walk Mia's orb to the room, and start recording. */
  async joinRoom(room) {
    if (this.meetings.has(room) || this.stopped) return;
    this.meetings.set(room, null); // reserve, so a burst of events joins once
    const tk = await this.#ticket();
    if (!tk) { this.meetings.delete(room); return; }
    const conn = await this.#open(tk.ticket);
    if (!conn || conn.status !== 101) { this.meetings.delete(room); return; }
    const spot = this.spots[room] || FALLBACK_SPOTS[room] || this.spots.hall || FALLBACK_SPOTS.hall;
    conn.send({ t: 'move', x: spot.x, y: spot.y, dir: 'down', room });
    conn.send({ t: 'media', mic: false, cam: false, share: false }); // present and visibly not dialing anyone
    const people = this.roster.peopleInRoom(room);
    const m = { room, conn, startedAt: this.now(), utterances: [], participants: new Map(people.map((p) => [p.name, { name: p.name, guest: p.guest }])), bridge: null, pending: [], crmVocab: [] };
    this.meetings.set(room, m);
    conn.on('chat', (msg) => { if (msg.room === room && msg.name !== this.name) this.#heard(room, { speaker: msg.name, guest: !!this.#guestByName(room, msg.name), text: msg.text }); });
    this.log('joined_room', { room, people: people.length });
    if (this.vocabProvider) { try { m.crmVocab = (await this.vocabProvider(room)) || []; } catch { m.crmVocab = []; } } // the CRM's own names, once per meeting
    await this.#startAudio(m, tk, conn);
  }

  /** Bring up the live room-audio mesh for a meeting, if audio is on and there is STT to feed. Best-effort: a failure
   *  (the WebRTC stack won't load, or a peer won't connect) is logged and the chat path carries on. */
  async #startAudio(m, tk, conn) {
    if (!this.audio || !this.transcriber || m.bridge) return;
    const selfId = conn.init?.you?.id;
    if (!selfId) return;
    try {
      const make = this.audioBridgeFactory || (async (opts) => { const { FloorAudioBridge } = await import('./floor-audio-webrtc.mjs'); return new FloorAudioBridge(opts); });
      const bridge = await make({
        selfId, iceServers: tk.ice_servers || [], log: this.log,
        talk: this.settings.voice === 'full' && !!this.speaker, synth: this.speaker, // Mia may speak back in full voice
        send: (msg) => { if (!conn.closed) conn.send(msg); },
        onSpeech: (peerId, samples) => { m.pending.push(this.feedAudio(m.room, this.roster.nameFor(peerId), samples)); },
      });
      m.bridge = bridge;
      conn.on('signal', (msg) => { if (msg?.from) void bridge.onSignal(msg.from, msg.data); });
      this.#syncAudio(m);
      this.log('audio_on', { room: m.room });
    } catch (e) { this.log('audio_off', { room: m.room, error: String(e?.message || e) }); }
  }

  /** Keep a meeting's audio mesh in step with who is in the room: connect to new tabs, drop the ones that left. */
  #syncAudio(m) {
    if (!m?.bridge) return;
    const here = new Set(this.roster.tabsInRoom(m.room).map((t) => t.id));
    for (const id of here) if (!m.bridge.peers.has(id)) void m.bridge.peerEntered(id);
    for (const id of [...m.bridge.peers.keys()]) if (!here.has(id)) m.bridge.peerLeft(id);
  }

  #guestByName(room, name) { return this.roster.peopleInRoom(room).find((p) => p.name === name)?.guest; }

  /** One utterance heard in a room (from chat or feedAudio). Records it, answers if addressed in full voice, and
   *  wraps up on "Mia, wrap it up". */
  #heard(room, { speaker, guest = false, text }) {
    const m = this.meetings.get(room);
    const clean_ = clean(text, 2000);
    if (!m || !clean_) return;
    m.utterances.push({ at: this.now(), speaker: clean(speaker, 80) || 'Someone', guest: !!guest, text: clean_ });
    if (!m.participants.has(speaker) && speaker !== this.name) m.participants.set(speaker, { name: speaker, guest: !!guest });
    if (isWrapCommand(clean_, this.name)) { void this.wrapUp(room, 'asked'); return; }
    if (this.settings.voice === 'full' && isAddressedTo(clean_, this.name)) void this.#answer(m, clean_);
  }

  async #answer(m, text) {
    if (!this.reply) return;
    let line; try { line = await this.reply(text, { room: m.room }); } catch { line = null; }
    line = clean(line, 1000);
    if (!line) return;
    // In full voice with a live call mesh, Mia SPEAKS the reply (TTS → outbound audio). Otherwise she answers as chat.
    if (m.bridge?.talk) { await m.bridge.speak(line).catch(() => {}); return; }
    if (!m.conn.closed) m.conn.send({ t: 'chat', text: line });
  }

  /** On-Mac STT path: hand it audio for one speaker and it transcribes (lib/voice.mjs) and records the line. The audio
   *  never leaves the Mac. Wire this to a WebRTC remote track's PCM when a Node WebRTC stack is present. */
  async feedAudio(room, speaker, samples) {
    const m = this.meetings.get(room);
    if (!this.transcriber || !m) return;
    const prompt = buildVocabPrompt(this.vocab, [...m.participants.keys(), ...(m.crmVocab || []), speaker]);
    let text = ''; try { text = await this.transcriber(samples, { speaker, prompt }); } catch { text = ''; }
    if (text) this.#heard(room, { speaker, text });
  }

  /** File the notes and proposed tasks, then leave the room. Returns the meeting_propose result, or null. */
  async wrapUp(room, reason = 'empty') {
    const m = this.meetings.get(room);
    if (!m) return null;
    this.meetings.delete(room);
    this.calledRooms.delete(room);
    if (m.bridge) { try { await m.bridge.stop(); } catch { /* closing */ } } // stop decoding; any buffered speech is flushed first
    if (m.pending.length) await Promise.allSettled(m.pending); // let in-flight transcriptions (incl. the final flush) land
    const endedAt = this.now();
    const participants = [...m.participants.values()];
    const notes = buildNotes(m.utterances, { name: this.name, participants: participants.map((p) => p.name), now: endedAt });
    let result = null;
    try {
      result = await this.mcp.callTool('meeting_propose', {
        room, started_at: m.startedAt, ended_at: endedAt,
        participants: participants.map((p) => ({ name: p.name, guest: !!p.guest })),
        transcript: notes.transcript, synopsis: notes.synopsis, tasks: notes.tasks,
      });
      this.log('proposed', { room, reason, tasks: notes.tasks.length, lines: notes.transcript.length, meeting_id: result?.meeting_id });
    } catch (e) { this.log('propose_error', { room, error: String(e?.message || e) }); }
    try { m.conn.send({ t: 'bye' }); } catch { /* closed */ }
    m.conn.close();
    return result;
  }

  async stop() {
    this.stopped = true;
    for (const room of [...this.meetings.keys()]) await this.wrapUp(room, 'shutdown');
    this.home?.close();
  }
}

/**
 * The add-on entry (ronin.addon/1 entry.export). Kingmaker's loadAddons() calls this with the host — the add-on's ONLY
 * link to core, so nothing here imports core by path (it uses this module's own pure exports plus host.services). It
 * registers the `floor` command; running it docks to the configured CRM (env RONIN_CRM_MCP_URL / RONIN_CRM_MCP_TOKEN,
 * nothing by default) and takes notes, using the host's transcriber (whisper), speaker (TTS) and turn (reply words).
 */
export async function register(host) {
  host.log?.('meeting_notes_ready', { version: host?.version, api: host?.apiVersion });
  const svc = host?.services || {};
  let active = null;
  const start = async () => {
    if (active) return `${active.name} is already on the floor`;
    const cfg = resolveParticipantConfig({ env: process.env });
    if (!cfg.mcpUrl || !cfg.token) return 'No CRM configured — set RONIN_CRM_MCP_URL and RONIN_CRM_MCP_TOKEN.';
    // Talk-back audio: the host's speaker if it gives one, else this add-on's own (lib/floor-audio-webrtc.mjs) over the
    // host's Kokoro synthesis; with neither the participant still takes notes, it just can't speak.
    const speaker = svc.speaker || await import('./floor-audio-webrtc.mjs')
      .then((m) => m.makeSpeaker({ synthesizeKokoroWav: svc.synthesize || null })).catch(() => null);
    const p = new MeetingParticipant({
      mcp: crmMcpClient({ url: cfg.mcpUrl, token: cfg.token }), name: cfg.name,
      wsBase: `${crmOrigin(cfg.mcpUrl)}/api/office/ws`,
      transcriber: svc.transcriber || null, speaker, reply: svc.turn || null,
      vocab: svc.vocab || '', vocabProvider: svc.vocabProvider || null,
      log: (e, d) => host.log?.(e, d),
    });
    if (!(await p.start())) return 'could not get onto the floor (switched off, bad token, or the CRM is unreachable)';
    active = p; return `${cfg.name} is on the floor`;
  };
  const stop = async () => { if (active) { await active.stop(); active = null; } return 'left the floor'; };
  host.command?.('floor', async (argv = []) => (String(argv[0] || '') === 'stop' ? stop() : start()));
  return { start, stop };
}

/** Build an STT transcriber from lib/voice.mjs for the participant: transcriber(samples,{speaker,prompt}) → text, on the
 *  Mac. A per-call `prompt` (the meeting's own vocabulary) overrides the base one, so names resolve the way they're spelt. */
export function makeTranscriber({ transcribe, whisper, model, language = 'auto', prompt = '' } = {}) {
  if (!transcribe || !whisper || !model) return null;
  return async (samples, opts = {}) => transcribe(samples, { whisper, model, language, prompt: opts.prompt || prompt });
}

/** The owner-vocabulary whisper prompt for a meeting: the base vocab plus the people and names heard in THIS room
 *  (the roster's members, the CRM's merchants/contacts), so whisper spells "Ericka", "Pizza Studio", "Taco la Lomita"
 *  the way the owner does. Pure: deduped case-insensitively, order preserved, length-bounded. */
export function buildVocabPrompt(base, names = []) {
  const seen = new Set(); const parts = [];
  for (const raw of [clean(base, 400), ...(Array.isArray(names) ? names : [])]) {
    const s = clean(raw, 80); const k = s.toLowerCase();
    if (!s || seen.has(k)) continue; seen.add(k); parts.push(s);
  }
  return clean(parts.join(', '), 900);
}

/** Int16 PCM samples from a 16-bit mono WAV buffer (the inverse of lib/voice.mjs wavBytes). For a spoken-audio fixture
 *  or any decoded WebRTC/mic audio handed to feedAudio(). Pure; throws on a non-PCM-16 or non-mono WAV. */
export function wavToSamples(buffer) {
  const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (b.length < 44 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WAVE') throw new Error('not a WAV');
  let off = 12; let fmt = null; let data = null;
  while (off + 8 <= b.length) {
    const id = b.toString('latin1', off, off + 4); const size = b.readUInt32LE(off + 4); const body = off + 8;
    if (id === 'fmt ') fmt = { audioFormat: b.readUInt16LE(body), channels: b.readUInt16LE(body + 2), sampleRate: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) };
    else if (id === 'data') data = { start: body, size: Math.min(size, b.length - body) };
    off = body + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('WAV missing fmt/data');
  if (fmt.audioFormat !== 1 || fmt.bits !== 16 || fmt.channels !== 1) throw new Error(`need 16-bit mono PCM (got format ${fmt.audioFormat}, ${fmt.bits}-bit, ${fmt.channels}ch)`);
  const n = data.size >> 1; const out = new Int16Array(n);
  for (let i = 0; i < n; i += 1) out[i] = b.readInt16LE(data.start + i * 2);
  return out;
}
