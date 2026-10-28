// Start and stop Kingmaker's windowless engine: the runtime's own headless-server.mjs, run by the
// runtime's own binary as Node — this Kingmaker.app's bundled runtime, or (from a git checkout) the
// installed Solomon.app's. No Electron window, renderer, or GPU process is ever created.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { forkBackendLaunch } from './fork.mjs';
import { desktopAppPid, findGhostBinary, findPeekabooBinary, findUserOllama, headlessHolder } from './paths.mjs';
import { ghostBackendEnv } from './profile.mjs';
import { craftBackendEnv } from './artcraft.mjs';
import { ronin } from './addons.mjs';
import { startSolomonHeartbeat } from './solomon-heartbeat.mjs';

/** A paid add-on's say in the engine's environment: the Ronin add-on's CRM lock and seats (lib/addons.mjs). */
const addonBackend = (paths) => (ronin ? { crmLock: ronin.activeCrmLock(paths), addon: ronin } : {});

export const DEFAULT_PORT = 3001;
const READY_LINE = /Solomon runtime listening on/;

export function portFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
}

/** Reasons Kingmaker must not start, in plain words. Empty when it may. */
export async function startBlockers(paths, port, { exists = existsSync, desktopPid = desktopAppPid, otherHeadless = headlessHolder, isPortFree = portFree } = {}) {
  const out = [];
  if (paths.runtimeSource === 'fork') {
    if (!paths.forkInstalled) out.push(`The engine's server dependencies are not installed. Run: npm ci --prefix ${paths.fork.root}/server`);
  } else if (!exists(paths.binary)) {
    out.push(paths.runtimeSource === 'bundle'
      ? `This Kingmaker.app is missing its runtime (${paths.binary}). Rebuild it with the engine build.`
      : `No engine to run: this checkout has no engine source and there is no runtime at ${paths.app}. Install Kingmaker.app with Kingmaker Installer, which carries the engine.`);
  } else if (!exists(paths.headlessEntry)) {
    out.push(`This engine build has no headless launcher (${paths.headlessEntry}). Rebuild it from the engine's current source.`);
  }
  const pid = desktopPid(paths);
  if (pid) out.push(`The desktop app is running (pid ${pid}) on the data folder Kingmaker was told to share. Quit it first: one data folder, one engine.`);
  const other = otherHeadless(paths);
  if (other) out.push(`Another headless engine (${other.launcher}, pid ${other.pid}) is running on ${paths.runtimeHome}. Stop it first (kingmaker stop).`);
  if (!(await isPortFree(port))) out.push(`Port ${port} is already in use (another engine or Kingmaker).`);
  return out;
}

/**
 * The fork's server runs under THIS process's binary. Under plain node, ELECTRON_RUN_AS_NODE means nothing and
 * is dropped. Under an Electron binary (Solomon.app's, used as Node) it must stay 1: without it the binary opens
 * the full desktop app, whose launcher reclaims any other backend on its port as an "orphan" and kills it
 * (it took down a live Kingmaker on :3001, 2026-10-07). Pure.
 */
export function forkChildEnv(backendEnv, versions = process.versions) {
  const env = { ...backendEnv };
  if (versions?.electron) env.ELECTRON_RUN_AS_NODE = '1';
  else delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

/** Crash logs kept beside server.log (server-crash-<time>.log), newest first. */
export const CRASH_LOGS_KEPT = 5;

/** Keep what a crashed core printed: server.log → server-crash-<time>.log, pruned to the newest CRASH_LOGS_KEPT. */
export function keepCrashLog(logs, { at = new Date(), fs = { existsSync, renameSync, readdirSync, rmSync } } = {}) {
  const logPath = join(logs, 'server.log');
  if (!fs.existsSync(logPath)) return null;
  const kept = join(logs, `server-crash-${at.toISOString().replace(/[:.]/g, '-')}.log`);
  try { fs.renameSync(logPath, kept); } catch { return null; }
  try {
    const old = fs.readdirSync(logs).filter((n) => /^server-crash-.*\.log$/.test(n)).sort().reverse().slice(CRASH_LOGS_KEPT);
    for (const name of old) fs.rmSync(join(logs, name), { force: true });
  } catch { /* pruning is housekeeping only */ }
  return kept;
}

/**
 * THE VAULT KEY. A packaged engine never makes its own credentials-vault key (it fails closed: every key save would
 * be refused), so Kingmaker makes it once, beside the seal key the core already keeps there: 32 random bytes, hex,
 * 0600 in <secure root>/keys, created exclusively (an existing key is never replaced; a vault sealed under it stays
 * readable). Skipped when SOLOMON_VAULT_KEY is given. → 'created' | 'present' | 'env' | 'failed'
 */
export function ensureVaultKey(secureRoot, { env = process.env, log = () => {} } = {}) {
  if (String(env.SOLOMON_VAULT_KEY ?? '').trim()) return 'env';
  const dir = join(secureRoot, 'keys');
  const file = join(dir, 'credentials-vault.key');
  if (existsSync(file)) return 'present';
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, randomBytes(32).toString('hex'), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    log('vault_key', { created: true });
    return 'created';
  } catch (error) {
    if (error?.code === 'EEXIST') return 'present';
    log('vault_key', { created: false, error: String(error?.code || error?.message || error).slice(0, 60) });
    return 'failed';
  }
}

export async function startBackend({ paths, port, secrets, env = process.env, log = () => {}, installedModels = [], afterCrash = false }) {
  mkdirSync(paths.logs, { recursive: true, mode: 0o700 });
  const logPath = join(paths.logs, 'server.log');
  // After a crash the old log is what the core printed before it died: keep it under its own name.
  const crashLog = afterCrash ? keepCrashLog(paths.logs) : null;
  if (!crashLog && existsSync(logPath)) { try { renameSync(logPath, join(paths.logs, 'server.prev.log')); } catch { /* keep going */ } }
  const sink = createWriteStream(logPath, { flags: 'a', mode: 0o600 });
  const ghostBin = findGhostBinary(env);
  const peekabooBin = findPeekabooBinary(env);
  const ollamaBin = findUserOllama(env);
  let child;
  let backendEnv;
  if (paths.runtimeSource === 'fork') {
    // The engine's server from source, under this Node, with the headless launcher's own environment and the
    // runtime home as its working directory (its data folder is cwd/data, as in the packaged app).
    mkdirSync(paths.runtimeHome, { recursive: true, mode: 0o700 });
    const launch = await forkBackendLaunch({ env, runtimeHome: paths.runtimeHome, resources: paths.resources, port });
    backendEnv = forkChildEnv(ghostBackendEnv({ env: launch.env, paths, port, secrets, ghostBin, peekabooBin, installedModels, artcraftEnv: craftBackendEnv(paths, launch.env), ollamaBin, ...addonBackend(paths) }));
    child = spawn(process.execPath, launch.args, { cwd: paths.runtimeHome, env: backendEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  } else {
    backendEnv = ghostBackendEnv({ env, paths, port, secrets, ghostBin, peekabooBin, installedModels, artcraftEnv: craftBackendEnv(paths, env), ollamaBin, ...addonBackend(paths) });
    if (backendEnv.SOLOMON_SECURE_ROOT) ensureVaultKey(backendEnv.SOLOMON_SECURE_ROOT, { env: backendEnv, log });
    child = spawn(paths.binary, [paths.headlessEntry], { cwd: paths.state, env: backendEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  }

  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const bootTimer = setTimeout(() => readyReject(new Error(`no "listening" line within 240 s — see ${logPath}`)), 240_000);
  let tail = '';
  const onData = (chunk) => {
    sink.write(chunk);
    tail = (tail + chunk.toString('utf8')).slice(-4096);
    if (READY_LINE.test(tail)) { clearTimeout(bootTimer); readyResolve(); }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => {
    clearTimeout(bootTimer);
    readyReject(new Error(`backend exited during boot (code ${code}, signal ${signal}) — see ${logPath}`));
    sink.end();
    resolve({ code, signal });
  }));
  ready.catch(() => {});
  log('backend_spawned', { pid: child.pid, port, ghost: Boolean(ghostBin), hands: String(backendEnv.SOLOMON_MAC_HANDS ?? '') === 'peekaboo' ? 'peekaboo' : ghostBin ? 'ghost' : 'none', logPath });

  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return exited;
    child.kill('SIGTERM');
    const force = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 20_000);
    const result = await exited;
    clearTimeout(force);
    return result;
  };
  return { child, ready, exited, stop, logPath, crashLog, ghostBin, peekabooBin, backendEnv };
}

// ── CRASH RESPAWN ─────────────────────────────────────────────────────────────
// The desktop app's policy (its planBackendRespawn), for the core Kingmaker starts with no
// window. Once the first launch is up (ready, with its rules checked), a core that dies unexpectedly is
// started again with bounded backoff: 1 s, 3 s, 9 s; at most 3 respawns within 60 s; a core that stayed up
// 5 min earns a fresh budget. Past that, respawning stops and Kingmaker says so once. A crash DURING the first
// launch is a boot failure, reported as before (it would only repeat). An intentional stop (kingmaker stop,
// :quit, the app quitting) is never respawned. The respawn reuses this launch's secrets, so the owner console,
// voice and every event stream carry on against the new core unchanged.
export const BACKEND_RESPAWN_DELAYS_MS = Object.freeze([1_000, 3_000, 9_000]);

/** Pure: the next step after a crash at `now`. (The desktop app's planBackendRespawn, same numbers.) */
export function planBackendRespawn(previousCrashTimes, now, { healthySince = 0, windowMs = 60_000, healthyResetMs = 300_000 } = {}) {
  const earnedFreshBudget = healthySince > 0 && now - healthySince >= healthyResetMs;
  const recent = earnedFreshBudget ? [] : previousCrashTimes.filter((at) => now - at < windowMs);
  const crashTimes = [...recent, now];
  if (crashTimes.length > BACKEND_RESPAWN_DELAYS_MS.length) return { respawn: false, crashTimes, crashes: crashTimes.length };
  return { respawn: true, delayMs: BACKEND_RESPAWN_DELAYS_MS[crashTimes.length - 1], crashTimes, crashes: crashTimes.length };
}

const childGone = (child) => !child || child.exitCode !== null || child.signalCode !== null;

/**
 * Supervise a backend that has reached ready. `relaunch()` starts a new one (startBackend with afterCrash).
 * `verify(backend)` re-checks the respawned core's rules (fail closed: a core that comes back without them is
 * stopped and not respawned). Events through onEvent(name, detail):
 *   restarting {code, signal, delayMs, crashes}  · respawned {backend}  · recovered {backend}
 *   respawn_not_ready {message}                  · gave_up {reason, code?, signal?}
 * stop() is the intentional stop: no respawn follows it, and a pending respawn is cancelled.
 *
 * `heartbeat`, when set, is the CRM pulse for this same supervisor (lib/solomon-heartbeat.mjs).
 * It is not a second process. It probes http://127.0.0.1:3301 every 60 s and stays silent
 * unless Solomon answers — the child pid being alive is not a beat.
 */
export function superviseBackend(first, {
  relaunch, onEvent = () => {}, isPortFree = async () => true, verify = async () => true,
  now = Date.now, schedule = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; }, cancel = clearTimeout,
  heartbeat = null,
}) {
  let current = first;
  let crashTimes = [];
  let healthySince = now();
  let stopping = false;
  let gaveUp = false;
  let timer = null;
  const emit = (name, detail = {}) => { try { onEvent(name, detail); } catch { /* reporting never breaks supervision */ } };
  const giveUp = (reason, detail = {}) => { if (gaveUp) return; gaveUp = true; emit('gave_up', { reason, ...detail }); };

  const watch = (backend) => {
    backend.exited.then(({ code, signal } = {}) => {
      if (stopping || gaveUp || backend !== current) return;
      const plan = planBackendRespawn(crashTimes, now(), { healthySince });
      crashTimes = plan.crashTimes;
      healthySince = 0;
      if (!plan.respawn) { giveUp(`it stopped ${plan.crashes} times within a minute`, { code, signal, crashes: plan.crashes }); return; }
      emit('restarting', { code, signal, delayMs: plan.delayMs, crashes: plan.crashes });
      timer = schedule(() => { timer = null; void respawn(); }, plan.delayMs);
    });
  };

  async function respawn() {
    if (stopping || gaveUp) return;
    // A hung remnant of the crashed core can still hold the port; never kill what cannot be proved ours.
    if (!(await isPortFree().catch(() => false))) { giveUp('its port is held by another process'); return; }
    let next;
    try { next = await relaunch(); } catch (error) { giveUp(`it could not be restarted: ${String(error?.message ?? error).slice(0, 200)}`); return; }
    if (stopping) { await next.stop(); return; }
    current = next;
    watch(next);
    emit('respawned', { backend: next });
    try {
      await next.ready;
    } catch (error) {
      // A boot that never says "listening" is ended; its exit plans the next attempt (or gives up).
      if (!childGone(next.child)) { try { next.child.kill('SIGKILL'); } catch { /* gone */ } }
      emit('respawn_not_ready', { message: String(error?.message ?? error).slice(0, 200) });
      return;
    }
    if (stopping || next !== current) return;
    if (!(await Promise.resolve(verify(next)).catch(() => false))) {
      giveUp('it came back without its rules (principal enforcement), so it was stopped');
      await next.stop();
      return;
    }
    healthySince = now();
    emit('recovered', { backend: next });
  }

  watch(first);
  // Same supervisor, same stop. The pulse never treats "this process is up" as Solomon.
  const pulse = heartbeat ? startSolomonHeartbeat({ schedule, cancel, ...heartbeat }) : null;
  return {
    get current() { return current; },
    get gaveUp() { return gaveUp; },
    async stop() {
      stopping = true;
      pulse?.stop();
      if (timer) { cancel(timer); timer = null; }
      return current.stop();
    },
  };
}

export function writeDaemonState(paths, state) {
  mkdirSync(dirname(paths.stateFile), { recursive: true, mode: 0o700 });
  writeFileSync(paths.stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
}

export function readDaemonState(paths) {
  try { return JSON.parse(readFileSync(paths.stateFile, 'utf8')); } catch { return null; }
}

export function clearDaemonState(paths) {
  try { rmSync(paths.stateFile, { force: true }); } catch { /* fine */ }
}
