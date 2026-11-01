// lib/idle-gaps.mjs — while the owner is away, Kingmaker works on its own capability gaps (the owner, 2026-10-15: "this
// version should seek to auto close its ok capability gaps while idle"). A gap is something asked for that no lane could
// do ("No lane handled that yet — I've noted it as a capability gap"); the engine keeps them (/api/capability-acquisition/gaps).
// After 10 minutes with no turn and nothing being said, at most once an hour, Kingmaker asks its engine to scan them
// (POST /gaps/scan): each gap over its threshold becomes a risk-classed proposal, and the ones the engine's own rules allow
// start being acquired. The engine decides what is OK (a web search only under the owner's standing permission), and turning
// a new capability ON stays the owner's tap, every time. The bar gets one written note when something moved; nothing is
// spoken, and nothing at all when there was nothing to do.

export const IDLE_MS = 10 * 60_000;
export const SCAN_EVERY_MS = 60 * 60_000;
export const GAPS_SCAN_ROUTE = '/api/capability-acquisition/gaps/scan';

/** Pure: is it time to scan? Idle long enough, not mid-turn or speaking, and not scanned within the hour. */
export function shouldScan({ now, lastActivity, lastScan = null, busy = false, idleMs = IDLE_MS, everyMs = SCAN_EVERY_MS }) {
  return !busy && now - lastActivity >= idleMs && (lastScan == null || now - lastScan >= everyMs);
}

/** Pure: the bar's note for one scan's answer, or null when nothing moved. */
export function scanLine(json) {
  const outcomes = Array.isArray(json?.outcomes) ? json.outcomes : [];
  if (!outcomes.length) return null;
  const started = outcomes.filter((o) => o?.acquisitionStarted).length;
  const proposed = outcomes.filter((o) => o?.proposal && !o?.acquisitionStarted).length;
  const skipped = outcomes.filter((o) => o?.skippedReason).length;
  if (!started && !proposed) return null;
  const names = outcomes.filter((o) => o?.acquisitionStarted || o?.proposal).map((o) => String(o?.gap?.capabilityKey || o?.gap?.capability || '').replace(/[_-]+/g, ' ').trim()).filter(Boolean).slice(0, 4);
  const parts = [];
  if (started) parts.push(`${started} being built now`);
  if (proposed) parts.push(`${proposed} proposed for your OK`);
  return `While you were away I worked on ${started + proposed} capability gap${started + proposed === 1 ? '' : 's'}${names.length ? ` (${names.join(', ')})` : ''}: ${parts.join(', ')}${skipped ? `; ${skipped} left alone` : ''}. Each one only turns on when you say so.`;
}

/**
 * The idle loop. scan() → the route's {ok, json}; note(line) shows a line in the bar; busy() → true mid-turn or speaking.
 * touch() on every turn the owner starts. start() checks once a minute; stop() ends it.
 */
// timing() → { on, idleMs, everyMs } (Customize → Close capability gaps while idle), read on every check.
export function createIdleGaps({ scan, note, busy = () => false, log = () => {}, now = Date.now, every = 60_000, timing = () => ({ on: true }), setIntervalImpl = setInterval, clearIntervalImpl = clearInterval }) {
  let lastActivity = now();
  let lastScan = null;
  let running = false;
  let timer = null;
  const tick = async () => {
    const tm = timing() || {};
    if (running || tm.on === false || !shouldScan({ now: now(), lastActivity, lastScan, busy: busy(), idleMs: tm.idleMs, everyMs: tm.everyMs })) return false;
    running = true; lastScan = now();
    try {
      const r = await scan();
      const line = r?.ok ? scanLine(r.json) : null;
      log('idle_gaps', { ok: Boolean(r?.ok), outcomes: Array.isArray(r?.json?.outcomes) ? r.json.outcomes.length : 0, status: r?.status ?? null });
      if (line) await note(line);
      return true;
    } catch (e) { log('idle_gaps', { ok: false, error: String(e?.message || e).slice(0, 160) }); return true; }
    finally { running = false; }
  };
  return {
    touch() { lastActivity = now(); },
    tick,
    start() { if (!timer) { timer = setIntervalImpl(() => { void tick(); }, every); timer?.unref?.(); } },
    stop() { if (timer) { clearIntervalImpl(timer); timer = null; } },
  };
}
