// SELF-CHECK SEES VOICE AND THE MAC'S PERMISSIONS.
//
// The engine's self-assessment ("what's broken?") reports its voice and macOS-permission layers UNREPORTED unless a
// desktop health snapshot reached it (the desktop app posts one
// from its main process). Kingmaker posts the same DesktopHealthSnapshot to the same endpoint
// (POST /api/health/self-assessment, {desktop, report: false}: the server only caches the layers) from the owner
// process, with the launch nonce. What it reports is what Kingmaker actually observed:
//   voice        its own voice loop (listening / off / failed), live turns tallied from the voice-turn ledger
//   microphone   the real capture: real audio arrived → granted; only digital silence → denied (what macOS hands a
//                process without the grant); the capture tool missing or dying first → unavailable
//   accessibility / screen   the hands' own report: Peekaboo's (`peekaboo permissions status --json`, its Bridge
//                holds the grants) or ghost-os's (`ghost status`), whichever process actually drives apps
//
// WHEN: at start and whenever one of those changes (events, never a timer). The server keeps a posted layer for
// 90 s, so before each owner turn a snapshot older than SNAPSHOT_STALE_MS is posted again (a turn, the moment a
// self-check can be asked for, is the event), and after a core restart (its cache died with it) it is re-posted.
// Read-only telemetry: every error is swallowed and nothing here can affect a turn.

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Re-post before a turn when the last post is older than this (the server's layer TTL is 90 s). */
export const SNAPSHOT_STALE_MS = 60_000;
/** Real audio needed before a capture of nothing but zeros counts as "no microphone grant". */
export const MIC_SILENCE_DENIED_MS = 3_000;

/** Pure: `ghost status` → {accessibility, screen} in the window app's vocabulary. */
export function parseGhostStatus(text) {
  const read = (label) => {
    const m = new RegExp(`^\\s*${label}\\s*:\\s*(.+)$`, 'im').exec(String(text ?? ''));
    if (!m) return null;
    const v = m[1].trim().toLowerCase();
    if (/^granted\b|^yes\b|^ok\b|✓/.test(v)) return 'granted';
    if (/not granted|denied|missing|no\b|✗/.test(v)) return 'not_granted';
    return null;
  };
  const accessibility = read('Accessibility');
  const screen = read('Screen Recording');
  return { accessibility: accessibility ?? 'unknown', screen: screen === 'not_granted' ? 'denied' : (screen ?? 'unknown') };
}

/** ghost-os's own permission report. No ghost-os → accessibility 'unavailable' (nothing can drive apps). */
export function ghostPermissions(ghostBin, { exec = execFile, timeoutMs = 8_000 } = {}) {
  if (!ghostBin) return Promise.resolve({ accessibility: 'unavailable', screen: 'unknown' });
  return new Promise((resolve) => {
    exec(ghostBin, ['status'], { timeout: timeoutMs, encoding: 'utf8' }, (error, stdout) => {
      resolve(error && !stdout ? { accessibility: 'unknown', screen: 'unknown' } : parseGhostStatus(String(stdout ?? '')));
    });
  });
}

/** Pure: `peekaboo permissions status --json` → {accessibility, screen} in the window app's vocabulary. */
export function parsePeekabooPermissions(text) {
  let rows = [];
  try {
    const j = JSON.parse(String(text ?? ''));
    rows = Array.isArray(j?.data?.permissions) ? j.data.permissions : Array.isArray(j?.permissions) ? j.permissions : [];
  } catch { return { accessibility: 'unknown', screen: 'unknown' }; }
  const granted = (name) => {
    const row = rows.find((r) => String(r?.name ?? '').toLowerCase() === name);
    return !row || typeof row.isGranted !== 'boolean' ? null : row.isGranted;
  };
  const ax = granted('accessibility');
  const screen = granted('screen recording');
  return { accessibility: ax === null ? 'unknown' : ax ? 'granted' : 'not_granted', screen: screen === null ? 'unknown' : screen ? 'granted' : 'denied' };
}

/** Peekaboo's own permission report (its Bridge holds the grants). No binary → 'unavailable'. */
export function peekabooPermissions(peekabooBin, { exec = execFile, timeoutMs = 8_000 } = {}) {
  if (!peekabooBin) return Promise.resolve({ accessibility: 'unavailable', screen: 'unknown' });
  return new Promise((resolve) => {
    exec(peekabooBin, ['permissions', 'status', '--json'], { timeout: timeoutMs, encoding: 'utf8' }, (error, stdout) => {
      resolve(error && !stdout ? { accessibility: 'unknown', screen: 'unknown' } : parsePeekabooPermissions(String(stdout ?? '')));
    });
  });
}

/** The selected hands' permission report: whichever process actually drives apps. */
export function handsPermissions({ kind, ghostBin = null, peekabooBin = null }, opts = {}) {
  return kind === 'peekaboo' ? peekabooPermissions(peekabooBin, opts) : ghostPermissions(kind === 'ghost' ? ghostBin : null, opts);
}

/** Peekaboo's version and MCP tool count from its own CLI (`--version`, `tools --json`); nulls when unreadable. */
export function peekabooInfo(peekabooBin, { exec = execFile, timeoutMs = 8_000 } = {}) {
  if (!peekabooBin) return Promise.resolve({ version: null, toolCount: null });
  const run = (args) => new Promise((resolve) => {
    exec(peekabooBin, args, { timeout: timeoutMs, encoding: 'utf8' }, (error, stdout) => resolve(error && !stdout ? '' : String(stdout ?? '')));
  });
  return Promise.all([run(['--version']), run(['tools', '--json'])]).then(([v, t]) => {
    let toolCount = null;
    try { const j = JSON.parse(t); const n = Number(j?.data?.count ?? j?.count ?? (Array.isArray(j?.data?.tools) ? j.data.tools.length : NaN)); toolCount = Number.isFinite(n) ? n : null; } catch { /* unreadable */ }
    return { version: (/(\d+\.\d+\.\d+)/.exec(v) ?? [])[1] ?? null, toolCount };
  });
}

/**
 * The microphone's real state from what the capture delivers. Pure: push(level, ms) per chunk (chunkLevel), then
 * exited() if the capture tool stops. onChange(state) fires once per transition.
 */
export function createMicProbe({ onChange = () => {}, silentMsForDenied = MIC_SILENCE_DENIED_MS } = {}) {
  let state = 'unknown';
  let silentMs = 0;
  const set = (next) => { if (next !== state) { state = next; try { onChange(next); } catch { /* observation only */ } } };
  return {
    get state() { return state; },
    push(level, ms) {
      if (level > 0) { silentMs = 0; set('granted'); return; }
      silentMs += ms;
      if (state !== 'granted' && silentMs >= silentMsForDenied) set('denied');
    },
    exited() { if (state === 'unknown') set('unavailable'); },
    unavailable() { set('unavailable'); },
  };
}

/** The foundation manifest a built runtime ships (Resources/foundation-capabilities.json), in the window app's shape. */
export function readFoundation(file, read = (p) => readFileSync(p, 'utf8')) {
  try {
    const m = JSON.parse(read(file));
    if (!Array.isArray(m?.capabilities)) return null;
    return m.capabilities.map((c) => ({ id: c.id, label: c.label, proof: String(c.proof ?? 'MANIFEST'), wired: !!c.wired, packaged: !!c.packaged, ...(typeof c.present === 'boolean' ? { present: c.present } : {}) }));
  } catch { return null; }
}

/**
 * Pure: the DesktopHealthSnapshot. `voice`: 'off' (not asked for, or the ring closed) | 'starting' | 'listening' |
 * 'failed' (asked for, could not start). `mic`: createMicProbe's state. `tally`: readVoiceTurnTally.
 */
export function buildHealthSnapshot({ voice = 'off', mic = 'unknown', accessibility = 'unknown', screen = 'unknown', tally = null, foundation = null }) {
  const micBroken = mic === 'denied' || mic === 'unavailable';
  const runtimePipeline = voice === 'listening' ? (micBroken ? 'DEGRADED' : 'READY')
    : voice === 'starting' ? 'STARTING'
      : voice === 'failed' ? 'DEGRADED' : 'UNWIRED';
  const liveCompleted = Number(tally?.completed) || 0;
  const liveFailed = Number(tally?.failed) || 0;
  const flags = ['sol-ghost-snapshot'];
  if (mic === 'denied') flags.push('mic-silent-capture');
  return {
    voice: { runtimePipeline, armed: runtimePipeline === 'READY', physicalConversation: liveCompleted > 0 ? 'PROVEN' : 'NOT_TESTED', liveCompleted, liveFailed, flags },
    permissions: { microphone: mic, accessibility, screen },
    ...(Array.isArray(foundation) && foundation.length ? { foundation } : {}),
  };
}

/** Pure: a key-order-independent signature (desktop-snapshot-schedule.mjs snapshotSignature). */
export function snapshotSignature(snapshot) {
  const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
  return JSON.stringify(canon(snapshot ?? null));
}

/**
 * Holds what Kingmaker observed and posts the snapshot when it changes. update(partial) and noteTurn() are the
 * events; refresh() is called before a turn (posts only when stale); repost() after a core restart. A post in
 * flight absorbs further changes into ONE follow-up post. `post(desktop, {timeoutMs})` → truthy when accepted.
 */
export function createHealthReporter({ post, tally = () => null, foundation = () => null, now = Date.now, log = () => {} }) {
  const observed = { voice: 'off', mic: 'unknown', accessibility: 'unknown', screen: 'unknown' };
  let lastSignature = null;
  let lastPostedAt = 0;
  let lastOk = false;
  let inFlight = null;
  let again = false;

  const snapshot = () => buildHealthSnapshot({ ...observed, tally: safe(tally), foundation: safe(foundation) });

  async function send({ force = false, timeoutMs = 10_000 } = {}) {
    if (inFlight) { again = true; return inFlight; }
    const desktop = snapshot();
    const signature = snapshotSignature(desktop);
    if (!force && lastOk && signature === lastSignature) return true;
    inFlight = (async () => {
      let ok = false;
      try { ok = Boolean(await post(desktop, { timeoutMs })); } catch { ok = false; }
      lastSignature = signature; lastPostedAt = now(); lastOk = ok;
      log('health_snapshot', { ok, voice: desktop.voice.runtimePipeline, mic: desktop.permissions.microphone, accessibility: desktop.permissions.accessibility, live: desktop.voice.liveCompleted });
      return ok;
    })();
    try { return await inFlight; } finally {
      inFlight = null;
      if (again) { again = false; void send(); }
    }
  }

  return {
    get observed() { return { ...observed }; },
    snapshot,
    /** A state change: merge it and post if the snapshot changed. */
    update(partial = {}) {
      let changed = false;
      for (const [k, v] of Object.entries(partial)) if (k in observed && typeof v === 'string' && observed[k] !== v) { observed[k] = v; changed = true; }
      // The first observation always posts: that is the "at start" snapshot.
      return changed || !lastPostedAt ? send() : Promise.resolve(lastOk);
    },
    /** A voice turn was recorded: the tally moved. */
    noteTurn: () => send(),
    /** Before a turn: keep the server's 90 s layers fresh, quickly, only when they are about to lapse. */
    refresh() { return now() - lastPostedAt >= SNAPSHOT_STALE_MS || !lastOk ? send({ force: true, timeoutMs: 2_000 }) : Promise.resolve(true); },
    /** The core restarted: its cache is empty. */
    repost: () => send({ force: true }),
  };
}

function safe(fn) { try { return fn(); } catch { return null; } }
