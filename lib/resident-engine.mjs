// lib/resident-engine.mjs — the engine as a RESIDENT: started once, answered by name, reused by
// every later launch, and stopped on purpose — never re-spawned per session and never left as a
// mystery process holding the port.
//
// Before this module, residency was an accident of the app staying open: the launcher process
// started the engine in-process (lib/runtime.mjs startBackend), the daemon state file recorded it
// (writeDaemonState), and anything else that came along treated "an engine is already running" as
// a blocker to refuse on (startBlockers: "Another headless engine … Stop it first"). The cold-start
// cost was paid again whenever the hosting process restarted, and no code path could answer the
// simple questions: is it up? is it OURS? is it ANSWERING yet?
//
// This module is that path, built on the pieces that already exist:
//   probe   the daemon state file (runtime.mjs) + pid liveness (paths.mjs pidAlive) + the engine's
//           own /api/health route (client.mjs health) as the readiness endpoint. A pid that is
//           alive but not answering is 'starting', never 'ready' — a reused engine must be a
//           WORKING engine, or the reuse is a slower failure than the cold start was. An engine
//           whose launcher died but which still answers is 'orphaned': adoptable by a new launch
//           (the state file names its pid — the same trust basis cmdStop signals on), never
//           confused with 'foreign' (an answerer no state file vouches for).
//   ensure  ready → reuse it, return at probe speed (this is the cold-start win for every launch
//           after the first). starting → wait for it, bounded. foreign (something answers on the
//           port that this launcher did not start) → refuse: one port, one engine, and never kill
//           what cannot be proved ours. down → start it once, record the daemon state, supervise it
//           (the caller passes startBackend + superviseBackend in; crash policy stays theirs).
//   stop    the intentional stop, with wait-for-exit semantics: SIGTERM, a bounded grace, SIGKILL
//           only if the grace lapses, and the daemon state cleared only once the process is gone —
//           a stop that returns while the engine still lives is not a stop. The supervisor's
//           intentional-stop path (superviseBackend.stop) never respawns after it, and cmdStop's
//           "only signal a process that is really Kingmaker" check stays the caller's, injected
//           here as `verify`.

import { health } from './client.mjs';
import { pidAlive } from './paths.mjs';
import { clearDaemonState, readDaemonState, writeDaemonState } from './runtime.mjs';

const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Is a resident engine up, ours, and answering? One probe, four honest answers:
 *   ready    daemon state names a live launcher pid AND /api/health answers ok — a full session
 *            is already running; a new launch refuses (its blockers say so), it does not attach.
 *   starting a live pid is recorded but health does not answer yet (booting, or wedged).
 *   orphaned the recorded launcher is gone, but the engine it started (state.backendPid) still
 *            answers — it outlived its launch and a new launch may ADOPT it instead of paying a
 *            second cold start or refusing on the port it holds.
 *   foreign  something answers /api/health on the port that no daemon state vouches for — not
 *            ours to reuse or to stop.
 *   down     no live engine: no state, a stale state (pid gone, nothing answering), or silence.
 */
export async function probeResidentEngine({ paths, port, readState = readDaemonState, alive = pidAlive, healthCheck = null, timeoutMs = 1_500, now = Date.now } = {}) {
  const check = healthCheck ?? ((p) => health(p, { timeoutMs }).catch(() => null));
  const state = readState(paths);
  const pid = Number(state?.pid) || null;
  if (pid && alive(pid)) {
    const h = await check(port);
    if (h?.ok) {
      const startedAt = state.startedAt ?? null;
      const uptimeMs = startedAt ? Math.max(0, now() - Date.parse(startedAt)) : null;
      return { state: 'ready', pid, backendPid: state.backendPid ?? null, port: state.port ?? port, startedAt, uptimeMs };
    }
    return { state: 'starting', pid, backendPid: state?.backendPid ?? null, port: state?.port ?? port, reason: 'the recorded pid is alive but /api/health does not answer' };
  }
  if (pid) {
    // The recorded launcher is gone. Its engine may have outlived it: if the port still answers
    // and the state names the engine's pid, the engine is an adoptable orphan. An answerer the
    // state cannot name is foreign; silence is just a stale state.
    const h = await check(port);
    if (h?.ok && state.backendPid) return { state: 'orphaned', pid, backendPid: state.backendPid, port: state.port ?? port, reason: 'the launcher is gone but its engine still answers — adoptable' };
    if (h?.ok) return { state: 'foreign', port, reason: 'an engine answers on the port but the stale state names no engine pid — not this launcher\'s to reuse' };
    return { state: 'down', pid, reason: 'stale daemon state (the recorded pid is gone)' };
  }
  const h = await check(port);
  if (h?.ok) return { state: 'foreign', port, reason: 'an engine answers on the port but no daemon state names it — not this launcher\'s to reuse' };
  return { state: 'down', reason: 'no daemon state and nothing answering on the port' };
}

/**
 * Ensure a resident engine: reuse the ready one, wait for the starting one, refuse the foreign
 * one, start the absent one — once.
 *   start()      the caller's launch (startBackend with their paths/port/secrets) →
 *                { backend, daemonState? }; daemonState, when returned, is written via writeState.
 *   supervise()  the caller's crash supervision for a fresh backend (superviseBackend); the
 *                returned supervisor replaces the backend as the handle to stop.
 * → { reused: true, resident } | { reused: true, adopted: true, resident }
 *   | { reused: false, backend, supervisor, resident }
 *   | { refused: true, reason, resident }
 */
export async function ensureResidentEngine({
  paths, port, start, supervise = null,
  probe = probeResidentEngine, writeState = writeDaemonState,
  attachWaitMs = 60_000, pollMs = 250, sleep = sleepDefault, log = () => {},
} = {}) {
  if (typeof start !== 'function') throw new Error('resident-engine: start() is required (the caller owns the launch)');
  const found = await probe({ paths, port });
  if (found.state === 'ready') {
    log('resident_reused', { pid: found.pid, port: found.port, uptimeMs: found.uptimeMs });
    return { reused: true, resident: found };
  }
  if (found.state === 'foreign') return { refused: true, reason: found.reason, resident: found };
  if (found.state === 'orphaned') {
    // Adoption: the caller builds its own handle around the surviving engine (it owns the shape
    // its session wiring needs); ensure's part is the verdict — this engine is ours and working.
    log('resident_adopted', { pid: found.pid, backendPid: found.backendPid, port: found.port });
    return { reused: true, adopted: true, resident: found };
  }
  if (found.state === 'starting') {
    // Alive but not answering: give it the bounded wait a boot deserves, then believe the probe.
    const deadline = Date.now() + attachWaitMs;
    let current = found;
    while (Date.now() < deadline) {
      await sleep(pollMs);
      current = await probe({ paths, port });
      if (current.state === 'ready') {
        log('resident_reused', { pid: current.pid, port: current.port, waited: true });
        return { reused: true, resident: current };
      }
      if (current.state !== 'starting') break;
    }
    return { refused: true, reason: `the resident engine (pid ${found.pid}) is alive but did not answer within ${attachWaitMs} ms — it is wedged or still booting; refusing to start a second one on its port`, resident: current };
  }
  // down: the one cold start. Everything after this is reuse.
  const { backend, daemonState } = await start();
  if (daemonState) writeState(paths, daemonState);
  const supervisor = supervise ? supervise(backend) : null;
  log('resident_started', { backendPid: backend?.child?.pid ?? null, port });
  return { reused: false, backend, supervisor, resident: { state: 'started', port, backendPid: backend?.child?.pid ?? null } };
}

/**
 * Stop the resident engine on purpose, and mean it: SIGTERM first (the engine's own shutdown —
 * the hosting process undocks, closes its streams, and exits), a bounded grace for it to finish,
 * SIGKILL only past the grace, and the daemon state cleared once the process is actually gone.
 * `verify(pid)` is the caller's proof the pid is Kingmaker (cmdStop's ps check); an unverified pid
 * is never signalled — the stale state is cleared and the refusal reported instead.
 * → { stopped, pid, escalated?, reason? }
 */
export async function stopResidentEngine({
  paths, readState = readDaemonState, clearState = clearDaemonState, alive = pidAlive,
  kill = (pid, signal) => process.kill(pid, signal), verify = null,
  graceMs = 20_000, forceWaitMs = 5_000, pollMs = 100, sleep = sleepDefault,
} = {}) {
  const state = readState(paths);
  const pid = Number(state?.pid) || null;
  if (!pid) return { stopped: false, pid: null, reason: 'no daemon state — nothing recorded as running' };
  if (!alive(pid)) { clearState(paths); return { stopped: true, pid, reason: 'the recorded pid was already gone; stale state cleared' }; }
  if (verify && !(await verify(pid))) {
    clearState(paths);
    return { stopped: false, pid, reason: `pid ${pid} is not Kingmaker; not signalled, stale state cleared` };
  }
  const waitGone = async (budgetMs) => {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      if (!alive(pid)) return true;
      await sleep(pollMs);
    }
    return !alive(pid);
  };
  kill(pid, 'SIGTERM');
  if (await waitGone(graceMs)) { clearState(paths); return { stopped: true, pid, escalated: false }; }
  kill(pid, 'SIGKILL');
  if (await waitGone(forceWaitMs)) { clearState(paths); return { stopped: true, pid, escalated: true }; }
  return { stopped: false, pid, escalated: true, reason: `pid ${pid} survived SIGTERM and SIGKILL — state left in place for the owner to see` };
}
