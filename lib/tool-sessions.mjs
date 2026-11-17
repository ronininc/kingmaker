// lib/tool-sessions.mjs — Kingmaker's tool sessions: the state behind the lightweight per-tool reporting panel
// (2026-11-16). One session per tool Kingmaker starts. Each session reports, truthfully:
//   state     starting → running → completed | failed | cancelled | cancel-failed (never "done" until the process exited
//             and its exit was observed; never "dormant" until the process is verified gone)
//   activity  the latest meaningful output line (blank and progress-only lines skipped)
//   progress  a percentage ONLY when the tool's own output carries measurable progress (a parser per tool: Blender
//             "Sample n/N" / "Rendered n/N Tiles", generic "n/N" or "NN%"); otherwise null — never invented
//   output    every line, ordered, stream-tagged, secrets redacted (expandable in the panel)
// Input: send(id, text) writes to the tool's stdin only for sessions started interactive; otherwise it is refused.
// Cancel/dismiss: the panel goes away at once; Kingmaker requests cancellation (SIGTERM, then SIGKILL after a grace
// period) of the process TREE it started (lib/kill-tree.mjs killTree: group + every descendant by ppid, mapped before
// the first signal), then verifies every one of those pids is gone. Files are kept. Sessions the user started
// outside Kingmaker are never in this registry, so they can't be touched. A process that will not die is reported
// 'cancel-failed' with the pid, and the user is notified.
// Tools are resolved through the user's selected-tool registry (lib/tool-runner.mjs) — same allowlist, no shell,
// scrubbed environment; consequential runs still go through the caller's approval (the method lane's plan-first gate).
import { spawn, execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { redact } from './tool-runner.mjs';
import { killTree, pidAlive } from './kill-tree.mjs';

/**
 * TRUE PROGRESS (2026-11-16, panels follow-up). A reading is what the TOOL itself printed, never a timer:
 *   { kind: 'percent', done: 0–100, total: 100 }       "45%"
 *   { kind: 'steps',   done, total }                    "3/10", "frame 3 of 10", Blender "Sample 8/32", "Rendered 2/8 Tiles"
 *   { kind: 'bytes',   done, total | null }             "12.5 MB / 40 MB", "1048576 of 4194304 bytes", "downloaded 12 MB"
 * A bytes reading without a total stays INDETERMINATE (no percentage); so does anything malformed (done > total, total 0).
 */
const UNIT = { b: 1, byte: 1, bytes: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 2 ** 10, mib: 2 ** 20, gib: 2 ** 30, tib: 2 ** 40 };
const BYTES_OF = /(\d+(?:\.\d+)?)\s*(B|bytes?|[KMGT]i?B)?\s*(?:\/|of)\s*(\d+(?:\.\d+)?)\s*(B|bytes?|[KMGT]i?B)\b/i;
const BYTES_ONLY = /\b(\d+(?:\.\d+)?)\s*(bytes?|[KMGT]i?B)\b/i;
const toBytes = (n, u) => Math.round(Number(n) * (UNIT[String(u ?? 'b').toLowerCase()] ?? NaN));
function readSteps(line) {
  const m = /Sample (\d+)\/(\d+)/.exec(line) || /Rendered (\d+)\/(\d+) Tiles/.exec(line) || /\b(\d+)\s*\/\s*(\d+)\b/.exec(line) || /\b(?:step|frame|file|item|task|part|chunk|page)s?\s+(\d+)\s+of\s+(\d+)\b/i.exec(line);
  return m ? { kind: 'steps', done: Number(m[1]), total: Number(m[2]) } : null;
}
export const PROGRESS_READERS = Object.freeze({
  blender: (line) => { const m = /Sample (\d+)\/(\d+)/.exec(line) || /Rendered (\d+)\/(\d+) Tiles/.exec(line); return m ? { kind: 'steps', done: Number(m[1]), total: Number(m[2]) } : null; },
  generic: (line) => {
    const s = String(line ?? '');
    const b = BYTES_OF.exec(s);
    if (b && (b[2] || b[4])) { const total = toBytes(b[3], b[4]); return { kind: 'bytes', done: toBytes(b[1], b[2] ?? b[4]), total }; }
    const p = /(^|\s)(\d{1,3}(?:\.\d+)?)%(\s|$)/.exec(s); if (p && Number(p[2]) <= 100) return { kind: 'percent', done: Number(p[2]), total: 100 };
    const st = readSteps(s); if (st) return st;
    const o = BYTES_ONLY.exec(s); if (o && /\b(download|upload|copied|copying|written|wrote|read|received|sent|transferred)/i.test(s)) return { kind: 'bytes', done: toBytes(o[1], o[2]), total: null };
    return null;
  },
  none: () => null,
});
/** A reading → a whole percentage, or null when the real total is unknown or the reading is not coherent. */
export function readingPercent(r) {
  if (!r || !Number.isFinite(r.done) || r.done < 0 || !Number.isFinite(r.total) || r.total <= 0 || r.done > r.total) return null;
  return Math.round((r.done / r.total) * 100);
}
/** A tool's own phase line ("phase: encoding", "stage 2: linking", "[phase] upload"), or null. */
export function readPhase(line) {
  const m = /^\s*(?:\[(?:phase|stage)\]\s*|(?:phase|stage)(?:\s+\d+)?\s*[:=-]\s*)(.{1,80}?)\s*$/i.exec(String(line ?? ''));
  return m ? m[1] : null;
}
/** The panel's progress fields from the last real reading: `indeterminate` is true while a run is live and no real
 *  total is known (the panel then shows activity, not a bar); a final state is never indeterminate. */
export function progressFields(reading, state) {
  const pct = readingPercent(reading);
  const live = !['unverified', 'completed', 'failed', 'cancelled', 'cancel-failed'].includes(state);
  return {
    steps: reading?.kind === 'steps' ? { done: reading.done, total: reading.total } : null,
    bytes: reading?.kind === 'bytes' ? { done: reading.done, total: reading.total ?? null } : null,
    indeterminate: live && pct == null,
  };
}
/** Backward-compatible number parsers (the method lane passes PROGRESS_PARSERS.generic(line) as `progress`). */
export const PROGRESS_PARSERS = Object.freeze({
  blender: (line) => readingPercent(PROGRESS_READERS.blender(line)),
  generic: (line) => readingPercent(PROGRESS_READERS.generic(line)),
  none: () => null,
});

export function createToolSessions({ registry, emit = () => {}, graceMs = 2000, now = () => Date.now() } = {}) {
  const sessions = new Map();
  const events = new EventEmitter();
  let seq = 0;
  const FINAL = ['completed', 'failed', 'cancelled', 'cancel-failed'];
  const view = (s) => ({ id: s.id, interactive: s.interactive, tool: s.tool, label: s.label, state: s.state, activity: s.activity, progress: s.progress, ...progressFields(s.reading, s.state), phase: s.phase, exitCode: s.exitCode, signal: s.signal, startedAt: s.startedAt, endedAt: s.endedAt, lines: s.lines.length, visible: s.visible, cwd: s.cwd, note: s.note ?? null, ...(s.tree ? { tree: s.tree } : {}) });
  const publish = (s, kind) => { const v = view(s); emit({ toolPanel: { kind, ...v } }); events.emit('update', kind, v); };
  const alive = pidAlive;

  function start({ tool, args = [], cwd, label = null, progress = 'generic', interactive = false }) {
    const entry = registry?.tools?.[tool];
    if (!entry?.path) throw new Error(`TOOL_NOT_SELECTED: "${tool}" is not one of the tools you selected for Kingmaker`);
    const id = `t${++seq}`;
    const s = { id, tool, label: label ?? `${tool} ${args.join(' ')}`.slice(0, 80), state: 'starting', activity: 'starting', progress: null, reading: null, phase: null, exitCode: null, signal: null, startedAt: now(), endedAt: null, lines: [], visible: true, cwd, interactive, child: null, reader: PROGRESS_READERS[progress] ?? PROGRESS_READERS.generic, cancelRequested: false };
    sessions.set(id, s);
    const child = spawn(entry.path, args, { cwd, shell: false, detached: true, stdio: [interactive ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin', LANG: 'C', LC_ALL: 'C', HOME: process.env.HOME ?? cwd, TMPDIR: cwd } });
    s.child = child; s.pid = child.pid;
    const t0 = performance.now();
    const take = (stream) => { let buf = ''; return (chunk) => {
      buf += chunk.toString('utf8');
      let i; while ((i = buf.search(/[\r\n]/)) >= 0) {
        const line = redact(buf.slice(0, i)); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        s.lines.push({ ms: Math.round(performance.now() - t0), stream, line });
        // Progress only from the tool's own reading; the last reading stays until the tool reports again (no timer).
        const r = s.reader(line), ph = readPhase(line);
        if (r) { s.reading = r; s.progress = readingPercent(r); } else if (ph) { s.phase = ph; s.activity = line.slice(0, 160); } else s.activity = line.slice(0, 160);
        if (s.state === 'starting') s.state = 'running';
        publish(s, 'output');
      }
    }; };
    child.stdout.on('data', take('stdout')); child.stderr.on('data', take('stderr'));
    child.on('spawn', () => { s.state = 'running'; s.activity = s.activity === 'starting' ? 'running' : s.activity; publish(s, 'state'); });
    child.on('error', (e) => { if (FINAL.includes(s.state)) return; s.state = 'failed'; s.activity = `could not start: ${e.message}`; s.endedAt = now(); publish(s, 'state'); });
    // The ONLY place a session completes: the process's own exit, observed. Exit 0 → completed; anything else → failed;
    // a cancel in progress → cancelled (dismiss() then verifies the tree). The last real reading is kept as is — a
    // completed run is not dressed up as "100%" unless the tool itself said so.
    child.on('close', (code, signal) => {
      s.exitCode = code; s.signal = signal; s.endedAt = now();
      if (FINAL.includes(s.state)) { publish(s, 'state'); return; }
      // A cancel in progress is finalized by dismiss() only after EVERY pid of the tree is verified gone.
      if (s.cancelRequested) { publish(s, 'exited'); return; }
      s.state = code === 0 ? 'completed' : 'failed';
      publish(s, 'state');
    });
    publish(s, 'started');
    return view(s);
  }

  /** Route typed or spoken input to ONE tool. Refused unless that session was started interactive and is running. */
  function send(id, text) {
    const s = sessions.get(id);
    if (!s) return { ok: false, reason: 'no such tool session' };
    if (!s.interactive || s.state !== 'running') return { ok: false, reason: `${s.tool} is not accepting input (${s.interactive ? s.state : 'not interactive'})` };
    s.child.stdin.write(`${text}\n`); s.lines.push({ ms: null, stream: 'input', line: redact(text) }); publish(s, 'input');
    return { ok: true };
  }

  /** "I'm done with <tool>": hide the panel now; cancel what Kingmaker started; verify; report. */
  async function dismiss(id) {
    const s = sessions.get(id); if (!s) return { ok: false, reason: 'no such tool session' };
    s.visible = false; publish(s, 'dismissed');
    if (['completed', 'failed', 'cancelled'].includes(s.state)) return { ok: true, state: s.state, verifiedGone: !alive(s.pid) };
    s.cancelRequested = true; s.activity = 'stopping — waiting for the processes to exit';
    // killTree maps the WHOLE tree (group + descendants by ppid) before the first signal, so a setsid/double-forked
    // grandchild is still found; every pid it returns must be verified gone, not just the root.
    const tree = killTree(s.pid, { signal: 'SIGTERM' });
    const left = () => tree.filter((p) => alive(p));
    const waitGone = async (ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (!left().length) return true; await new Promise((r) => setTimeout(r, 50)); } return !left().length; };
    let gone = await waitGone(graceMs);
    if (!gone) {
      s.note = `did not stop on SIGTERM within ${graceMs} ms; sent SIGKILL`;
      for (const p of left()) { if (p === s.pid) killTree(p, { signal: 'SIGKILL' }); else { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } } }
      gone = await waitGone(graceMs);
    }
    s.tree = { pids: tree, stillAlive: left() };
    if (!gone) { s.state = 'cancel-failed'; s.note = `pid(s) ${s.tree.stillAlive.join(', ')} still running after SIGKILL — not dormant; Kingmaker will keep trying and tells you`; publish(s, 'cancel-failed'); return { ok: false, state: s.state, pid: s.pid, pids: tree, stillAlive: s.tree.stillAlive }; }
    await new Promise((r) => setImmediate(r));
    if (s.state === 'running' || s.state === 'starting') { s.state = 'cancelled'; s.endedAt = now(); publish(s, 'state'); }
    return { ok: true, state: s.state, verifiedGone: true, pids: tree, note: s.note ?? null };
  }

  const wait = (id) => new Promise((resolve) => { const s = sessions.get(id); if (s && ['completed', 'failed', 'cancelled', 'cancel-failed'].includes(s.state)) return resolve(view(s)); const on = (kind, v) => { if (v.id === id && ['completed', 'failed', 'cancelled', 'cancel-failed'].includes(v.state)) { events.off('update', on); resolve(v); } }; events.on('update', on); });
  return { start, send, dismiss, wait, get: (id) => { const s = sessions.get(id); return s ? { ...view(s), output: s.lines } : null; }, list: () => [...sessions.values()].map(view), events };
}

/** How a panel reads its progress, in words (the same words the native bar draws). */
export function progressLabel(v) {
  const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;
  if (v.steps && Number.isFinite(v.steps.total)) return `${v.steps.done}/${v.steps.total}${v.progress != null ? ` · ${v.progress}%` : ''}`;
  if (v.bytes) return v.bytes.total != null ? `${mb(v.bytes.done)} of ${mb(v.bytes.total)}${v.progress != null ? ` · ${v.progress}%` : ''}` : `${mb(v.bytes.done)} so far (total not reported)`;
  if (v.progress != null) return `${v.progress}%`;
  return v.indeterminate ? 'working — the tool reports no total' : '';
}

/** The panel, rendered from session views with the user's bar settings (look black|glass|system, accent = reply colour,
 *  text size, font, reduce motion). Progress: a determinate bar only from a real reading; an indeterminate run gets an
 *  indeterminate bar — or, with Reduce Motion on, static words instead of an animation. */
export function renderToolPanels(views, { look = 'black', accent = '#4f9cff', textSize = 13, font = '-apple-system, BlinkMacSystemFont, sans-serif', reduceMotion = false } = {}) {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // black: the bar's own black; glass: the bar's dark appearance (system colours in a dark scheme); system: the Mac's.
  const scheme = look === 'system' ? '' : 'color-scheme:dark;';
  const bg = look === 'black' ? '#000' : 'Canvas', fg = look === 'black' ? '#eaeaea' : 'CanvasText';
  const badge = { running: accent, starting: accent, completed: '#3fb950', unverified: '#FFBF4D', failed: '#f85149', cancelled: '#8b949e', 'cancel-failed': '#f85149' };
  const bar = (v) => {
    const words = esc(progressLabel(v));
    if (v.progress != null) return ` <progress value="${v.progress}" max="100" style="accent-color:${accent}"></progress> <span>${words}</span>`;
    if (v.indeterminate) return reduceMotion ? ` <span data-indeterminate>${words}</span>` : ` <progress data-indeterminate style="accent-color:${accent}"></progress> <span>${words}</span>`;
    return words ? ` <span>${words}</span>` : '';
  };
  return `<div class="km-tools" style="${scheme}font:${textSize}px ${esc(font)};background:${bg};color:${fg}${reduceMotion ? ';animation:none;transition:none' : ''}">${views.filter((v) => v.visible !== false).map((v) => `
<section class="km-tool" data-id="${esc(v.id)}" data-state="${esc(v.state)}"><header><b>${esc(v.tool)}</b> <span style="color:${badge[v.state] ?? fg}">${esc(v.state)}</span>${bar(v)}</header>
${v.phase ? `<div class="phase">${esc(v.phase)}</div>` : ''}<div class="activity">${esc(v.activity)}</div><details><summary>output (${Number(v.lines) || (v.tail?.length ?? 0)} lines)</summary><pre data-output="${esc(v.id)}"></pre></details></section>`).join('')}</div>`;
}

/** The bar's CURRENT settings, read-only from its preferences (app/Kingmaker.swift "Customize": km.look black|glass|system,
 *  km.replyColor, km.textSize; km.position is where the bar opens — the panels are drawn inside the bar's log, so they
 *  follow it) plus the Mac's Reduce Motion (com.apple.universalaccess reduceMotion, the same switch the bar's glow
 *  honours via NSWorkspace.accessibilityDisplayShouldReduceMotion). Same colour values the bar uses. */
export function barThemeFromDefaults({ domain = 'com.ronininc.solghost', read = null } = {}) {
  const get = read ?? ((key, dom = domain) => { try { return execFileSync('defaults', ['read', dom, key], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } });
  const colours = { white: '#FFFFFF', blue: '#73B8FF', amber: '#FFBF4D', green: '#4ADE80' };
  const lookRaw = get('km.look', domain) ?? 'black';
  const look = ['black', 'glass', 'system'].includes(lookRaw) ? lookRaw : 'black';
  const reply = get('km.replyColor', domain) ?? 'green';
  const size = Number(get('km.textSize', domain)) || 14;
  const position = get('km.position', domain) ?? 'top';
  const rm = get('reduceMotion', 'com.apple.universalaccess');
  const reduceMotion = rm === '1' || rm === 'true' || rm === 'YES';
  return { look, accent: colours[reply] ?? colours.green, textSize: size, position, reduceMotion, font: '-apple-system, BlinkMacSystemFont, sans-serif', source: `defaults ${domain} (km.look=${look}, km.replyColor=${reply}, km.textSize=${size}, km.position=${position}) + com.apple.universalaccess reduceMotion=${reduceMotion}` };
}

/** Route one typed/spoken instruction to the right active tool: the tool named in it ("tell blender to …"), else the
 *  only interactive running session. Ambiguity is refused, never guessed. */
export function routeInput(sessions, text) {
  const active = sessions.list().filter((v) => v.state === 'running');
  const named = active.filter((v) => new RegExp(`\\b${v.tool.replace(/[^\w]/g, '')}\\b`, 'i').test(text));
  const target = named.length === 1 ? named[0] : named.length > 1 ? null : (() => { const inter = active.filter((v) => v.interactive === true); return inter.length === 1 ? inter[0] : null; })();
  if (!target) return { ok: false, reason: named.length > 1 ? `more than one ${named[0].tool} is running — say which one` : active.length ? 'more than one tool could take that — name the tool' : 'no tool is running' };
  const body = String(text).replace(new RegExp(`^\\s*(tell|ask)\\s+${target.tool}\\s+(to\\s+)?`, 'i'), '').trim();
  return { ...sessions.send(target.id, body), routedTo: target.id, tool: target.tool, text: body };
}

/**
 * THE PANEL CHANNEL (2026-11-16): the one place a lane's panel events are normalized before they reach a renderer
 * (the native bar reads them as `@@ghost {"toolPanel": …}` lines on the engine's stdout — the existing bridge;
 * renderToolPanels draws the same views as HTML). Honest by construction:
 *   · states: running → unverified | completed | failed | cancelled (| cancel-failed). A final state is FINAL: any later
 *     event for that id is dropped, so a run that was cancelled can never be shown "completed" afterwards;
 *   · progress: only a number the TOOL reported (0–100, from its own output), kept until it reports again; null otherwise —
 *     never invented, never advanced by time, and not forced to 100 on completion;
 *   · tail: the tool's last few real output lines (redacted by the runner), not a summary.
 * emit(view) receives the plain view; the caller wraps it for its transport.
 */
export const PANEL_STATES = Object.freeze(['running', 'unverified', 'completed', 'failed', 'cancelled', 'cancel-failed']);
export const PANEL_FINAL = Object.freeze(['unverified', 'completed', 'failed', 'cancelled', 'cancel-failed']);
export function createPanelChannel({ emit = () => {}, now = () => Date.now(), tail = 3, reader = PROGRESS_READERS.generic } = {}) {
  const panels = new Map();
  let seq = 0;
  const reading = (x, kind) => (x && Number.isFinite(Number(x.done)) ? { kind, done: Number(x.done), total: x.total == null ? null : Number(x.total) } : null);
  /**
   * update(id, fields). Progress inputs, best first: `steps` {done,total} or `bytes` {done,total|null} from the JOB's own
   * events (a lane that knows "step 2 of 5"); else a reading of `line` (the tool's own output); else a tool-reported
   * `progress` number. With none of those the last real reading stays. `phase`: the job's current phase name.
   */
  function update(id, { tool, state, activity, line, progress, steps, bytes, phase } = {}) {
    const prev = panels.get(id);
    if (prev && PANEL_FINAL.includes(prev.state)) return { ok: false, reason: `panel ${id} is already ${prev.state}` };
    const next = state ?? prev?.state ?? 'running';
    if (!PANEL_STATES.includes(next)) return { ok: false, reason: `unknown panel state ${next}` };
    const v = prev ? { ...prev, tail: [...prev.tail] } : { schema: 'kingmaker.tool-panel/1', id: String(id), tool: String(tool ?? 'tool'), state: next, activity: '', phase: null, progress: null, reading: null, tail: [], startedAt: now(), endedAt: null };
    if (tool) v.tool = String(tool);
    v.state = next;
    if (typeof line === 'string' && line.trim()) { v.tail.push(line.slice(0, 300)); if (v.tail.length > tail) v.tail.splice(0, v.tail.length - tail); v.activity = line.slice(0, 160); }
    if (typeof activity === 'string' && activity) v.activity = activity.slice(0, 200);
    if (typeof phase === 'string' && phase.trim()) v.phase = phase.trim().slice(0, 80);
    const r = reading(steps, 'steps') ?? reading(bytes, 'bytes') ?? (typeof line === 'string' ? reader(line) : null)
      ?? (Number.isFinite(progress) && progress >= 0 && progress <= 100 ? { kind: 'percent', done: progress, total: 100 } : null);
    if (r && (readingPercent(r) != null || (r.kind === 'bytes' && r.total == null && r.done >= 0))) { v.reading = r; v.progress = readingPercent(r); }
    if (PANEL_FINAL.includes(next)) v.endedAt = now();
    Object.assign(v, progressFields(v.reading, next));
    v.seq = ++seq;
    panels.set(id, v);
    const { reading: _r, ...out } = v;
    emit({ ...out, tail: [...v.tail] });
    return { ok: true, view: out };
  }
  return { update, get: (id) => { const v = panels.get(id); if (!v) return null; const { reading: _r, ...out } = v; return out; }, list: () => [...panels.values()].map(({ reading: _r, ...out }) => out) };
}
