// What Kingmaker says on its own, from the server's event streams (never polled). Pure.
//
//   Background tasks  ANSWER FAST, DELIVER LATER: a heavy lane (codegen, a decision, a poster, a model trial)
//                     answers the turn at once and finishes on the server. When it finishes, the operator hears
//                     its readyLine once ("It's ready — …", or an honest "did not finish"), exactly as the desktop
//                     app's main process does (its background-task watch over the same
//                     stream). Only tasks that finish after Ghost started listening
//                     are announced; a reconnect's snapshot recovers a finish missed while the core restarted.
//   Capability asks   The feature watch raises an ask ("<Vendor> launched X; want me to build it?"). Ghost
//                     claims the spoken line with POST /api/feature-watch/announced (the server marks the ask
//                     announced and returns the line, so exactly one surface ever says it) and speaks it once.
//                     The operator answers by voice in a normal turn; the server makes the decision. Nothing
//                     here approves anything.

/** The window app's bounds: at most this many finished-task ids are remembered. */
const ANNOUNCED_MAX = 500;
/** One finished task's line, as the server wrote it, capped like the desktop's queue. */
const LINE_MAX = 600;

/**
 * Lines to speak from the background-task stream. `armedAtMs`: tasks that finished before Ghost was listening
 * are already done with; they are not announced. Each task id is announced at most once.
 */
export function createTaskAnnouncer({ tenantId = 'primary', armedAtMs = Date.now() } = {}) {
  let announced = new Set();
  return {
    /** One SSE frame of /api/tasks/events → [{id, line}] to say now. */
    linesFor({ type, data } = {}) {
      if (!data || data.tenantId !== tenantId) return [];
      const tasks = type === 'tasks.snapshot' ? data.tasks : type === 'task.changed' ? [data.task] : [];
      if (!Array.isArray(tasks)) return [];
      const out = [];
      for (const task of tasks) {
        if (!task || task.tenantId !== tenantId || typeof task.id !== 'string') continue;
        if (task.status !== 'done' && task.status !== 'failed') continue;
        const line = String(task.readyLine ?? '').replace(/\s+/g, ' ').trim().slice(0, LINE_MAX);
        const id = task.id.slice(0, 120);
        if (!line || announced.has(id)) continue;
        const finishedAt = Date.parse(String(task.finishedAt ?? ''));
        if (Number.isFinite(finishedAt) && finishedAt < armedAtMs - 1_000) continue;
        announced.add(id);
        if (announced.size > ANNOUNCED_MAX) announced = new Set([...announced].slice(-200));
        out.push({ id, line });
      }
      return out;
    },
    get armedAtMs() { return armedAtMs; },
  };
}

const ASK_ID = /^sol_fwa_[a-z0-9]{1,16}_[0-9a-f]{8,32}$/;

/**
 * The asks in a feature-watch snapshot that still need their line said (PENDING, never announced), minus
 * the ones this run already tried to claim. None when the owner turned the spoken line off (voiceLine
 * false): Ghost then leaves them unclaimed for a screen to show.
 */
export function asksToAnnounce(snapshot, tried = new Set()) {
  if (!snapshot || typeof snapshot !== 'object' || snapshot.voiceLine === false) return [];
  const pending = Array.isArray(snapshot.pending) ? snapshot.pending : [];
  return pending
    .filter((a) => a && a.state === 'PENDING' && a.announced !== true && ASK_ID.test(String(a.askId ?? '')) && !tried.has(a.askId))
    .map((a) => a.askId);
}

/** The one line the claim returned, or '' (another surface claimed it, or the line is off). */
export function claimedLine(response) {
  const line = response?.json?.data?.line;
  return typeof line === 'string' ? line.replace(/\s+/g, ' ').trim().slice(0, LINE_MAX) : '';
}

/**
 * Keep one event stream open: reconnect when it ends or drops (a core restart), with backoff; stop for good
 * when the server refuses it (401/403: not this caller's to read). A lost connection is the only trigger; the
 * stream itself is the event source, nothing is polled. Resolves 'stopped' | 'refused'.
 */
export async function followStream({ name, open, signal, log = () => {}, backoffMs = [1_000, 2_000, 5_000, 15_000, 60_000], sleep = abortableSleep }) {
  let attempt = 0;
  while (!signal?.aborted) {
    try {
      await open({ onOpen: () => { attempt = 0; log(`${name}_live`, {}); } });
      log(`${name}_ended`, {});
    } catch (error) {
      if (signal?.aborted) break;
      const status = Number(error?.status) || null;
      if (status === 401 || status === 403) { log(`${name}_refused`, { status }); return 'refused'; }
      log(`${name}_dropped`, { status, message: String(error?.message ?? error).slice(0, 160) });
      if (status === 404) attempt = backoffMs.length - 1; // not in this build: look again rarely
    }
    if (signal?.aborted) break;
    await sleep(backoffMs[Math.min(attempt, backoffMs.length - 1)], signal);
    attempt += 1;
  }
  return 'stopped';
}

function abortableSleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    timer.unref?.();
    function done() { clearTimeout(timer); signal?.removeEventListener?.('abort', done); resolve(); }
    signal?.addEventListener?.('abort', done, { once: true });
  });
}
